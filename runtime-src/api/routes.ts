import type { FastifyInstance } from "fastify";
import * as kuri from "../kuri/client.js";
import type { KuriHarEntry } from "../kuri/client.js";
import { extractEndpoints, extractAuthHeaders } from "../reverse-engineer/index.js";
import { INTERCEPTOR_SCRIPT, collectInterceptedRequests, type RawRequest } from "../capture/index.js";
import { queueBackgroundIndex } from "../indexer/index.js";
import { nanoid } from "nanoid";
import type { SkillManifest } from "../types/index.js";
import { extractBrowserCookies } from "../auth/browser-cookies.js";
import { mergeEndpoints } from "../marketplace/index.js";
import { buildSkillOperationGraph } from "../graph/index.js";
import { augmentEndpointsWithAgent } from "../graph/agent-augment.js";
import { findExistingSkillForDomain, cachePublishedSkill } from "../client/index.js";
import { storeCredential } from "../vault/index.js";
import { generateLocalDescription, writeSkillSnapshot, buildResolveCacheKey, getDomainReuseKey, domainSkillCache, persistDomainCache, scopedCacheKey, snapshotPathForCacheKey, invalidateRouteCacheForDomain } from "../orchestrator/index.js";
import { TRACE_VERSION, CODE_HASH, GIT_SHA } from "../version.js";
import { promoteExplicitExecution, resolveAndExecute } from "../orchestrator/index.js";
import { getSkill } from "../marketplace/index.js";
import { executeSkill } from "../execution/index.js";
import { storeCredential } from "../vault/index.js";
import { interactiveLogin, extractBrowserAuth } from "../auth/index.js";
import { publishSkill } from "../marketplace/index.js";
import { recordFeedback, recordDiagnostics, recordExecution, getApiKey, getRecentLocalSkill } from "../client/index.js";
import { ROUTE_LIMITS } from "../ratelimit/index.js";
import type { ProjectionOptions } from "../types/index.js";
import { getSkillChunk, toAgentSkillChunkView } from "../graph/index.js";
import { listRecentSessionsForDomain } from "../session-logs.js";
import { mergeAgentReview } from "../indexer/index.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const BETA_API_URL = process.env.UNBROWSE_BACKEND_URL || "https://beta-api.unbrowse.ai";

const TRACES_DIR = process.env.TRACES_DIR ?? join(process.cwd(), "traces");


/** Convert Kuri HAR entries to RawRequest format */
function harEntriesToRawRequests(entries: KuriHarEntry[]): RawRequest[] {
  return entries
    .filter(e => e.request && e.response)
    .map(e => ({
      url: e.request.url,
      method: e.request.method,
      request_headers: Object.fromEntries((e.request.headers ?? []).map(h => [h.name.toLowerCase(), h.value])),
      request_body: e.request.postData?.text,
      response_status: e.response.status,
      response_headers: Object.fromEntries((e.response.headers ?? []).map(h => [h.name.toLowerCase(), h.value])),
      response_body: e.response.content?.text,
      timestamp: e.startedDateTime ?? new Date().toISOString(),
    }));
}

