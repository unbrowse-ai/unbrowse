import type { FastifyInstance } from "fastify";
import * as os from "os";
import * as path from "path";
import { readdirSync, readFileSync } from "fs";
import * as kuri from "../kuri/client.js";
import type { KuriHarEntry } from "../kuri/client.js";
import { extractEndpoints, extractAuthHeaders } from "../reverse-engineer/index.js";
import { INTERCEPTOR_SCRIPT, enrichPassiveCaptureRequests, injectInterceptor, collectInterceptedRequests } from "../capture/index.js";
import { indexSkillLocally, mergeAgentReview, publishIndexedSkill, queueBackgroundIndex } from "../indexer/index.js";
import { nanoid } from "nanoid";
import type { ExecutionTrace, OrchestrationTiming, ProjectionOptions, SkillManifest } from "../types/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
import { buildSkillOperationGraph, getEndpointDescriptionMetadata, getSkillChunk, toAgentSkillChunkView } from "../graph/index.js";
import { findExistingSkillForDomain, cachePublishedSkill } from "../client/index.js";
import { storeCredential } from "../vault/index.js";
import { getRegistrableDomain } from "../domain.js";
import { generateLocalDescription, writeSkillSnapshot, readSkillSnapshot, buildResolveCacheKey, getDomainReuseKey, domainSkillCache, persistDomainCache, scopedCacheKey, snapshotPathForCacheKey, invalidateRouteCacheForDomain, summarizeSchema, extractSampleValues } from "../orchestrator/index.js";
import { TRACE_VERSION, CODE_HASH, DEFAULT_BACKEND_URL, GIT_SHA, PACKAGE_VERSION } from "../version.js";
import { promoteExplicitExecution, resolveAndExecute, getOrCreateBrowserCaptureSkill, type OrchestratorResult } from "../orchestrator/index.js";
import { getContributionConfig } from "../config/contribution.js";
import { getSkill } from "../marketplace/index.js";
import { executeSkill, rankEndpoints } from "../execution/index.js";
import {
  extractBrowserAuth,
  importBrowserCookiesIntoTab,
  loginWithBrowserFallback,
  loadAuthProfileBestEffort,
  saveAuthProfileBestEffort,
} from "../auth/index.js";
import { consumeDashboardPairingToken, recordFeedback, recordDiagnostics, recordExecution, getApiKey, getRecentLocalSkill, recordAnalyticsSession, type AnalyticsSessionPayload } from "../client/index.js";
import { ROUTE_LIMITS } from "../ratelimit/index.js";
import { listRecentSessionsForDomain } from "../session-logs.js";
import { attachAgentOutcomeHints } from "../agent-outcome.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { writeDomainNote, readDomainNote } from "../extraction/domain-notes.js";
import {
  BrowseSessionError,
  createRegisteredBrowseSession,
  extractBrowseFailureMessage,
  getOrCreateNavigateBrowseSession,
  isBrowseSessionLive,
  isRecoverableBrowseFailure,
  type BrowseSession,
  withSerializedStrictBrowseSession,
  removeBrowseSession,
} from "./browse-session.js";
import { cacheBrowseRequests, harEntriesToRawRequests } from "./browse-index.js";
import { isUrlWaitHint, resolveSubmitWaitHint, submitBrowseForm } from "./browse-submit.js";
import { cleanupStaleSkills } from "../stale-cleanup-runner.js";
import {
  decideCheckpointPublish,
  decideExplicitPublish,
  getCapturePipelineSettings,
  updateCapturePipelineSettings,
} from "../settings.js";
import { publishFoundryBundle } from "../foundry/publish-bundle.js";
import { buildEndpointReviewContext } from "../publish/review-context.js";
import { applyWorkflowSchemaReviews } from "../publish/schema-review.js";
import { readWorkflowArtifact, writeWorkflowArtifact } from "../workflow/artifact.js";

const BETA_API_URL = process.env.UNBROWSE_BACKEND_URL || DEFAULT_BACKEND_URL;

const TRACES_DIR = process.env.TRACES_DIR ?? join(process.cwd(), "traces");
const BROWSE_BROKER_MAX = Math.max(1, Number(process.env.KURI_MULTI_BROKER_MAX ?? "1"));
const BROWSE_BROKER_BASE_PORT = Number(process.env.KURI_PORT ?? "7700");

type AnalyticsSessionResult = {
  trace: Pick<ExecutionTrace, "trace_id" | "started_at" | "completed_at" | "endpoint_id" | "trace_version" | "success" | "tokens_saved" | "tokens_saved_pct" | "api_call_count">;
  timing?: Pick<OrchestrationTiming, "source" | "time_saved_ms" | "time_saved_pct" | "cost_saved_uc" | "tokens_saved" | "tokens_saved_pct">;
  source?: OrchestratorResult["source"];
};

export function buildAnalyticsSessionPayload(
  result: AnalyticsSessionResult,
  opts: {
    browser_mode?: AnalyticsSessionPayload["browser_mode"];
    discovery_queries: number;
    cached_skill_calls?: number;
    fresh_index_calls?: number;
  },
): AnalyticsSessionPayload {
  const source = result.timing?.source ?? result.source;
  const apiCalls = result.trace.api_call_count ?? (result.trace.endpoint_id ? 1 : 0);
  const browserMode = opts.browser_mode ?? (
    source === "live-capture" || source === "first-pass" || source === "browser-action"
      ? "default"
      : "replaced"
  );
  const cachedSkillCalls = opts.cached_skill_calls ?? (
    apiCalls > 0 && source !== "live-capture" && source !== "first-pass" ? 1 : 0
  );
  const freshIndexCalls = opts.fresh_index_calls ?? (
    apiCalls > 0 && (source === "live-capture" || source === "first-pass") ? 1 : 0
  );

  return {
    session_id: result.trace.trace_id,
    started_at: result.trace.started_at,
    completed_at: result.trace.completed_at,
    trace_version: result.trace.trace_version ?? TRACE_VERSION,
    api_calls: apiCalls,
    discovery_queries: opts.discovery_queries,
    cached_skill_calls: cachedSkillCalls,
    fresh_index_calls: freshIndexCalls,
    browser_mode: browserMode,
    success: result.trace.success ?? true,
    source,
    time_saved_ms: result.timing?.time_saved_ms,
    time_saved_pct: result.timing?.time_saved_pct,
    tokens_saved: result.trace.tokens_saved ?? result.timing?.tokens_saved,
    tokens_saved_pct: result.trace.tokens_saved_pct ?? result.timing?.tokens_saved_pct,
    cost_saved_uc: result.timing?.cost_saved_uc,
  };
}


/** Process HAR entries into routes and queue local index, with remote share opt-in only. */
function passiveIndexFromRequests(
  requests: RawRequest[],
  pageUrl: string,
  options: { publishAfterIndex?: boolean } = {},
): void {
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
        console.error(`[passive-index] ${domain}: 0 endpoints from ${requests.length} requests`);
        return;
      }

      // 2. Extract and store auth credentials (cookies + sensitive headers)
      const capturedAuthHeaders = extractAuthHeaders(requests);
      if (Object.keys(capturedAuthHeaders).length > 0) {
        const authKey = `${getRegistrableDomain(domain)}-session`;
        await storeCredential(authKey, JSON.stringify({ headers: capturedAuthHeaders }));
      }

      // 3. Merge with existing skill for this domain (never reduce endpoint count)
      const existingSkill = findExistingSkillForDomain(domain, intent);
      const mergedEndpoints = existingSkill
        ? mergeEndpoints(existingSkill.endpoints, rawEndpoints)
        : rawEndpoints;
      // Guard: if passive capture found fewer endpoints than what exists, keep the richer set
      if (existingSkill && mergedEndpoints.length < existingSkill.endpoints.length) {
        console.error(`[passive-index] ${domain}: skipping — would reduce ${existingSkill.endpoints.length} → ${mergedEndpoints.length} endpoints`);
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

      // 9. Queue local index, and only remote-share when the caller explicitly asked for it.
      const cacheKey = `passive:${domain}:${Date.now()}`;
      queueBackgroundIndex({
        skill,
        domain,
        intent,
        contextUrl: pageUrl,
        cacheKey,
        publishAfterIndex: options.publishAfterIndex === true,
      });

      console.error(`[passive-index] ${domain}: ${enrichedEndpoints.length} endpoints indexed from ${requests.length} requests`);
    } catch (err) {
      console.error(`[passive-index] ${domain} failed: ${err instanceof Error ? err.message : err}`);
    }
  })();
}

/** Convenience wrapper: convert HAR entries and run passive indexing */
function passiveIndexHar(
  entries: KuriHarEntry[],
  pageUrl: string,
  options: { publishAfterIndex?: boolean } = {},
): void {
  passiveIndexFromRequests(harEntriesToRawRequests(entries), pageUrl, options);
}
// ── Browse session state (module-level so orchestrator can register sessions) ──
const browseSessions = new Map<string, BrowseSession>();

function browseBrokerPorts(): number[] {
  return Array.from({ length: BROWSE_BROKER_MAX }, (_, index) => BROWSE_BROKER_BASE_PORT + index);
}

function brokerForSession(session: BrowseSession | undefined): kuri.KuriClient {
  if (session?.client) return session.client as kuri.KuriClient;
  if (session?.brokerPort !== undefined) return kuri.getKuriClient(session.brokerPort);
  return kuri.getKuriClient();
}