/** Process HAR entries into routes and queue for background indexing */
/** Full passive indexing pipeline — same enrichment as explicit capture */
function passiveIndexFromRequests(requests: RawRequest[], pageUrl: string): void {
  if (requests.length === 0) return;

  let domain: string;
  try { domain = new URL(pageUrl).hostname; } catch { return; }
  const intent = `browse ${domain}`;

  // Fire-and-forget — full pipeline runs async
  void (async () => {
    try {
      // 1. Extract endpoints from captured traffic
      const rawEndpoints = extractEndpoints(requests, undefined, { pageUrl, finalUrl: pageUrl });
      if (rawEndpoints.length === 0) {
        console.log(`[passive-index] ${domain}: 0 endpoints from ${requests.length} requests`);
        return;
      }

      // 2. Extract and store auth credentials (cookies + sensitive headers)
      const capturedAuthHeaders = extractAuthHeaders(requests);
      if (Object.keys(capturedAuthHeaders).length > 0) {
        const authKey = `${domain}-session`;
        await storeCredential(authKey, JSON.stringify({ headers: capturedAuthHeaders }));
      }

      // 3. Merge with existing skill for this domain (never reduce endpoint count)
      const existingSkill = findExistingSkillForDomain(domain, intent);
      const mergedEndpoints = existingSkill
        ? mergeEndpoints(existingSkill.endpoints, rawEndpoints)
        : rawEndpoints;
      // Guard: if passive capture found fewer endpoints than what exists, keep the richer set
      if (existingSkill && mergedEndpoints.length < existingSkill.endpoints.length) {
        console.log(`[passive-index] ${domain}: skipping — would reduce ${existingSkill.endpoints.length} → ${mergedEndpoints.length} endpoints`);
        return;
      }

      // 4. Generate descriptions for endpoints without them (enables BM25 ranking)
      for (const ep of mergedEndpoints) {
        if (!ep.description) {
          ep.description = generateLocalDescription(ep);
        }
      }

      // 5. Skip LLM-based augmentation — the calling agent IS the LLM.
      // Endpoint descriptions come from generateLocalDescription (heuristic).
      // The agent reviews endpoints in the deferral response and picks the right one.
      const enrichedEndpoints = mergedEndpoints;

      // 6. Build operation dependency graph
      const operationGraph = buildSkillOperationGraph(enrichedEndpoints);

      // 7. Assemble full skill manifest
      const skill: SkillManifest = {
        skill_id: existingSkill?.skill_id ?? nanoid(),
        version: "1.0.0",
        schema_version: "1",
        lifecycle: "active" as const,
        execution_type: "http" as const,
        created_at: existingSkill?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        name: domain,
        intent_signature: intent,
        domain,
        description: `API skill for ${domain}`,
        owner_type: "agent" as const,
        endpoints: enrichedEndpoints,
        operation_graph: operationGraph,
        intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
      };

      // 8. Cache locally for immediate reuse — write to BOTH the published skill cache
      // AND the domain skill snapshot so resolveAndExecute finds it on next call
      try { cachePublishedSkill(skill); } catch { /* best-effort */ }

      // Write domain skill snapshot (keyed by resolve cache key)
      const bgCacheKey = buildResolveCacheKey(domain, intent, pageUrl);
      const bgScopedKey = scopedCacheKey("global", bgCacheKey);
      writeSkillSnapshot(bgScopedKey, skill);

      // Update domain-level reuse cache
      const bgDomainKey = getDomainReuseKey(pageUrl ?? domain);
      if (bgDomainKey) {
        domainSkillCache.set(bgDomainKey, {
          skillId: skill.skill_id,
          localSkillPath: snapshotPathForCacheKey(bgScopedKey),
          ts: Date.now(),
        });
        persistDomainCache();
      }

      // 9. Queue background index (graph building, validation, marketplace publish)
      const cacheKey = `passive:${domain}:${Date.now()}`;
      queueBackgroundIndex({ skill, domain, intent, contextUrl: pageUrl, cacheKey });

      console.log(`[passive-index] ${domain}: ${enrichedEndpoints.length} endpoints indexed from ${requests.length} requests`);
    } catch (err) {
      console.error(`[passive-index] ${domain} failed: ${err instanceof Error ? err.message : err}`);
    }
  })();
}

/** Convenience wrapper: convert HAR entries and run passive indexing */
function passiveIndexHar(entries: KuriHarEntry[], pageUrl: string): void {
  passiveIndexFromRequests(harEntriesToRawRequests(entries), pageUrl);
}
// ── Browse session state (module-level so orchestrator can register sessions) ──
const browseSessions = new Map<string, { tabId: string; url: string; harActive: boolean; domain: string }>();

/** Register a browse session from the orchestrator (Phase 4 handoff) */
export function registerBrowseSession(tabId: string, url: string, domain: string): void {
  browseSessions.set("default", { tabId, url, harActive: true, domain });
}

// ── /v1/stats cache ──────────────────────────────────────────────────
let statsCache: { data: unknown; ts: number } | null = null;
const STATS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchStats() {
  if (statsCache && Date.now() - statsCache.ts < STATS_CACHE_TTL) {
    return statsCache.data;
  }

  const npmPoint = (pkg: string, range: string) =>
    fetch(`https://api.npmjs.org/downloads/point/${range}/${pkg}`)
      .then(r => r.json() as Promise<{ downloads?: number }>);

  const npmRange = (pkg: string) =>
    fetch(`https://api.npmjs.org/downloads/range/last-month/${pkg}`)
      .then(r => r.json() as Promise<{ downloads?: Array<{ day: string; downloads: number }> }>);

  const externalCalls: Promise<unknown>[] = [
    npmPoint("unbrowse", "last-month"),
    npmPoint("@getfoundry/unbrowse-openclaw", "last-month"),
    npmPoint("unbrowse", "1970-01-01:2099-12-31"),
    npmPoint("@getfoundry/unbrowse-openclaw", "1970-01-01:2099-12-31"),
    npmRange("unbrowse"),
    npmRange("@getfoundry/unbrowse-openclaw"),
    fetch("https://api.github.com/repos/anthropic-ai/unbrowse", {
      headers: { "User-Agent": "unbrowse-stats" },
    }).then(r => r.json() as Promise<Record<string, unknown>>),
  ];

  // Only call Unkey analytics if the key is available as an env var
  const unkeyAnalyticsKey = process.env.UNKEY_ANALYTICS_KEY;
  if (unkeyAnalyticsKey) {
    externalCalls.push(
      fetch("https://api.unkey.com/v2/analytics.getVerifications", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${unkeyAnalyticsKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiId: "api_2bUScBc8U6JNsXLrhfHwfqzXHJDi" }),
      }).then(r => r.json() as Promise<unknown>),
    );
  }

  const [
    unbrowse30d, plugin30d,
    unbrowseAll, pluginAll,
    unbrowseDaily, pluginDaily,
    github,
    ...rest
  ] = await Promise.allSettled(externalCalls);
  const unkey = rest[0]; // may be undefined if no key

  const val = <T>(r: PromiseSettledResult<T> | undefined): T | null =>
    r?.status === "fulfilled" ? r.value : null;

  // npm numbers
  const u30 = val(unbrowse30d)?.downloads ?? null;
  const p30 = val(plugin30d)?.downloads ?? null;
  const uAll = val(unbrowseAll)?.downloads ?? null;
  const pAll = val(pluginAll)?.downloads ?? null;

  // daily breakdown — merge the two packages by day
  const uDays = val(unbrowseDaily)?.downloads ?? [];
  const pDays = val(pluginDaily)?.downloads ?? [];
  const dayMap = new Map<string, { unbrowse: number; plugin: number }>();
  for (const d of uDays) dayMap.set(d.day, { unbrowse: d.downloads, plugin: 0 });
  for (const d of pDays) {
    const entry = dayMap.get(d.day);
    if (entry) entry.plugin = d.downloads;
    else dayMap.set(d.day, { unbrowse: 0, plugin: d.downloads });
  }
  const daily = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, unbrowse: v.unbrowse, plugin: v.plugin, total: v.unbrowse + v.plugin }));

  // github
  const gh = val(github);
  const githubData = gh && typeof gh === "object"
    ? {
        stars: (gh as Record<string, number>).stargazers_count ?? null,
        forks: (gh as Record<string, number>).forks_count ?? null,
        open_issues: (gh as Record<string, number>).open_issues_count ?? null,
        watchers: (gh as Record<string, number>).watchers_count ?? null,
      }
    : { stars: null, forks: null, open_issues: null, watchers: null };

  // unkey
  let agentsData: { total_api_calls_30d: number | null; note?: string } = {
    total_api_calls_30d: null,
    note: "unkey analytics unavailable",
  };
  const uk = val(unkey);
  if (uk && Array.isArray(uk)) {
    const total = (uk as Array<{ total?: number }>).reduce((s, v) => s + (v.total ?? 0), 0);
    agentsData = { total_api_calls_30d: total };
  } else if (uk && typeof uk === "object" && (uk as Record<string, unknown>).total != null) {
    agentsData = { total_api_calls_30d: (uk as Record<string, number>).total };
  }

  const data = {
    npm: {
      unbrowse: { last_30d: u30, all_time: uAll },
      openclaw_plugin: { last_30d: p30, all_time: pAll },
      combined: {
        last_30d: u30 != null && p30 != null ? u30 + p30 : (u30 ?? p30),
        all_time: uAll != null && pAll != null ? uAll + pAll : (uAll ?? pAll),
      },
      daily,
    },
    github: githubData,
    agents: agentsData,
    fetched_at: new Date().toISOString(),
  };

  statsCache = { data, ts: Date.now() };
  return data;
}