function selectBrowseBrokerClient(requestedSessionId?: string): kuri.KuriClient {
  if (requestedSessionId) {
    const existing = browseSessions.get(requestedSessionId);
    if (existing?.client) return existing.client as kuri.KuriClient;
    if (existing) return brokerForSession(existing);
  }

  const loads = new Map<number, number>(browseBrokerPorts().map((port) => [port, 0]));
  for (const session of browseSessions.values()) {
    const port = session.brokerPort ?? BROWSE_BROKER_BASE_PORT;
    loads.set(port, (loads.get(port) ?? 0) + 1);
  }
  const [selectedPort] = [...loads.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0] ?? [BROWSE_BROKER_BASE_PORT, 0];
  return kuri.getKuriClient(selectedPort);
}

async function loadSkillForMutation(skillId: string, clientScope?: string): Promise<SkillManifest | null> {
  let skill = getRecentLocalSkill(skillId, clientScope);
  if (!skill) {
    for (const [, entry] of domainSkillCache) {
      if (entry.skillId === skillId && entry.localSkillPath) {
        try { skill = JSON.parse(require("fs").readFileSync(entry.localSkillPath, "utf-8")); } catch {}
        break;
      }
    }
  }
  if (!skill) skill = await getSkill(skillId, clientScope);
  return skill;
}

function buildSkillIndexJob(skill: SkillManifest, clientScope?: string): {
  skill: SkillManifest;
  domain: string;
  intent: string;
  clientScope?: string;
  cacheKey: string;
} {
  const intent = skill.intent_signature || `browse ${skill.domain}`;
  return {
    skill,
    domain: skill.domain,
    intent,
    clientScope,
    cacheKey: buildResolveCacheKey(skill.domain, intent, undefined),
  };
}