export async function registerRoutes(app: FastifyInstance) {
  const clientScopeFor = (req: { headers: Record<string, unknown>; id: string }) =>
    (typeof req.headers["x-unbrowse-client-id"] === "string" && req.headers["x-unbrowse-client-id"].trim())
      ? req.headers["x-unbrowse-client-id"].trim()
      : req.id;

  // Auth gate: block all routes except /health when no API key is configured
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.url === "/v1/stats") return;

    const key = getApiKey();
    if (!key) {
      return reply.code(401).send({
        error: "api_key_required",
        message: "No API key configured. Restart the server to auto-register, or run: bash scripts/setup.sh",
        docs_url: "https://unbrowse.ai",
      });
    }
  });

  // POST /v1/intent/resolve
  app.post("/v1/intent/resolve", { config: { rateLimit: ROUTE_LIMITS["/v1/intent/resolve"] } }, async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { intent, params, context, projection, confirm_unsafe, dry_run, force_capture } = req.body as {
      intent: string;
      params?: Record<string, unknown>;
      context?: { url?: string; domain?: string };
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      dry_run?: boolean;
      force_capture?: boolean;
    };
    if (!intent) return reply.code(400).send({ error: "intent required" });
    try {
      const result = await resolveAndExecute(intent, params ?? {}, context, projection, { confirm_unsafe, dry_run, force_capture, client_scope: clientScope });

      // Surface timing breakdown
      const res = result as unknown as Record<string, unknown>;
      if (result.timing) {
        res.timing = result.timing;
      }

      // If the orchestrator already included available_endpoints in result (deferral),
      // also append them at the top level for backward compatibility.
      const innerResult = result.result as Record<string, unknown> | null;
      if (innerResult?.available_endpoints && !res.available_endpoints) {
        res.available_endpoints = innerResult.available_endpoints;
      }

      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // GET /v1/skills/:skill_id — local route so skill lookups hit disk cache before proxying to backend
  app.get("/v1/skills/:skill_id", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const skill = getRecentLocalSkill(skill_id, clientScope) ?? await getSkill(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    return reply.send(skill);
  });

  // POST /v1/skills/:skill_id/review — agent submits reviewed descriptions + synthetic examples
  app.post("/v1/skills/:skill_id/review", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const { endpoints: reviews } = req.body as {
      endpoints: Array<{
        endpoint_id: string;
        description?: string;
        action_kind?: string;
        resource_kind?: string;
        example_request?: unknown;
        example_response?: unknown;
      }>;
    };
    if (!reviews?.length) return reply.code(400).send({ error: "endpoints[] required" });

    const skill = getRecentLocalSkill(skill_id, clientScope) ?? await getSkill(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });

    const updated = mergeAgentReview(skill.endpoints, reviews);
    skill.endpoints = updated;
    skill.updated_at = new Date().toISOString();

    // Re-publish with agent-reviewed metadata
    try {
      await publishSkill(skill);
      return reply.send({ ok: true, endpoints_updated: reviews.length });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
  // POST /v1/skills/:skill_id/chunk — dynamic subgraph load for the current intent/bindings
  app.post("/v1/skills/:skill_id/chunk", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const { intent, operation_id, known_bindings, max_operations } = req.body as {
      intent?: string;
      operation_id?: string;
      known_bindings?: Record<string, unknown>;
      max_operations?: number;
    };
    const skill = getRecentLocalSkill(skill_id, clientScope) ?? await getSkill(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    return reply.send(toAgentSkillChunkView(getSkillChunk(skill, {
      intent,
      seed_operation_id: operation_id,
      known_bindings,
      max_operations,
    })));
  });

  // POST /v1/skills/:skill_id/execute
  app.post("/v1/skills/:skill_id/execute", { config: { rateLimit: ROUTE_LIMITS["/v1/skills/:skill_id/execute"] } }, async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const { params, projection, confirm_unsafe, dry_run, intent, context_url } = req.body as {
      params?: Record<string, unknown>;
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      dry_run?: boolean;
      intent?: string;
      context_url?: string;
    };
    const skill = getRecentLocalSkill(skill_id, clientScope) ?? await getSkill(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    const execParams = {
      ...(params ?? {}),
      ...(context_url && typeof params?.url !== "string" ? { url: context_url } : {}),
    };
    try {
      const execResult = await executeSkill(skill, execParams, projection, { confirm_unsafe, dry_run, intent, contextUrl: context_url, client_scope: clientScope });
      saveTrace(execResult.trace);
      if (execResult.trace.endpoint_id) {
        recordExecution(skill.skill_id, execResult.trace.endpoint_id, execResult.trace, skill).catch(() => {});
      }
      if (execResult.trace.success) {
        promoteExplicitExecution(
          clientScope,
          intent || skill.intent_signature,
          context_url || (typeof execParams.url === "string" ? execParams.url : undefined),
          skill,
          execResult.trace.endpoint_id,
          execResult.result,
        );
      }

      // Auto-recovery: if endpoint returned 404 (stale), re-capture via orchestrator
      if (
        execResult.trace.status_code === 404 &&
        skill.domain &&
        skill.intent_signature &&
        skill.execution_type !== "browser-capture"
      ) {
        try {
          const recoveryUrl =
            context_url ||
            (typeof execParams.url === "string" && execParams.url) ||
            skill.endpoints.find((endpoint) => typeof endpoint.trigger_url === "string" && endpoint.trigger_url)?.trigger_url ||
            `https://${skill.domain}`;
          const freshResult = await resolveAndExecute(
            intent || skill.intent_signature,
            { ...execParams, url: recoveryUrl },
            { url: recoveryUrl },
            projection,
            { confirm_unsafe, dry_run, intent: intent || skill.intent_signature, client_scope: clientScope }
          );
          saveTrace(freshResult.trace);
          if (freshResult.trace?.skill_id && freshResult.trace?.endpoint_id) {
            recordExecution(freshResult.trace.skill_id, freshResult.trace.endpoint_id, freshResult.trace, skill).catch(() => {});
          }
          return reply.send({
            ...freshResult,
            _recovery: {
              reason: "stale_endpoint_404",
              original_skill_id: skill_id,
              message: "Original endpoint returned 404. Auto-recovered with fresh capture.",
            },
          });
        } catch {
          // Recovery failed — return original 404 with guidance
        }
      }

      return reply.send(execResult);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/skills/:skill_id/auth -- store credentials (cookies/headers) for a skill
  app.post("/v1/skills/:skill_id/auth", async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const skill = await getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });

    const body = req.body as {
      cookies?: Array<{ name: string; value: string; domain: string; path?: string }>;
      headers?: Record<string, string>;
    };
    if (!body.cookies && !body.headers) {
      return reply.code(400).send({ error: "Provide cookies or headers" });
    }

    const ref = `${skill.domain}-session`;
    await storeCredential(ref, JSON.stringify({ cookies: body.cookies ?? [], headers: body.headers ?? {} }));

    // Patch the skill manifest to reference the stored credentials
    if (!skill.auth_profile_ref) {
      await publishSkill({ ...skill, auth_profile_ref: ref });
    }

    return reply.send({ ok: true, auth_profile_ref: ref });
  });

  // POST /v1/auth/login — interactive OAuth flow or direct browser cookie extraction
  app.post("/v1/auth/login", { config: { rateLimit: ROUTE_LIMITS["/v1/auth/login"] } }, async (req, reply) => {
    const { url } = req.body as { url: string };
    if (!url) return reply.code(400).send({ error: "url required" });
    try {
      const result = await interactiveLogin(url);
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/auth/steal — extract cookies from Firefox/Chrome/custom Chromium-family SQLite DBs.
  // No browser launch, Chrome can stay open. Higher rate limit since it's instant.
  app.post("/v1/auth/steal", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const {
      url,
      browser,
      chrome_profile,
      firefox_profile,
      chromium_profile,
      chromium_user_data_dir,
      chromium_cookie_db_path,
      safe_storage_service,
      browser_name,
    } = req.body as {
      url: string;
      browser?: "auto" | "firefox" | "chrome" | "chromium";
      chrome_profile?: string;
      firefox_profile?: string;
      chromium_profile?: string;
      chromium_user_data_dir?: string;
      chromium_cookie_db_path?: string;
      safe_storage_service?: string;
      browser_name?: string;
    };
    if (!url) return reply.code(400).send({ error: "url required" });
    try {
      const domain = new URL(url).hostname;
      const result = await extractBrowserAuth(domain, {
        browser,
        chromeProfile: chrome_profile,
        firefoxProfile: firefox_profile,
        chromium: {
          profile: chromium_profile,
          userDataDir: chromium_user_data_dir,
          cookieDbPath: chromium_cookie_db_path,
          safeStorageService: safe_storage_service,
          browserName: browser_name,
        },
      });
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/skills/:skill_id/verify — trigger verification
  app.post("/v1/skills/:skill_id/verify", async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const skill = await getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    try {
      const { verifySkill } = await import("../verification/index.js");
      const results = await verifySkill(skill);
      return reply.send({ skill_id, verification: results });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/feedback — submit execution feedback with optional diagnostics
  app.post("/v1/feedback", async (req, reply) => {
    const { skill_id, target_id, endpoint_id, rating, outcome, diagnostics } = req.body as {
      skill_id?: string;
      target_id?: string;
      endpoint_id?: string;
      rating?: number;
      outcome?: string;
      diagnostics?: {
        total_ms?: number;
        bottleneck?: string;
        wrong_endpoint?: boolean;
        expected_data?: string;
        got_data?: string;
        trace_version?: string;
      };
    };
    const resolvedSkillId = skill_id ?? target_id;
    if (!resolvedSkillId || !endpoint_id || rating == null) {
      return reply.code(400).send({ error: "skill_id, endpoint_id, and rating required" });
    }
    try {
      const avg_rating = await recordFeedback(resolvedSkillId, endpoint_id, rating);
      // Forward diagnostics to backend for version-grouped analysis
      if (diagnostics) {
        recordDiagnostics(resolvedSkillId, endpoint_id, diagnostics).catch(() => {});
      }
      return reply.send({ ok: true, avg_rating });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // GET /v1/stats — public, no auth required
  app.get("/v1/stats", async (_req, reply) => {
    try {
      const data = await fetchStats();
      return reply.send(data);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // GET /health
  app.get("/health", async (_req, reply) => reply.send({ status: "ok", trace_version: TRACE_VERSION, code_hash: CODE_HASH, git_sha: GIT_SHA }));

  // GET /v1/sessions/:domain — read local trace/debug files instead of proxying to backend
  app.get("/v1/sessions/:domain", async (req, reply) => {
    const { domain } = req.params as { domain: string };
    const query = req.query as { limit?: string | number };
    const limitRaw = typeof query.limit === "number" ? query.limit : Number(query.limit ?? 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
    return reply.send({
      domain,
      sessions: listRecentSessionsForDomain(TRACES_DIR, domain, limit),
    });
  });

  // Catch-all proxy: forward unmatched /v1/* routes to beta-api.unbrowse.ai
  app.all("/v1/*", async (req, reply) => {
    const key = getApiKey();
    const upstream = `${BETA_API_URL}${req.url}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    try {
      const res = await fetch(upstream, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
      });
      const text = await res.text();
      try {
        return reply.code(res.status).send(JSON.parse(text));
      } catch {
        return reply.code(res.status).send({ error: text || `Upstream returned ${res.status}` });
      }
    } catch (err) {
      return reply.code(502).send({ error: `Proxy to beta-api failed: ${(err as Error).message}` });
    }
  });

  // ── Browse session management ─────────────────────────────────────────
  // Kuri browser actions with passive HAR indexing. The server manages a
  // per-session tab + HAR state so every action the agent takes through
  // the CLI is passively captured and indexed.

  // browseSessions is module-level (shared with orchestrator via registerBrowseSession)

  /** Extract registrable domain for auth profile naming */
  function profileName(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown"; }
  }

  async function getOrCreateBrowseSession(): Promise<{ tabId: string; url: string; harActive: boolean; domain: string }> {
    const existing = browseSessions.get("default");
    if (existing) return existing;
    await kuri.start().catch(() => {});
    const tabId = await kuri.newTab();
    await kuri.harStart(tabId).catch(() => {});
    await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {});
    const session = { tabId, url: "about:blank", harActive: true, domain: "" };
    browseSessions.set("default", session);
    return session;
  }

  // POST /v1/browse/go — navigate to URL
  app.post("/v1/browse/go", async (req, reply) => {
    const { url } = req.body as { url: string };
    if (!url) return reply.code(400).send({ error: "url required" });
    const session = await getOrCreateBrowseSession();
    const newDomain = profileName(url);

    // Flush prior HAR entries before navigating
    if (session.harActive && session.url !== "about:blank") {
      try {
        const { entries } = await kuri.harStop(session.tabId);
        passiveIndexHar(entries, session.url);
      } catch { /* non-fatal */ }
      session.harActive = false;
    }

    // Auto-save auth profile for the old domain before leaving
    if (session.domain && session.domain !== newDomain) {
      await kuri.authProfileSave(session.tabId, session.domain).catch(() => {});
    }

    // Inject cookies: try Kuri auth profile first, fall back to Chrome SQLite extraction
    if (newDomain && newDomain !== session.domain) {
      await kuri.authProfileLoad(session.tabId, newDomain).catch(() => {});

      // Also inject cookies from the user's real Chrome/Firefox browser
      try {
        const { cookies: browserCookies } = extractBrowserCookies(newDomain);
        if (browserCookies.length > 0) {
          for (const c of browserCookies) {
            await kuri.setCookie(session.tabId, c).catch(() => {});
          }
        }
      } catch { /* non-fatal */ }
    }
    // Start capture BEFORE navigation so all initial API calls are recorded
    await kuri.networkEnable(session.tabId).catch(() => {});
    await kuri.harStart(session.tabId).catch(() => {});
    await kuri.scriptInject(session.tabId, INTERCEPTOR_SCRIPT).catch(() => {});
    session.harActive = true;

    await kuri.navigate(session.tabId, url);
    const finalUrl = await kuri.getCurrentUrl(session.tabId).catch(() => url);
    session.url = typeof finalUrl === "string" && finalUrl.startsWith("http") ? finalUrl : url;
    session.domain = profileName(session.url);

    // Re-inject interceptor via evaluate for current page context
    await kuri.evaluate(session.tabId, INTERCEPTOR_SCRIPT).catch(() => {});

    return reply.send({ ok: true, url: session.url, tab_id: session.tabId, auth_profile: session.domain });
  });

  // POST /v1/browse/snap — a11y snapshot
  app.post("/v1/browse/snap", async (req, reply) => {
    const { filter } = (req.body as { filter?: string }) ?? {};
    const session = await getOrCreateBrowseSession();
    const snapshot = await kuri.snapshot(session.tabId, filter);
    return reply.send({ snapshot, tab_id: session.tabId });
  });

  // POST /v1/browse/click — click by ref
  app.post("/v1/browse/click", async (req, reply) => {
    const { ref } = req.body as { ref: string };
    if (!ref) return reply.code(400).send({ error: "ref required" });
    const session = await getOrCreateBrowseSession();
    await kuri.click(session.tabId, ref);
    return reply.send({ ok: true });
  });

  // POST /v1/browse/fill — fill input by ref
  app.post("/v1/browse/fill", async (req, reply) => {
    const { ref, value } = req.body as { ref: string; value: string };
    if (!ref || value === undefined) return reply.code(400).send({ error: "ref and value required" });
    const session = await getOrCreateBrowseSession();
    await kuri.fill(session.tabId, ref, value);
    return reply.send({ ok: true });
  });

  // POST /v1/browse/type — keyboard type
  app.post("/v1/browse/type", async (req, reply) => {
    const { text } = req.body as { text: string };
    if (!text) return reply.code(400).send({ error: "text required" });
    const session = await getOrCreateBrowseSession();
    await kuri.keyboardType(session.tabId, text);
    return reply.send({ ok: true });
  });

  // POST /v1/browse/press — press key
  app.post("/v1/browse/press", async (req, reply) => {
    const { key } = req.body as { key: string };
    if (!key) return reply.code(400).send({ error: "key required" });
    const session = await getOrCreateBrowseSession();
    await kuri.press(session.tabId, key);
    return reply.send({ ok: true });
  });

  // POST /v1/browse/select — select option by ref
  app.post("/v1/browse/select", async (req, reply) => {
    const { ref, value } = req.body as { ref: string; value: string };
    if (!ref || value === undefined) return reply.code(400).send({ error: "ref and value required" });
    const session = await getOrCreateBrowseSession();
    await kuri.select(session.tabId, ref, value);
    return reply.send({ ok: true });
  });

  // POST /v1/browse/scroll — scroll
  app.post("/v1/browse/scroll", async (req, reply) => {
    const { direction, amount } = (req.body as { direction?: string; amount?: number }) ?? {};
    const session = await getOrCreateBrowseSession();
    await kuri.scroll(session.tabId, (direction as any) ?? "down", amount);
    return reply.send({ ok: true });
  });

  // GET /v1/browse/screenshot — capture screenshot
  app.get("/v1/browse/screenshot", async (_req, reply) => {
    const session = await getOrCreateBrowseSession();
    const data = await kuri.screenshot(session.tabId);
    return reply.send({ screenshot: data, tab_id: session.tabId });
  });

  // GET /v1/browse/text — page text
  app.get("/v1/browse/text", async (_req, reply) => {
    const session = await getOrCreateBrowseSession();
    const text = await kuri.getText(session.tabId);
    return reply.send({ text });
  });

  // GET /v1/browse/markdown — page as markdown
  app.get("/v1/browse/markdown", async (_req, reply) => {
    const session = await getOrCreateBrowseSession();
    const markdown = await kuri.getMarkdown(session.tabId);
    return reply.send({ markdown });
  });

  // GET /v1/browse/cookies — page cookies
  app.get("/v1/browse/cookies", async (_req, reply) => {
    const session = await getOrCreateBrowseSession();
    const cookies = await kuri.getCookies(session.tabId);
    return reply.send({ cookies });
  });

  // POST /v1/browse/eval — evaluate JS
  app.post("/v1/browse/eval", async (req, reply) => {
    const { expression } = req.body as { expression: string };
    if (!expression) return reply.code(400).send({ error: "expression required" });
    const session = await getOrCreateBrowseSession();
    const result = await kuri.evaluate(session.tabId, expression);
    return reply.send({ result });
  });

  // POST /v1/browse/back — navigate back
  app.post("/v1/browse/back", async (_req, reply) => {
    const session = await getOrCreateBrowseSession();
    await kuri.goBack(session.tabId);
    return reply.send({ ok: true });
  });

  // POST /v1/browse/forward — navigate forward
  app.post("/v1/browse/forward", async (_req, reply) => {
    const session = await getOrCreateBrowseSession();
    await kuri.goForward(session.tabId);
    return reply.send({ ok: true });
  });

  // POST /v1/browse/close — close session, flush HAR, index, save auth
  app.post("/v1/browse/close", async (_req, reply) => {
    const session = browseSessions.get("default");
    if (!session) return reply.send({ ok: true, message: "no active session" });

    // Save auth profile for the current domain before closing
    if (session.domain) {
      await kuri.authProfileSave(session.tabId, session.domain).catch(() => {});
    }

    // Collect intercepted fetch/XHR requests (has response bodies HAR misses)
    let intercepted: RawRequest[] = [];
    try {
      const raw = await collectInterceptedRequests(session.tabId);
      intercepted = raw.map(r => ({
        url: r.url,
        method: r.method,
        request_headers: r.request_headers ?? {},
        request_body: r.request_body,
        response_status: r.response_status,
        response_headers: r.response_headers ?? {},
        response_body: r.response_body,
        timestamp: r.timestamp,
      }));
    } catch { /* non-fatal */ }

    // Also collect HAR entries
    let harEntries: KuriHarEntry[] = [];
    if (session.harActive) {
      try {
        const { entries } = await kuri.harStop(session.tabId);
        harEntries = entries;
      } catch { /* non-fatal */ }
    }

    // Merge: intercepted requests (better bodies) + HAR entries, deduplicated
    const harRequests = harEntriesToRawRequests(harEntries);
    const seen = new Set<string>();
    const allRequests: RawRequest[] = [];
    for (const r of intercepted) {
      const key = `${r.method}:${r.url}`;
      if (!seen.has(key)) { seen.add(key); allRequests.push(r); }
    }
    for (const r of harRequests) {
      const key = `${r.method}:${r.url}`;
      if (!seen.has(key)) { seen.add(key); allRequests.push(r); }
    }

    // Quick synchronous cache write: extract endpoints and cache immediately
    // so the next resolve finds them. Full enrichment runs async after.
    {
      let domain: string;
      try { domain = new URL(session.url).hostname; } catch { domain = session.domain; }
      const rawEndpoints = extractEndpoints(allRequests, undefined, { pageUrl: session.url, finalUrl: session.url });
      if (rawEndpoints.length > 0) {
        const existingSkill = findExistingSkillForDomain(domain);
        const mergedEps = existingSkill ? mergeEndpoints(existingSkill.endpoints, rawEndpoints) : rawEndpoints;
        if (!existingSkill || mergedEps.length >= existingSkill.endpoints.length) {
          for (const ep of mergedEps) { if (!ep.description) ep.description = generateLocalDescription(ep); }
          const quickSkill: SkillManifest = {
            skill_id: existingSkill?.skill_id ?? nanoid(),
            version: "1.0.0", schema_version: "1",
            lifecycle: "active" as const, execution_type: "http" as const,
            created_at: existingSkill?.created_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
            name: domain, intent_signature: `browse ${domain}`, domain,
            description: `API skill for ${domain}`, owner_type: "agent" as const,
            endpoints: mergedEps,
            intents: Array.from(new Set([...(existingSkill?.intents ?? []), `browse ${domain}`])),
          };
          // Write snapshot + domain cache synchronously
          const cacheKey = buildResolveCacheKey(domain, `browse ${domain}`, session.url);
          const scopedKey = scopedCacheKey("global", cacheKey);
          writeSkillSnapshot(scopedKey, quickSkill);
          const domainKey = getDomainReuseKey(session.url ?? domain);
          if (domainKey) {
            domainSkillCache.set(domainKey, {
              skillId: quickSkill.skill_id,
              localSkillPath: snapshotPathForCacheKey(scopedKey),
              ts: Date.now(),
            });
            persistDomainCache();
          }
          try { cachePublishedSkill(quickSkill); } catch { /* best-effort */ }
          // Invalidate stale route cache entries so resolve finds the fresh skill
          invalidateRouteCacheForDomain(domain);
          console.log(`[passive-index] ${domain}: ${mergedEps.length} endpoints cached synchronously`);
        }
      }
    }

    // Run full async enrichment pipeline (agent augmentation, graph, marketplace publish)
    passiveIndexFromRequests(allRequests, session.url);
    await kuri.closeTab(session.tabId).catch(() => {});
    browseSessions.delete("default");
    return reply.send({ ok: true, indexed: true, auth_saved: session.domain || null });
  });
}

function saveTrace(trace: unknown) {
  if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true });
  const t = trace as { trace_id: string };
  writeFileSync(join(TRACES_DIR, `${t.trace_id}.json`), JSON.stringify(trace, null, 2));
}