/** Register a browse session from the orchestrator (Phase 4 handoff) */
export function registerBrowseSession(tabId: string, url: string, domain: string): BrowseSession {
  const client = kuri.getKuriClient();
  return createRegisteredBrowseSession(browseSessions, {
    tabId,
    url,
    harActive: true,
    domain,
    brokerPort: client.getPort(),
    client,
  });
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
    npmPoint("unbrowse-openclaw", "last-month"),
    npmPoint("unbrowse", "1970-01-01:2099-12-31"),
    npmPoint("unbrowse-openclaw", "1970-01-01:2099-12-31"),
    npmRange("unbrowse"),
    npmRange("unbrowse-openclaw"),
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

  function checkpointPublishCommand(skillId: string | null, confirmPublish = false): string {
    return skillId
      ? `unbrowse publish --skill ${skillId}${confirmPublish ? " --confirm-publish" : ""}`
      : `unbrowse publish --skill <skill_id>${confirmPublish ? " --confirm-publish" : ""}`;
  }

  function buildPublishFailureNextStep(skillId: string, validationErrors?: string[]): string {
    const reviewErrors = (validationErrors ?? []).filter((error) => error.startsWith("review_required:"));
    if (reviewErrors.length > 0) {
      return `Remote share blocked: ${reviewErrors.length} endpoint(s) still need review. Re-run ${checkpointPublishCommand(skillId)} to inspect review_context, then publish again with reviewed endpoints.`;
    }
    return `Remote share did not complete. Inspect validation_errors, adjust the contract locally, then retry ${checkpointPublishCommand(skillId, true)}.`;
  }

  function buildCheckpointNextStep(
    action: "sync" | "close",
    result: {
      skill_id: string | null;
      pipeline: {
        index_queued: boolean;
        publish_queued: boolean;
      };
      publish_policy: {
        mode: "auto" | "disabled" | "blacklisted" | "prompt";
        reason: string;
        matched_domain?: string;
      };
    },
    sessionId?: string,
  ): string {
    const sessionHint = sessionId ? ` --session ${sessionId}` : "";
    const publishCommand = checkpointPublishCommand(
      result.skill_id,
      result.publish_policy.mode === "blacklisted" || result.publish_policy.mode === "prompt",
    );

    if (!result.pipeline.index_queued) {
      return action === "sync"
        ? `Checkpoint recorded, but no new capture was available to index. Continue browsing, then run \`unbrowse close${sessionHint}\` for the final checkpoint.`
        : "Final checkpoint recorded, but no new capture was available to index or publish.";
    }

    if (result.publish_policy.mode === "auto") {
      return action === "sync"
        ? `Checkpoint saved. Background index + publish queued. Continue browsing, then run \`unbrowse close${sessionHint}\` for the final checkpoint.`
        : "Final checkpoint saved. Background index + publish queued. Inspect the indexed contract or wait for publish to complete.";
    }

    const base = result.publish_policy.mode === "disabled"
      ? "Checkpoint saved. Local index queued, but auto-publish is disabled in settings."
      : `Checkpoint saved. Local index queued, but auto-publish did not run: ${result.publish_policy.reason}`;

    const suffix = result.skill_id
      ? ` Review the indexed contract, then run \`${publishCommand}\` only if you own this index.`
      : "";

    if (action === "sync") {
      return `${base} Continue browsing, then run \`unbrowse close${sessionHint}\` when done.${suffix}`;
    }
    return `${base}${suffix}`;
  }

  // Auth gate: block all routes except /health when no API key is configured.
  // On fresh install, the server fires background registration and starts
  // accepting requests before the key is written. Wait up to 10s for the
  // background registration to complete before returning 401 — this closes
  // the race where the first resolve lands between server-up and key-ready.
  // API key is optional. If no key is configured, most local operations still
  // work — only routes that genuinely need the backend (publish, earnings,
  // payments) will fail gracefully at their own call sites with actionable
  // messages. Registration is lazy and happens in the background on first use.
  app.addHook("onRequest", async (req, _reply) => {
    if (req.url === "/health" || req.url === "/v1/stats" || req.url.startsWith("/v1/settings")) return;
    if (getApiKey()) return;
    // No key yet — give any in-flight background registration a moment to land,
    // but never block the request or 401 on missing key.
    try {
      const { waitForBackgroundRegistration } = await import("../client/index.js");
      await waitForBackgroundRegistration(2_000);
    } catch { /* best effort */ }
  });

  app.get("/v1/settings", async (_req, reply) => {
    return reply.send({
      capture_pipeline: getCapturePipelineSettings(),
    });
  });

  app.options("/v1/local/pair", async (_req, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, OPTIONS")
      .header("Access-Control-Allow-Headers", "Content-Type")
      .send();
  });

  app.get("/v1/local/pair", async (req, reply) => {
    const query = req.query as { token?: string };
    const paired = consumeDashboardPairingToken(String(query.token ?? ""));
    reply.header("Access-Control-Allow-Origin", "*");
    if (!paired) {
      return reply.code(404).send({ error: "pairing_not_found_or_expired" });
    }
    return reply.send({
      api_key: paired.config.api_key,
      agent_id: paired.config.agent_id,
      agent_name: paired.config.agent_name,
      email: paired.config.email ?? paired.config.agent_name,
      user_id: paired.config.user_id ?? null,
      expires_at: paired.expires_at,
    });
  });

  app.post("/v1/settings", async (req, reply) => {
    const body = (req.body ?? {}) as {
      auto_publish_checkpoints?: boolean;
      publish_domain_blacklist?: string[];
      publish_domain_promptlist?: string[];
      clear_publish_domain_blacklist?: boolean;
      clear_publish_domain_promptlist?: boolean;
    };

    const settings = updateCapturePipelineSettings({
      auto_publish_checkpoints: typeof body.auto_publish_checkpoints === "boolean"
        ? body.auto_publish_checkpoints
        : undefined,
      publish_domain_blacklist: Array.isArray(body.publish_domain_blacklist)
        ? body.publish_domain_blacklist
        : undefined,
      publish_domain_promptlist: Array.isArray(body.publish_domain_promptlist)
        ? body.publish_domain_promptlist
        : undefined,
      clear_publish_domain_blacklist: body.clear_publish_domain_blacklist === true,
      clear_publish_domain_promptlist: body.clear_publish_domain_promptlist === true,
    });

    return reply.send({
      ok: true,
      capture_pipeline: settings,
      next_step: settings.auto_publish_checkpoints
        ? "Auto-publish after sync/close is enabled unless a domain rule blocks it."
        : "Auto-publish after sync/close is disabled. Use index for local recompute and publish only when you explicitly want remote share.",
    });
  });

  // ── Browse-session inspection (autonomy is the harness) ─────────────
  // Read-only, always-on endpoints exposing the in-flight capture state of
  // every active browse session. The agent invoking the CLI is the judge:
  // it reads these responses and decides whether autonomous discovery is
  // working. No UNBROWSE_DEV gate — this is product surface, not a back door.
  app.get("/v1/browse/sessions", async (_req, reply) => {
    const sessions = Array.from(browseSessions.values()).map((s) => ({
      session_id: s.sessionId,
      tab_id: s.tabId,
      url: s.url,
      domain: s.domain,
      har_active: s.harActive,
      broker_port: s.brokerPort ?? null,
      streaming_publish_active: streamingWatchers.has(s.sessionId),
    }));
    return reply.send({ sessions, count: sessions.length });
  });

  app.get("/v1/browse/sessions/:id/buffer", async (req, reply) => {
    const { id } = req.params as { id: string };
    let session: BrowseSession | undefined;
    for (const s of browseSessions.values()) {
      if (s.sessionId === id || s.tabId === id) { session = s; break; }
    }
    if (!session) return reply.code(404).send({ error: "session_not_found", id });

    let intercepted: unknown[] = [];
    let interceptError: string | null = null;
    try {
      intercepted = await collectInterceptedRequests(session.tabId);
    } catch (err) {
      interceptError = err instanceof Error ? err.message : String(err);
    }

    // HAR snapshot: stop+restart trick. We lose ~100ms of capture between
    // stop and restart, but mid-session inspection is otherwise impossible
    // (Kuri's HAR API is start/stop only).
    let harEntries: KuriHarEntry[] = [];
    let harError: string | null = null;
    if (session.harActive) {
      try {
        const broker = brokerForSession(session);
        const stopResult = await broker.harStop(session.tabId);
        harEntries = stopResult.entries ?? [];
        try { await broker.harStart(session.tabId); } catch { /* ignore */ }
      } catch (err) {
        harError = err instanceof Error ? err.message : String(err);
      }
    }

    return reply.send({
      session: {
        session_id: session.sessionId,
        tab_id: session.tabId,
        url: session.url,
        domain: session.domain,
        har_active: session.harActive,
        streaming_publish_active: streamingWatchers.has(session.sessionId),
      },
      intercepted_requests: intercepted,
      intercepted_count: Array.isArray(intercepted) ? intercepted.length : 0,
      intercept_error: interceptError,
      har_entries: harEntries.map((e) => ({
        url: e?.request?.url,
        method: e?.request?.method,
        status: e?.response?.status,
        mime_type: e?.response?.content?.mimeType,
        size: e?.response?.bodySize,
      })),
      har_count: harEntries.length,
      har_error: harError,
      total_captured: (Array.isArray(intercepted) ? intercepted.length : 0) + harEntries.length,
    });
  });
  // GET /v1/trace/:trace_id — Harness #2: Retrieve execution trace with diagnostic context
  app.get("/v1/trace/:trace_id", async (req, reply) => {
    const { trace_id } = req.params as { trace_id: string };
    // Traces are stored per-skill in ~/.unbrowse/traces/
    const traceDir = path.join(
      process.env.UNBROWSE_TRACE_DIR ?? path.join(os.homedir(), ".unbrowse", "traces"),
    );
    if (trace_id === "latest") {
      // Return most recent trace
      try {
        const files = readdirSync(traceDir).filter((f) => f.endsWith(".json")).sort().reverse();
        if (files.length === 0) return reply.send({ message: "No traces found", trace_id: "latest" });
        const trace = JSON.parse(readFileSync(join(traceDir, files[0]), "utf-8"));
        return reply.send({ trace_id: "latest", ...trace });
      } catch {
        return reply.send({ message: "No traces found (trace directory may not exist yet)", trace_id: "latest" });
      }
    }
    try {
      const trace = JSON.parse(readFileSync(join(traceDir, `${trace_id}.json`), "utf-8"));
      return reply.send({ trace_id, ...trace });
    } catch {
      return reply.code(404).send({ error: `Trace ${trace_id} not found` });
    }
  });

  // POST /v1/intent/resolve
  app.post("/v1/intent/resolve", { config: { rateLimit: ROUTE_LIMITS["/v1/intent/resolve"] } }, async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { intent, params, context, projection, confirm_unsafe, confirm_third_party_terms, dry_run, force_capture, skip_robots_check, visual_context, budget_ms } = req.body as {
      intent: string;
      params?: Record<string, unknown>;
      context?: { url?: string; domain?: string };
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      confirm_third_party_terms?: boolean;
      dry_run?: boolean;
      force_capture?: boolean;
      skip_robots_check?: boolean;
      visual_context?: boolean;
      budget_ms?: number;
    };
    if (!intent) return reply.code(400).send({ error: "intent required" });

    // ── Fix A: in-flight resolve ───────────────────────────────────────
    // If there's an active browse session for the requested domain, snapshot
    // its capture buffer first. This writes a fresh skill into domainSkillCache
    // so resolveAndExecute's domain-cache check serves the in-flight data
    // instead of falling through to live-capture. North Star: the agent
    // doesn't need to call close/sync to see what's already in the buffer.
    let inflightFlushResult: { skill_id: string | null; request_count: number; endpoint_count: number } | null = null;
    if (context?.url && !force_capture) {
      try {
        const activeSession = findActiveSessionForDomain(context.url);
        if (activeSession) {
          const flushed = await lightFlushBrowseCapture(activeSession);
          if (flushed.request_count > 0) {
            inflightFlushResult = {
              skill_id: flushed.skill_id,
              request_count: flushed.request_count,
              endpoint_count: flushed.endpoint_count,
            };
            console.log(`[in-flight-flush] session=${activeSession.sessionId.slice(0, 8)} domain=${flushed.domain} requests=${flushed.request_count} endpoints=${flushed.endpoint_count} skill=${flushed.skill_id?.slice(0, 15) ?? "none"}`);
          }
        }
      } catch (err) {
        console.warn(`[in-flight-flush] failed: ${(err as Error).message}`);
      }
    }

    try {
      const result = await resolveAndExecute(intent, params ?? {}, context, projection, { confirm_unsafe, confirm_third_party_terms, dry_run, force_capture, skip_robots_check, client_scope: clientScope, budget_ms });

      // Surface timing breakdown
      const res = attachAgentOutcomeHints({ ...result } as Record<string, unknown>, {
        skill: result.skill,
        endpointId: result.trace.endpoint_id,
        timing: result.timing,
      });
      if (result.timing) {
        res.timing = result.timing;
      }

      // If the orchestrator already included available_endpoints in result (deferral),
      // also append them at the top level for backward compatibility.
      const innerResult = result.result as Record<string, unknown> | null;
      if (innerResult?.available_endpoints && !res.available_endpoints) {
        res.available_endpoints = innerResult.available_endpoints;
      }

      await recordAnalyticsSession(buildAnalyticsSessionPayload(result, {
        discovery_queries: 1,
      })).catch(() => {});

      // Harness #2: inject visual context (screenshot) for agent empathy
      if (visual_context && context?.url) {
        try {
          const tabId = await kuri.newTab(context.url);
          if (tabId) {
            await new Promise((r) => setTimeout(r, 3000));
            const screenshot = await kuri.screenshot(tabId);
            if (screenshot) (res as Record<string, unknown>).visual_context = { screenshot };
          }
        } catch {
          // Visual context unavailable — return without it
        }
      }

      // Surface in-flight flush result so harnesses can see Fix A fired
      if (inflightFlushResult) {
        (res as Record<string, unknown>).inflight_flush = inflightFlushResult;
      }

      return reply.send(res);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });


  // POST /v1/capture — Phase 8.2 standalone capture verb.
  //
  // Wraps the existing executeBrowserCapture pipeline (browser-capture meta-skill).
  // The agent calls this explicitly when it has decided the cost (5–15s of live
  // browser work) is justified — resolve no longer triggers it implicitly.
  //
  // Returns: { skill_id, endpoints_discovered, marketplace_published, ms, ... }.
  // marketplace_published reflects the share_pointers gate: when contribution
  // mode is private (default), local cache + snapshot writes happen but the
  // skill is NOT pushed to the marketplace.
  app.post("/v1/capture", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const body = (req.body as { url?: string; intent?: string; auth_headers?: Record<string, string>; cookies?: Array<{ name: string; value: string; domain: string }> }) ?? {};
    const url = body.url;
    const intent = body.intent ?? "capture";
    if (!url) return reply.code(400).send({ error: "url required" });

    const t0 = Date.now();
    try {
      const skill = await getOrCreateBrowserCaptureSkill();
      const params: Record<string, unknown> = { url, intent };
      if (body.auth_headers) params.auth_headers = body.auth_headers;
      if (body.cookies) params.cookies = body.cookies;
      const exec = await executeSkill(skill, params, undefined, {
        intent,
        contextUrl: url,
        client_scope: clientScope,
      });

      const learned = (exec as { learned_skill?: SkillManifest }).learned_skill;
      const inner = (exec.result as Record<string, unknown> | null) ?? {};
      const endpoints = learned?.endpoints ?? [];
      const skillId = learned?.skill_id ?? (typeof inner.learned_skill_id === "string" ? inner.learned_skill_id : undefined);
      const ms = Date.now() - t0;

      // Mirror the share_pointers gate so the agent sees what actually happened.
      const sharePointers = getContributionConfig().contribution.share_pointers;
      const marketplacePublished = sharePointers && endpoints.length > 0 && exec.trace.success === true;

      // Per-domain extraction notes (LLM-prose memory). Fire-and-forget — never
      // blocks the response. Notes are injected back into the LLM augment pass
      // on the next capture for this domain. The deterministic ranker never
      // reads them.
      // Surface the prior note + the structural evidence the calling agent
      // would summarize. The agent (Claude / Codex / etc.) reads this from
      // the capture response and decides whether to call `unbrowse note write
      // --domain X --body "..."` to persist a refreshed note. No silent
      // backend LLM call: harness collects, agent judges.
      let priorNoteBody: string | null = null;
      let noteEvidence: Record<string, unknown> | null = null;
      if (learned && learned.domain && endpoints.length > 0 && exec.trace.success === true) {
        const priorNote = readDomainNote(learned.domain);
        priorNoteBody = priorNote?.body ?? null;
        const sampleFieldNames = Array.from(
          new Set(
            endpoints
              .flatMap((e) => Object.keys(e.response_schema?.properties ?? {}))
              .slice(0, 12),
          ),
        );
        noteEvidence = {
          domain: learned.domain,
          intent,
          endpoints: endpoints.map((e) => ({
            method: e.method,
            url_template: e.url_template,
            description: e.description,
          })),
          auth_required: !!inner.auth_recommended,
          spa_framework_detected:
            typeof inner.spa_framework === "string" ? inner.spa_framework : null,
          extraction_method:
            typeof inner.extraction_method === "string" ? inner.extraction_method : null,
          sample_field_names: sampleFieldNames,
        };
      }
      return reply.send({
        skill_id: skillId,
        endpoints_discovered: endpoints.length,
        marketplace_published: marketplacePublished,
        ms,
        endpoints,
        skill: learned,
        trace: exec.trace,
        ...(inner.error ? { error: inner.error, error_message: inner.message } : {}),
        ...(inner.auth_recommended ? { auth_recommended: true, auth_hint: inner.auth_hint } : {}),
        ...(inner.captured_meta ? { captured_meta: inner.captured_meta } : {}),
        ...(typeof inner.seeded_from === "string" ? { capture_path: inner.seeded_from } : {}),
        ...(priorNoteBody ? { prior_domain_note: priorNoteBody } : {}),
        ...(noteEvidence ? { note_evidence: noteEvidence } : {}),
      });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message, ms: Date.now() - t0 });
    }
  });

  // Domain-notes IO — the calling agent reads/writes their own LLM-prose
  // notes per domain. No backend LLM call: the agent (Claude Code, codex,
  // etc.) summarizes the capture itself and POSTs the body here. The next
  // augmentEndpointsWithAgent call reads the latest note as prior knowledge.
  app.get("/v1/domain-notes/:domain", async (req, reply) => {
    const { domain } = req.params as { domain: string };
    try {
      const note = readDomainNote(domain);
      if (!note) return reply.code(404).send({ error: "not_found", domain });
      return reply.send(note);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message, domain });
    }
  });

  app.post("/v1/domain-notes/:domain", async (req, reply) => {
    const { domain } = req.params as { domain: string };
    const body = (req.body as { body?: string }) ?? {};
    if (typeof body.body !== "string" || body.body.trim().length === 0) {
      return reply.code(400).send({ error: "body required (non-empty markdown string)" });
    }
    try {
      writeDomainNote(domain, body.body);
      const fresh = readDomainNote(domain);
      return reply.send(fresh);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message, domain });
    }
  });
  // GET /v1/skills/:skill_id — local route so skill lookups hit disk cache before proxying to backend
  app.get("/v1/skills/:skill_id", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    // Check local caches: recent skills → domain snapshots → marketplace
    let skill = getRecentLocalSkill(skill_id, clientScope);
    if (!skill) {
      for (const [, entry] of domainSkillCache) {
        if (entry.skillId === skill_id && entry.localSkillPath) {
          try { skill = JSON.parse(require("fs").readFileSync(entry.localSkillPath, "utf-8")); } catch {}
          break;
        }
      }
    }
    if (!skill) skill = await getSkill(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    return reply.send(skill);
  });

  // GET /v1/skills/:skill_id/validate — Harness #2: Validate skill quality with screenshots
  app.get("/v1/skills/:skill_id/validate", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const { url, capture } = req.query as { url?: string; capture?: string };

    let skill = await getSkill(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });

    // Collect endpoint match data
    const validations = skill.endpoints.map((ep) => ({
      endpoint_id: ep.endpoint_id,
      url_template: ep.url_template,
      description: ep.description ?? "N/A",
      has_response_schema: !!ep.response_schema,
      has_description: !!ep.description,
    }));

    const result: Record<string, unknown> = {
      skill_id,
      domain: skill.domain,
      endpoint_count: skill.endpoints.length,
      validations,
      message: "Validation summary. Compare endpoint descriptions with actual page content for quality assessment.",
    };

    // Harness #2: if URL provided + capture=true, take an actual screenshot
    const screenshotUrl = capture === "true" && url ? url : url;
    if (screenshotUrl) {
      let screenshot: string | null = null;
      try {
        const tabId = await kuri.newTab(screenshotUrl);
        if (tabId) {
          // Wait for page to load, then screenshot
          await new Promise((r) => setTimeout(r, 3000));
          screenshot = await kuri.screenshot(tabId);
        }
      } catch {
        // Screenshot may fail (no Kuri available) — continue without it
      }
      if (screenshot) {
        result.screenshot = screenshot;
        result.screenshot_hint = null;
      } else {
        result.screenshot_hint = `Screenshot capture unavailable (Kuri not running?). Browse ${screenshotUrl} manually to compare with endpoint descriptions.`;
      }
    }

    return reply.send(result);
  });

  // POST /v1/skills/:skill_id/review — agent submits reviewed descriptions + synthetic examples
  app.post("/v1/skills/:skill_id/review", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const { endpoints: reviews } = req.body as {
      endpoints: import("../types/index.js").EndpointReviewPayload[];
    };
    if (!reviews?.length) return reply.code(400).send({ error: "endpoints[] required" });

    let skill = await loadSkillForMutation(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });

    const updated = mergeAgentReview(skill.endpoints, reviews);
    skill.endpoints = updated;
    skill.updated_at = new Date().toISOString();
    const updatedWorkflowArtifact = applyWorkflowSchemaReviews(readWorkflowArtifact(skill.skill_id), reviews);
    if (updatedWorkflowArtifact) writeWorkflowArtifact(updatedWorkflowArtifact);

    const indexed = await indexSkillLocally(buildSkillIndexJob(skill, clientScope));
    return reply.send({
      ok: true,
      skill_id: indexed.skill.skill_id,
      endpoints_updated: reviews.length,
      indexed: true,
      publish_status: "indexed",
      endpoint_count: indexed.skill.endpoints.length,
    });
  });

  // POST /v1/skills/:skill_id/index — local-only graph/export recompute from cached state
  app.post("/v1/skills/:skill_id/index", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const skill = await loadSkillForMutation(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });

    const indexed = await indexSkillLocally(buildSkillIndexJob(skill, clientScope));
    return reply.send({
      ok: true,
      skill_id: indexed.skill.skill_id,
      indexed: true,
      publish_status: "indexed",
      endpoint_count: indexed.skill.endpoints.length,
      domain: indexed.domain,
      next_step: `Local contracts re-indexed. Review them, then run ${checkpointPublishCommand(indexed.skill.skill_id)} when you explicitly want remote share.`,
    });
  });

  // POST /v1/skills/:skill_id/publish — two-phase agent-driven publish
  // Phase 1 (no endpoints body): re-index locally, then return endpoints needing descriptions
  // Phase 2 (with endpoints): merge descriptions, re-index locally, then publish remotely
  app.post("/v1/skills/:skill_id/publish", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const { endpoints: reviews, confirm_publish } = (req.body as {
      endpoints?: import("../types/index.js").EndpointReviewPayload[];
      confirm_publish?: boolean;
    }) ?? {};

    let skill = await loadSkillForMutation(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });

    if (reviews?.length) {
      const publishDecision = decideExplicitPublish(skill.domain, confirm_publish === true);
      if (!publishDecision.allowed) {
        return reply.code(409).send({
          error: "publish_confirmation_required",
          domain: skill.domain,
          publish_policy: {
            mode: publishDecision.mode,
            reason: publishDecision.reason,
            matched_domain: publishDecision.matchedDomain,
          },
          next_step: `Re-run ${checkpointPublishCommand(skill.skill_id, true)} only if you own this index.`,
        });
      }
      const updated = mergeAgentReview(skill.endpoints, reviews);
      skill.endpoints = updated;
      skill.updated_at = new Date().toISOString();
      const updatedWorkflowArtifact = applyWorkflowSchemaReviews(readWorkflowArtifact(skill.skill_id), reviews);
      if (updatedWorkflowArtifact) writeWorkflowArtifact(updatedWorkflowArtifact);
      const indexed = await indexSkillLocally(buildSkillIndexJob(skill, clientScope));
      const publishResult = await publishIndexedSkill(indexed);
      return reply.send({
        ok: true,
        skill_id: skill.skill_id,
        endpoints_updated: reviews.length,
        indexed: true,
        published: publishResult.published,
        publish_status: publishResult.publishStatus,
        ...(publishResult.publishedAt ? { published_at: publishResult.publishedAt } : {}),
        ...(publishResult.validationErrors ? { validation_errors: publishResult.validationErrors } : {}),
        next_step: publishResult.publishStatus === "published"
          ? "Remote share completed. Re-run resolve/skill inspection to use the published contract."
          : buildPublishFailureNextStep(skill.skill_id, publishResult.validationErrors),
      });
    }

    const indexed = await indexSkillLocally(buildSkillIndexJob(skill, clientScope));
    const ranked = rankEndpoints(indexed.skill.endpoints, indexed.skill.intent_signature, indexed.skill.domain);
    const endpoints_to_describe = ranked.map((r) => {
      const descriptionMeta = getEndpointDescriptionMetadata(r.endpoint);
      return {
        endpoint_id: r.endpoint.endpoint_id,
        method: r.endpoint.method,
        url: r.endpoint.url_template.length > 120
          ? r.endpoint.url_template.slice(0, 120) + "..."
          : r.endpoint.url_template,
        current_description: descriptionMeta.display,
        description_source: descriptionMeta.source,
        description_needs_review: descriptionMeta.needs_review,
        ...(descriptionMeta.warning ? { description_warning: descriptionMeta.warning } : {}),
        schema_summary: r.endpoint.response_schema
          ? summarizeSchema(r.endpoint.response_schema)
          : null,
        sample_values: extractSampleValues(r.endpoint.semantic?.example_response_compact),
        input_params: r.endpoint.semantic?.requires?.map((b) => ({
          key: b.key,
          type: b.type ?? b.semantic_type,
          required: b.required ?? false,
          example: b.example_value,
        })) ?? [],
        dom_extraction: !!r.endpoint.dom_extraction,
        review_context: buildEndpointReviewContext(indexed.skill, r.endpoint.endpoint_id),
        _fill_description:
          "DESCRIBE THIS ENDPOINT — what it returns, key params, action type, and any audience/eligibility/pricing/validity constraints",
      };
    });

    return reply.send({
      skill_id: indexed.skill.skill_id,
      domain: indexed.skill.domain,
      indexed: true,
      publish_status: "indexed",
      endpoint_count: indexed.skill.endpoints.length,
      endpoints_to_describe,
      next_step:
        `Fill each endpoint's description using review_context (deps, request_schema, response_schema, provenance, trigger page) plus any audience/eligibility/pricing/validity caveats, then call: unbrowse publish --skill ${indexed.skill.skill_id} --endpoints '[{endpoint_id, description, action_kind, resource_kind}]'`,
      _next_step:
        `Fill each endpoint's description using review_context (deps, request_schema, response_schema, provenance, trigger page) plus any audience/eligibility/pricing/validity caveats, then call: unbrowse publish --skill ${indexed.skill.skill_id} --endpoints '[{endpoint_id, description, action_kind, resource_kind}]'`,
    });
  });

  // POST /v1/foundry/publish-bundle — derive bundle/share/host artifacts from one preset
  app.post("/v1/foundry/publish-bundle", async (req, reply) => {
    const { preset_path, site_url, hosts } = (req.body as {
      preset_path?: string;
      site_url?: string;
      hosts?: string[];
    }) ?? {};

    if (!preset_path?.trim()) {
      return reply.code(400).send({ error: "preset_path is required" });
    }

    try {
      const result = publishFoundryBundle({
        presetPath: preset_path,
        ...(site_url?.trim() ? { siteUrl: site_url } : {}),
        ...(Array.isArray(hosts) && hosts.length > 0 ? {
          hosts: hosts.filter((host): host is "codex" | "claude" | "openclaw" =>
            host === "codex" || host === "claude" || host === "openclaw",
          ),
        } : {}),
      });
      return reply.send(result);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
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
    const { params, projection, confirm_unsafe, confirm_third_party_terms, dry_run, intent, context_url, skip_robots_check } = req.body as {
      params?: Record<string, unknown>;
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      confirm_third_party_terms?: boolean;
      dry_run?: boolean;
      intent?: string;
      context_url?: string;
      skip_robots_check?: boolean;
    };
    // Check local caches first: recent skills → domain snapshots → marketplace
    let skill = getRecentLocalSkill(skill_id, clientScope);
    if (!skill) {
      // Check domain snapshot cache — passively indexed skills live here
      const { findExistingSkillForDomain: findLocal } = await import("../client/index.js");
      for (const [, entry] of domainSkillCache) {
        if (entry.skillId === skill_id && entry.localSkillPath) {
          try {
            skill = JSON.parse(require("fs").readFileSync(entry.localSkillPath, "utf-8"));
          } catch { /* snapshot read failed */ }
          break;
        }
      }
    }
    if (!skill) skill = await getSkill(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    const execParams = {
      ...(params ?? {}),
      ...(context_url && typeof params?.url !== "string" ? { url: context_url } : {}),
    };
    try {
      let execResult = await executeSkill(skill, execParams, projection, { confirm_unsafe, confirm_third_party_terms, dry_run, skip_robots_check, intent, contextUrl: context_url, client_scope: clientScope });

      // Auto-recovery: if endpoint_not_found, the local skill cache may be stale
      // or the endpoint was generated by resolve's canonical replay logic.
      if (
        !execResult.trace.success &&
        (execResult.result as Record<string, unknown>)?.error === "endpoint_not_found" &&
        typeof execParams.endpoint_id === "string"
      ) {
        let recovered = false;
        // Try 1: re-fetch from marketplace
        const freshSkill = await getSkill(skill_id, clientScope);
        if (freshSkill && freshSkill.endpoints.some((e) => e.endpoint_id === execParams.endpoint_id)) {
          console.log(`[exec] endpoint ${execParams.endpoint_id} found in fresh marketplace skill — retrying`);
          skill = freshSkill;
          recovered = true;
        }
        // Try 2: resolve may have generated a canonical replay endpoint from context_url
        if (!recovered && context_url) {
          const { buildCanonicalDocumentEndpoint } = await import("../execution/index.js");
          const canonical = buildCanonicalDocumentEndpoint(context_url, intent ?? "", false);
          if (canonical && canonical.endpoint_id === execParams.endpoint_id) {
            console.log(`[exec] endpoint ${execParams.endpoint_id} is a canonical replay — injecting into skill`);
            skill = { ...skill, endpoints: [canonical, ...skill.endpoints] };
            recovered = true;
          }
        }
        // Try 3: D7 — endpoint_id from resolve doesn't match cached skill, but the
        // skill might still have an equivalent endpoint by URL/method. This happens
        // when resolve generates a canonical replay ID and the local cache stores
        // a differently-derived ID for the same target. Match by url_template+method
        // and rewrite execParams.endpoint_id to the cached one. Saves the agent a
        // round-trip just to read available_endpoints and re-call.
        if (!recovered) {
          const wantUrl = (execResult.result as Record<string, unknown>)?.message;
          // Use the available_endpoints already on the error to find a sibling
          // candidate by description match. Fall back to URL-template match.
          const errResult = execResult.result as { available_endpoints?: Array<{ endpoint_id: string; description?: string }> };
          const want = String(execParams.endpoint_id);
          // Prefer the same trigger_url / url_template
          const fromResolve = (skill.endpoints ?? []).find((e) =>
            e.url_template === context_url || e.trigger_url === context_url,
          );
          if (fromResolve && fromResolve.endpoint_id !== want) {
            console.log(`[exec] D7 sibling-by-url: rewriting endpoint_id ${want} → ${fromResolve.endpoint_id}`);
            execParams.endpoint_id = fromResolve.endpoint_id;
            recovered = true;
          } else if (errResult.available_endpoints?.length === 1) {
            // Single-endpoint skills: just use it.
            const only = errResult.available_endpoints[0].endpoint_id;
            console.log(`[exec] D7 single-endpoint skill: rewriting endpoint_id ${want} → ${only}`);
            execParams.endpoint_id = only;
            recovered = true;
          }
        }
        if (recovered) {
          execResult = await executeSkill(skill, execParams, projection, { confirm_unsafe, confirm_third_party_terms, dry_run, skip_robots_check, intent, contextUrl: context_url, client_scope: clientScope });
        }
      }

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
            { confirm_unsafe, confirm_third_party_terms, dry_run, skip_robots_check, intent: intent || skill.intent_signature, client_scope: clientScope }
          );
          saveTrace(freshResult.trace);
          if (freshResult.trace?.skill_id && freshResult.trace?.endpoint_id) {
            recordExecution(freshResult.trace.skill_id, freshResult.trace.endpoint_id, freshResult.trace, skill).catch(() => {});
          }
          await recordAnalyticsSession(buildAnalyticsSessionPayload(freshResult, {
            discovery_queries: 1,
          })).catch(() => {});
          const recovered = attachAgentOutcomeHints({
            ...freshResult,
            _recovery: {
              reason: "stale_endpoint_404",
              original_skill_id: skill_id,
              message: "Original endpoint returned 404. Auto-recovered with fresh capture.",
            },
          } as Record<string, unknown>, {
            skill: freshResult.skill ?? skill,
            endpointId: freshResult.trace.endpoint_id,
            timing: freshResult.timing,
          });
          return reply.send({
            ...recovered,
          });
        } catch {
          // Recovery failed — return original 404 with guidance
        }
      }

      await recordAnalyticsSession(buildAnalyticsSessionPayload(execResult, {
        discovery_queries: 0,
      })).catch(() => {});

      const response = attachAgentOutcomeHints({ ...execResult } as Record<string, unknown>, {
        skill,
        endpointId: execResult.trace.endpoint_id,
      });
      return reply.send(response);
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
      const result = await loginWithBrowserFallback(url, {
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

  // POST /v1/stale/cleanup — verify active skills, mark dead endpoints stale, drop local cache entries
  app.post("/v1/stale/cleanup", async (req, reply) => {
    const body = (req.body ?? {}) as {
      skill_id?: string;
      domain?: string;
      limit?: number;
    };
    try {
      const result = await cleanupStaleSkills({
        skill_id: typeof body.skill_id === "string" ? body.skill_id : undefined,
        domain: typeof body.domain === "string" ? body.domain : undefined,
        limit: typeof body.limit === "number" ? body.limit : undefined,
      });
      return reply.send(result);
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
  app.get("/health", async (_req, reply) => reply.send({
    status: "ok",
    package_version: PACKAGE_VERSION,
    trace_version: TRACE_VERSION,
    code_hash: CODE_HASH,
    git_sha: GIT_SHA,
  }));

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

  // Catch-all proxy: forward unmatched /v1/* routes to the configured backend origin
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

  function requestedSessionId(req: { body?: unknown; query?: unknown }): string | undefined {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : null;
    if (typeof body?.session_id === "string" && body.session_id.trim()) return body.session_id;
    const query = req.query && typeof req.query === "object" ? req.query as Record<string, unknown> : null;
    if (typeof query?.session_id === "string" && query.session_id.trim()) return query.session_id;
    return undefined;
  }

  function sendBrowseSessionError(reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown): unknown {
    if (error instanceof BrowseSessionError) {
      return reply.code(error.statusCode).send({ error: error.code });
    }
    if (isRecoverableBrowseFailure(error)) {
      return reply.code(502).send({
        error: "recoverable_browse_failure",
        message: extractBrowseFailureMessage(error) ?? "recoverable_browse_failure",
        recoverable: true,
      });
    }
    throw error;
  }

  /** Extract registrable domain for auth profile naming */
  function profileName(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown"; }
  }

  async function restartBrowseCapture(session: BrowseSession): Promise<void> {
    const broker = brokerForSession(session);
    // Ensure Kuri is actually responding before starting HAR.
    let ready = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await broker.waitForLoad(session.tabId, 2_000);
        ready = true;
        break;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    if (!ready) {
      // Last resort: try health check instead of waitForLoad
      try { await broker.health(); ready = true; } catch {}
    }
    await broker.networkEnable(session.tabId).catch(() => {});
    await broker.harStart(session.tabId).catch(() => {});
    // Register interceptor as init script so it runs before page JS on every navigation
    // This catches SSR hydration API calls (Reddit GraphQL, etc.) that fire before evaluate()
    await broker.addInitScript(session.tabId, INTERCEPTOR_SCRIPT).catch(() => {});
    await broker.scriptInject(session.tabId, INTERCEPTOR_SCRIPT).catch(() => {});
    session.harActive = true;
    await injectInterceptor(session.tabId).catch(() => {});
  }
  // ── Fix A: in-flight light flush ─────────────────────────────────────
  // Snapshot the active session's HAR + interceptor buffer and write the
  // resulting skill into domainSkillCache, WITHOUT stopping HAR. The session
  // stays alive and continues capturing. Resolve can then read the cache
  // and serve the just-captured route without falling through to live-capture.
  async function lightFlushBrowseCapture(session: BrowseSession): Promise<{
    skill_id: string | null;
    domain: string;
    request_count: number;
    endpoint_count: number;
  }> {
    let harEntries: KuriHarEntry[] = [];
    if (session.harActive) {
      try {
        const broker = brokerForSession(session);
        const stopResult = await broker.harStop(session.tabId);
        harEntries = stopResult.entries ?? [];
        // Immediately restart so capture continues
        try { await broker.harStart(session.tabId); } catch { /* ignore */ }
      } catch { /* non-fatal */ }
    }

    const allRequests = await enrichPassiveCaptureRequests({
      tabId: session.tabId,
      captureUrl: session.url,
      harEntries,
      intent: `browse ${session.domain || profileName(session.url)}`,
    });

    if (allRequests.length === 0) {
      return { skill_id: null, domain: session.domain, request_count: 0, endpoint_count: 0 };
    }

    // Collect JS bundles for token source scanning (same as full flush)
    const jsBundles = new Map<string, string>();
    try {
      const intercepted = await collectInterceptedRequests(session.tabId).catch(() => []);
      for (const entry of intercepted) {
        if (entry.is_js && entry.response_body && jsBundles.size < 20) {
          jsBundles.set(entry.url, entry.response_body);
        }
      }
    } catch { /* best-effort */ }

    const syncResult = await cacheBrowseRequests({
      sessionUrl: session.url,
      sessionDomain: session.domain,
      requests: allRequests,
      getPageHtml: () => brokerForSession(session).getPageHtml(session.tabId),
      jsBundles: jsBundles.size > 0 ? jsBundles : undefined,
      intent: `browse ${session.domain || profileName(session.url)}`,
    });

    // Write domain skill cache so the orchestrator's domain-cache check finds it
    if (syncResult.skill && syncResult.domain) {
      const domainKey = getDomainReuseKey(session.url || syncResult.domain);
      if (domainKey) {
        const cacheKey = scopedCacheKey("local", `${domainKey}:${syncResult.skill.skill_id}`);
        writeSkillSnapshot(cacheKey, syncResult.skill);
        domainSkillCache.set(domainKey, {
          skillId: syncResult.skill.skill_id,
          localSkillPath: snapshotPathForCacheKey(cacheKey),
          ts: Date.now(),
        });
        persistDomainCache();
      }
    }

    return {
      skill_id: syncResult.skill?.skill_id ?? null,
      domain: syncResult.domain,
      request_count: allRequests.length,
      endpoint_count: syncResult.skill?.endpoints.length ?? 0,
    };
  }

  // Find any active session whose domain matches the target URL.
  // Returns the most recently-registered session (Map preserves insertion order).
  function findActiveSessionForDomain(targetUrl: string): BrowseSession | null {
    const targetDomain = getDomainReuseKey(targetUrl);
    if (!targetDomain) return null;
    let match: BrowseSession | null = null;
    for (const session of browseSessions.values()) {
      if (!session.harActive) continue;
      const sessionDomain = getDomainReuseKey(session.url);
      if (sessionDomain === targetDomain) match = session; // last match wins
    }
    return match;
  }

  // ── Fix B: streaming background publish per active session ────────────
  // Per-session debounced timer that periodically light-flushes the capture
  // buffer and queues a background index+publish. Cross-agent reuse no
  // longer waits on close/sync — routes hit the marketplace within seconds
  // of being captured.
  const streamingWatchers = new Map<string, NodeJS.Timeout>();
  const STREAMING_INTERVAL_MS = parseInt(process.env.UNBROWSE_STREAMING_INTERVAL_MS ?? "10000", 10);
  const STREAMING_ENABLED = process.env.UNBROWSE_STREAMING_PUBLISH !== "0";
  // Track last endpoint count per session so we only re-publish on growth.
  const streamingState = new Map<string, { lastEndpointCount: number; lastSkillId: string | null }>();

  function startStreamingWatcher(session: BrowseSession): void {
    if (!STREAMING_ENABLED) return;
    if (streamingWatchers.has(session.sessionId)) return; // idempotent
    streamingState.set(session.sessionId, { lastEndpointCount: 0, lastSkillId: null });
    const tick = async () => {
      // Bail if session was removed while waiting
      if (!browseSessions.has(session.sessionId)) {
        stopStreamingWatcher(session.sessionId);
        return;
      }
      const live = browseSessions.get(session.sessionId);
      if (!live || !live.harActive) return;
      try {
        const flushed = await lightFlushBrowseCapture(live);
        const state = streamingState.get(session.sessionId);
        if (!state) return;
        const grew = flushed.endpoint_count > state.lastEndpointCount
          || (flushed.skill_id && flushed.skill_id !== state.lastSkillId);
        if (grew && flushed.skill_id) {
          state.lastEndpointCount = flushed.endpoint_count;
          state.lastSkillId = flushed.skill_id;
          // Read the skill we just cached and queue a background index+publish
          const domainKey = getDomainReuseKey(live.url || flushed.domain);
          const cacheEntry = domainKey ? domainSkillCache.get(domainKey) : null;
          if (cacheEntry?.localSkillPath) {
            const skill = readSkillSnapshot(cacheEntry.localSkillPath);
            if (skill) {
              const decision = decideCheckpointPublish(flushed.domain);
              queueBackgroundIndex({
                skill: { ...skill },
                domain: flushed.domain,
                intent: skill.intent_signature || `browse ${flushed.domain}`,
                contextUrl: live.url,
                cacheKey: `streaming:${flushed.domain}:${Date.now()}`,
                publishAfterIndex: decision.publishQueued,
              });
              console.log(`[streaming-publish] session=${session.sessionId.slice(0, 8)} domain=${flushed.domain} endpoints=${flushed.endpoint_count} publish=${decision.publishQueued}`);
            }
          }
        }
      } catch (err) {
        console.warn(`[streaming-publish] tick failed: ${(err as Error).message}`);
      }
    };
    const timer = setInterval(() => { void tick(); }, STREAMING_INTERVAL_MS);
    streamingWatchers.set(session.sessionId, timer);
    console.log(`[streaming-publish] watcher started session=${session.sessionId.slice(0, 8)} interval=${STREAMING_INTERVAL_MS}ms`);
  }

  function stopStreamingWatcher(sessionId: string): void {
    const timer = streamingWatchers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      streamingWatchers.delete(sessionId);
    }
    streamingState.delete(sessionId);
  }

  async function flushBrowseCapture(
    session: BrowseSession,
    options: { queueIndex?: boolean; queuePublish?: boolean } = {},
  ): Promise<{
    indexed: boolean;
    mode: "http" | "dom" | "none";
    domain: string;
    skill_id: string | null;
    endpoint_count: number;
    endpoints: Array<{
      endpoint_id: string;
      method: string;
      url_template: string;
      description?: string;
      trigger_url?: string;
      action_kind?: string;
      resource_kind?: string;
    }>;
    request_count: number;
    pipeline: {
      index_queued: boolean;
      publish_queued: boolean;
    };
    publish_policy: {
      mode: "auto" | "disabled" | "blacklisted" | "prompt";
      reason: string;
      matched_domain?: string;
    };
    background_publish_queued: boolean;
  }> {
    let harEntries: KuriHarEntry[] = [];
    if (session.harActive) {
      try {
        const { entries } = await brokerForSession(session).harStop(session.tabId);
        harEntries = entries;
      } catch { /* non-fatal */ }
    }
    session.harActive = false;

    const allRequests = await enrichPassiveCaptureRequests({
      tabId: session.tabId,
      captureUrl: session.url,
      harEntries,
      intent: `browse ${session.domain || profileName(session.url)}`,
    });

    // Collect JS bundle bodies for token source scanning
    const jsBundles = new Map<string, string>();
    try {
      const intercepted = await collectInterceptedRequests(session.tabId).catch(() => []);
      for (const entry of intercepted) {
        if (entry.is_js && entry.response_body && jsBundles.size < 20) {
          jsBundles.set(entry.url, entry.response_body);
        }
      }
    } catch { /* best-effort */ }
    const syncResult = await cacheBrowseRequests({
      sessionUrl: session.url,
      sessionDomain: session.domain,
      requests: allRequests,
      getPageHtml: () => brokerForSession(session).getPageHtml(session.tabId),
      jsBundles: jsBundles.size > 0 ? jsBundles : undefined,
      intent: `browse ${session.domain || profileName(session.url)}`,
    });

    // Persist domain-skill-cache SYNCHRONOUSLY so resolve can find this skill
    // immediately after close, without waiting for background index pipeline.
    if (syncResult.skill && syncResult.domain) {
      const domainKey = getDomainReuseKey(session.url || syncResult.domain);
      if (domainKey) {
        const cacheKey = scopedCacheKey("local", `${domainKey}:${syncResult.skill.skill_id}`);
        writeSkillSnapshot(cacheKey, syncResult.skill);
        domainSkillCache.set(domainKey, {
          skillId: syncResult.skill.skill_id,
          localSkillPath: snapshotPathForCacheKey(cacheKey),
          ts: Date.now(),
        });
        persistDomainCache();
      }
    }

    let indexQueued = false;
    let publishQueued = false;
    const publishDecision = options.queuePublish
      ? decideCheckpointPublish(syncResult.domain)
      : {
          publishQueued: false,
          mode: "disabled" as const,
          reason: "Remote publish not requested for this checkpoint.",
        };
    if (options.queueIndex) {
      if (syncResult.skill) {
        queueBackgroundIndex({
          skill: { ...syncResult.skill },
          domain: syncResult.domain,
          intent: syncResult.skill.intent_signature || `browse ${syncResult.domain}`,
          contextUrl: session.url,
          cacheKey: `browse-submit:${syncResult.domain}:${Date.now()}`,
          publishAfterIndex: publishDecision.publishQueued,
        });
        indexQueued = true;
        publishQueued = publishDecision.publishQueued;
      } else if (allRequests.length > 0) {
        passiveIndexFromRequests(allRequests, session.url, {
          publishAfterIndex: publishDecision.publishQueued,
        });
        indexQueued = true;
        publishQueued = publishDecision.publishQueued;
      }
    }
    return {
      indexed: syncResult.indexed,
      mode: syncResult.mode,
      domain: syncResult.domain,
      skill_id: syncResult.skill?.skill_id ?? null,
      endpoint_count: syncResult.skill?.endpoints.length ?? 0,
      endpoints: (syncResult.skill?.endpoints ?? []).map((endpoint) => ({
        endpoint_id: endpoint.endpoint_id,
        method: endpoint.method,
        url_template: endpoint.url_template,
        description: endpoint.description,
        trigger_url: endpoint.trigger_url,
        action_kind: endpoint.semantic?.action_kind,
        resource_kind: endpoint.semantic?.resource_kind,
      })),
      request_count: allRequests.length,
      pipeline: {
        index_queued: indexQueued,
        publish_queued: publishQueued,
      },
      publish_policy: {
        mode: publishDecision.mode,
        reason: publishDecision.reason,
        ...(publishDecision.matchedDomain ? { matched_domain: publishDecision.matchedDomain } : {}),
      },
      background_publish_queued: publishQueued,
    };
  }

  // POST /v1/browse/go — navigate to URL
  app.post("/v1/browse/go", async (req, reply) => {
    const { url } = req.body as { url: string };
    if (!url) return reply.code(400).send({ error: "url required" });
    try {
      const sessionId = requestedSessionId(req);
      const browseClient = selectBrowseBrokerClient(sessionId);
      const navigateSession = async (session: BrowseSession) => {
        const broker = brokerForSession(session);
        const newDomain = profileName(url);

        if (session.harActive && session.url !== "about:blank") {
          try {
            const { entries } = await broker.harStop(session.tabId);
            passiveIndexHar(entries, session.url, { publishAfterIndex: false });
          } catch { /* non-fatal */ }
          session.harActive = false;
        }

        if (session.domain && session.domain !== newDomain) {
          await saveAuthProfileBestEffort(session.tabId, session.domain, "browse_go");
        }

        let cookiesInjected = 0;
        if (newDomain && newDomain !== session.domain) {
          // Check if the browser already has fresh session cookies for this domain.
          // If so, skip vault/profile cookie injection — browser cookies are fresher
          // and injecting stale vault cookies (e.g. JSESSIONID) causes HTTP 400 on
          // sites like LinkedIn that validate CSRF alignment.
          const browserHasFreshSession = await (async () => {
            try {
              const { extractBrowserCookies } = await import("../auth/browser-cookies.js");
              const { cookies } = extractBrowserCookies(newDomain);
              // Consider the session fresh if we have session-like cookies that aren't expired
              const now = Date.now() / 1000;
              return cookies.some((c) =>
                (c.httpOnly || c.secure) && (!c.expires || c.expires > now),
              );
            } catch { return false; }
          })();

          if (browserHasFreshSession) {
            cookiesInjected = await importBrowserCookiesIntoTab(session.tabId, newDomain);
          } else {
            cookiesInjected = await importBrowserCookiesIntoTab(session.tabId, newDomain);
            await loadAuthProfileBestEffort(session.tabId, newDomain, "browse_go");
          }
          // Also inject Google OAuth cookies so "Login with Google" auto-completes.
          // Many sites use Google OAuth and the user may be logged into Google in another browser.
          if (cookiesInjected === 0) {
            const googleInjected = await importBrowserCookiesIntoTab(session.tabId, "google.com");
            const accountsInjected = await importBrowserCookiesIntoTab(session.tabId, "accounts.google.com");
            if (googleInjected > 0 || accountsInjected > 0) {
              console.log(`[auth] injected ${googleInjected + accountsInjected} Google OAuth cookies for potential SSO`);
            }
          }
        }

        await restartBrowseCapture(session);

        try {
          await broker.navigate(session.tabId, url);
        } catch (navError: unknown) {
          // Navigate can throw on slow sites (challenge pages, redirect chains)
          // even though the page actually loaded. Check if the tab is alive
          // and landed on the intended domain before giving up.
          const msg = navError instanceof Error ? navError.message : String(navError);
          const isTimeoutOrAbort =
            /abort|timeout|operation was aborted/i.test(msg);
          if (!isTimeoutOrAbort) throw navError;

          const probe = await broker
            .evaluate(
              session.tabId,
              "JSON.stringify({url:location.href,title:document.title,ready:document.readyState})",
            )
            .catch(() => null);

          let pageLoaded = false;
          if (probe && typeof probe === "string") {
            try {
              const info = JSON.parse(probe) as {
                url: string;
                title: string;
                ready: string;
              };
              const targetDomain = profileName(url);
              const actualDomain = profileName(info.url);
              pageLoaded =
                info.url.startsWith("http") &&
                actualDomain === targetDomain &&
                info.title.length > 0;
            } catch {
              /* parse failed — treat as not loaded */
            }
          }
          if (!pageLoaded) throw navError;
          // Page is actually loaded — continue the flow normally
        }

        const finalUrl = await broker.getCurrentUrl(session.tabId).catch(() => url);
        session.url = typeof finalUrl === "string" && finalUrl.startsWith("http") ? finalUrl : url;
        session.domain = profileName(session.url);
        await injectInterceptor(session.tabId);

        // Auto-scroll to trigger lazy-loaded content and SPA data API calls
        // (e.g. Crunchbase, LinkedIn feed cards that only fire on scroll)
        try {
          await broker.evaluate(session.tabId, "window.scrollTo(0, document.body.scrollHeight)");
          await new Promise((r) => setTimeout(r, 2500));
          await broker.evaluate(session.tabId, "window.scrollTo(0, 0)");
        } catch { /* non-fatal — page may not support scroll */ }

        const stillLive = await isBrowseSessionLive(session, browseClient).catch(() => false);
        if (!stillLive) throw { error: "CDP command failed" };

        return { cookiesInjected };
      };

      let session: BrowseSession;
      let result: { cookiesInjected: number };
      if (sessionId) {
        const navigated = await withSerializedStrictBrowseSession(
          browseSessions,
          browseClient,
          sessionId,
          navigateSession,
        );
        session = navigated.session;
        result = navigated.result;
      } else {
        session = await getOrCreateNavigateBrowseSession(
          browseSessions,
          browseClient,
          injectInterceptor,
        );
        result = await navigateSession(session);
      }

      // Detect auth walls — if the page is asking for login, flag it so the
      // agent (or auto-login) can handle it without a separate manual command.
      let authRequired = false;
      let authHint: string | undefined;
      try {
        const broker = brokerForSession(session);
        const authProbe = await broker.evaluate(
          session.tabId,
          `JSON.stringify({
            hasLoginBtn: !!(document.querySelector('[data-testid*="login"], [class*="login"], a[href*="login"], button[class*="sign"]')),
            loginText: (document.body.innerText.match(/log\\s*in|sign\\s*in|sign\\s*up/i) || [])[0] || null,
            url: location.href
          })`,
        ).catch(() => null);
        if (authProbe && typeof authProbe === "string") {
          const info = JSON.parse(authProbe);
          if (info.hasLoginBtn || info.loginText) {
            authRequired = true;
            authHint = `Page requires authentication. Use \`unbrowse snap --filter interactive\` to find the login button, then \`unbrowse click <ref>\` to start the login flow. Session cookies from ${session.domain} will be saved automatically on close.`;
          }
        }
      } catch { /* non-fatal */ }

      // Fix B: kick off streaming background publish for this session
      startStreamingWatcher(session);

      return reply.send({
        ok: true,
        session_id: session.sessionId,
        url: session.url,
        tab_id: session.tabId,
        auth_profile: session.domain,
        ...(result.cookiesInjected > 0 ? { cookies_injected: result.cookiesInjected } : {}),
        ...(authRequired ? { auth_required: true, auth_hint: authHint } : {}),
        // Autonomy signals — agents read these to judge whether the system is
        // capturing in the background as advertised. No separate "verify" verb;
        // every go response is self-describing.
        autonomy: {
          har_active: session.harActive,
          streaming_publish_active: streamingWatchers.has(session.sessionId),
          attached_existing_chrome: result.attachedExistingChrome ?? false,
          chrome_debug_url: process.env.CHROME_DEBUG_URL ?? null,
          inspect_buffer: `GET ${process.env.UNBROWSE_API_BASE ?? "http://127.0.0.1:6969"}/v1/browse/sessions/${session.sessionId}/buffer`,
        },
      });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/submit — submit active form; same-origin fetch+rehydrate is explicit opt-in
  app.post("/v1/browse/submit", async (req, reply) => {
    const {
      form_selector: formSelector,
      submit_selector: submitSelector,
      wait_for: waitFor,
      same_origin_fetch_fallback: sameOriginFetchFallback,
      timeout_ms: timeoutMs,
      assist_site_state: assistSiteState,
    } = (req.body as {
      form_selector?: string;
      submit_selector?: string;
      wait_for?: string;
      same_origin_fetch_fallback?: boolean;
      timeout_ms?: number;
      assist_site_state?: boolean;
    }) ?? {};

    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => submitBrowseForm(
          {
            client: brokerForSession(session),
            session,
            flushCapture: async (session) => await flushBrowseCapture(session, { queueBackgroundPublish: false }),
            flushCapture: async (session) => await flushBrowseCapture(session, { queueBackgroundPublish: false }),
            restartCapture: restartBrowseCapture,
            rehydratePlugins: (tabId) => brokerForSession(session).bestEffortRehydratePlugins(tabId),
          },
          {
            formSelector,
            submitSelector,
            waitFor,
            sameOriginFetchFallback,
            timeoutMs,
            assistSiteState,
          },
        ),
        (result) => !result.ok && result.recoverable === true,
      );

      let activeSession = session;
      const hintedDestination = result.wait_for && isUrlWaitHint(result.wait_for)
        ? resolveSubmitWaitHint(activeSession.url || "about:blank", result.wait_for)
        : null;
      const rawResultUrl = typeof result.url === "string" ? result.url : "";
      activeSession.url = rawResultUrl || await brokerForSession(activeSession).getCurrentUrl(activeSession.tabId).catch(() => activeSession.url);
      if (result.ok && hintedDestination && (!rawResultUrl || !rawResultUrl.includes(result.wait_for ?? ""))) {
        activeSession.url = hintedDestination;
      }
      activeSession.domain = profileName(activeSession.url);
      const stillLive = await isBrowseSessionLive(activeSession, browseClient).catch(() => false);
      if (!stillLive) {
        stopStreamingWatcher(activeSession.sessionId);
        removeBrowseSession(browseSessions, activeSession.sessionId);
        throw new BrowseSessionError("session_expired");
      }

      const statusCode = result.ok ? 200 : (result.recoverable ? 502 : 400);
      const sessionHint = `--session ${activeSession.sessionId}`;
      const nextStep = result.ok
        ? `If more UI steps remain, continue the flow. Run \`unbrowse sync ${sessionHint}\` after meaningful transitions, then \`unbrowse close ${sessionHint}\` when you're done to checkpoint the final capture, save auth, and queue the background pipeline.`
        : `Inspect the page state with \`unbrowse snap ${sessionHint} --filter interactive\`, then retry submit with selectors or a wait hint if needed.`;
      return reply.code(statusCode).send({
        ...result,
        session_id: activeSession.sessionId,
        next_step: nextStep,
        recovered: false,
        tab_id: activeSession.tabId,
        url: activeSession.url,
      });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/snap — a11y snapshot
  app.post("/v1/browse/snap", async (req, reply) => {
    const { filter } = (req.body as { filter?: string; session_id?: string }) ?? {};
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result: snapshot } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => brokerForSession(session).snapshot(session.tabId, filter),
      );
      return reply.send({ snapshot, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/click — click by ref
  app.post("/v1/browse/click", async (req, reply) => {
    const { ref } = req.body as { ref: string; session_id?: string };
    if (!ref) return reply.code(400).send({ error: "ref required" });
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          await brokerForSession(session).click(session.tabId, ref);
          return true;
        },
      );
      await isBrowseSessionLive(session, browseClient).catch(() => false);
      return reply.send({ ok: true, session_id: session.sessionId, tab_id: session.tabId, url: session.url });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/fill — fill input by ref
  app.post("/v1/browse/fill", async (req, reply) => {
    const { ref, value } = req.body as { ref: string; value: string; session_id?: string };
    if (!ref || value === undefined) return reply.code(400).send({ error: "ref and value required" });
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          await brokerForSession(session).fill(session.tabId, ref, value);
          return true;
        },
      );
      return reply.send({ ok: true, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/type — keyboard type
  app.post("/v1/browse/type", async (req, reply) => {
    const { text } = req.body as { text: string; session_id?: string };
    if (!text) return reply.code(400).send({ error: "text required" });
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          await brokerForSession(session).keyboardType(session.tabId, text);
          return true;
        },
      );
      return reply.send({ ok: true, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/press — press key
  app.post("/v1/browse/press", async (req, reply) => {
    const { key } = req.body as { key: string; session_id?: string };
    if (!key) return reply.code(400).send({ error: "key required" });
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          await brokerForSession(session).press(session.tabId, key);
          return true;
        },
      );
      return reply.send({ ok: true, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/select — select option by ref
  app.post("/v1/browse/select", async (req, reply) => {
    const { ref, value } = req.body as { ref: string; value: string; session_id?: string };
    if (!ref || value === undefined) return reply.code(400).send({ error: "ref and value required" });
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          await brokerForSession(session).select(session.tabId, ref, value);
          return true;
        },
      );
      return reply.send({ ok: true, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/scroll — scroll
  app.post("/v1/browse/scroll", async (req, reply) => {
    const { direction, amount } = (req.body as { direction?: string; amount?: number; session_id?: string }) ?? {};
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          await brokerForSession(session).scroll(session.tabId, (direction as any) ?? "down", amount);
          return true;
        },
      );
      return reply.send({ ok: true, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // GET /v1/browse/screenshot — capture screenshot
  app.get("/v1/browse/screenshot", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result: data } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => brokerForSession(session).screenshot(session.tabId),
      );
      return reply.send({ screenshot: data, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // GET /v1/browse/text — page text
  app.get("/v1/browse/text", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result: text } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => brokerForSession(session).getText(session.tabId),
      );
      return reply.send({ text, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // GET /v1/browse/markdown — page as markdown
  app.get("/v1/browse/markdown", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result: markdown } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => brokerForSession(session).getMarkdown(session.tabId),
      );
      return reply.send({ markdown, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // GET /v1/browse/cookies — page cookies
  app.get("/v1/browse/cookies", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result: cookies } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => brokerForSession(session).getCookies(session.tabId),
      );
      return reply.send({ cookies, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/eval — evaluate JS
  app.post("/v1/browse/eval", async (req, reply) => {
    const { expression } = req.body as { expression: string; session_id?: string };
    if (!expression) return reply.code(400).send({ error: "expression required" });
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => brokerForSession(session).evaluate(session.tabId, expression),
      );
      return reply.send({ result, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/back — navigate back
  app.post("/v1/browse/back", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          await brokerForSession(session).goBack(session.tabId);
          return true;
        },
      );
      return reply.send({ ok: true, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/forward — navigate forward
  app.post("/v1/browse/forward", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          await brokerForSession(session).goForward(session.tabId);
          return true;
        },
      );
      return reply.send({ ok: true, session_id: session.sessionId, tab_id: session.tabId });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/sync — checkpoint capture, keep the tab open, queue index+publish
  app.post("/v1/browse/sync", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result: syncResult } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          const syncResult = await flushBrowseCapture(session, { queueIndex: true, queuePublish: true });
          await restartBrowseCapture(session);
          return syncResult;
        },
      );

      return reply.send({
        ok: true,
        checkpointed: true,
        session_id: session.sessionId,
        tab_id: session.tabId,
        indexed: syncResult.indexed,
        mode: syncResult.mode,
        domain: syncResult.domain,
        skill_id: syncResult.skill_id,
        endpoint_count: syncResult.endpoint_count,
        endpoints: syncResult.endpoints,
        request_count: syncResult.request_count,
        pipeline: syncResult.pipeline,
        publish_policy: syncResult.publish_policy,
        background_publish_queued: syncResult.background_publish_queued,
        next_step: buildCheckpointNextStep("sync", syncResult, session.sessionId),
      });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // POST /v1/browse/close — checkpoint capture, queue index+publish, save auth, close tab
  app.post("/v1/browse/close", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result: syncResult } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          const broker = brokerForSession(session);
          if (session.domain) {
            await saveAuthProfileBestEffort(session.tabId, session.domain, "browse_close");
          }
          const syncResult = await flushBrowseCapture(session, { queueIndex: true, queuePublish: true });
          stopStreamingWatcher(session.sessionId);
          await broker.closeTab(session.tabId).catch(() => {});
          removeBrowseSession(browseSessions, session.sessionId);
          return syncResult;
        },
      );
      return reply.send({
        ok: true,
        checkpointed: true,
        session_id: session.sessionId,
        indexed: syncResult.indexed,
        mode: syncResult.mode,
        endpoint_count: syncResult.endpoint_count,
        request_count: syncResult.request_count,
        pipeline: syncResult.pipeline,
        publish_policy: syncResult.publish_policy,
        background_publish_queued: syncResult.background_publish_queued,
        auth_saved: session.domain || null,
        next_step: buildCheckpointNextStep("close", syncResult, session.sessionId),
      });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });
}

function saveTrace(trace: unknown) {
  if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true });
  const t = trace as { trace_id: string };
  writeFileSync(join(TRACES_DIR, `${t.trace_id}.json`), JSON.stringify(trace, null, 2));
}
