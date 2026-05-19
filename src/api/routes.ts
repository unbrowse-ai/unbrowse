import type { FastifyInstance } from "fastify";
import * as os from "os";
import * as path from "path";
import { readdirSync, readFileSync } from "fs";
import * as kuri from "../kuri/client.js";
import type { KuriHarEntry } from "../kuri/client.js";
import { extractEndpoints, extractAuthHeaders } from "../reverse-engineer/index.js";
import { INTERCEPTOR_SCRIPT, enrichPassiveCaptureRequests, injectInterceptor, collectInterceptedRequests, enableNetworkHeaderCapture, getCapturedNetworkHeadersAsRequests, type RawRequest } from "../capture/index.js";
import { indexSkillLocally, mergeAgentReview, publishIndexedSkill, queueBackgroundIndex } from "../indexer/index.js";
import { getCaptureSpoolDir, writeCaptureSpool, type CaptureSpoolEnvelope } from "../indexer/capture-spool.js";
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
import { getContributionConfig, setContributionConfig, type ContributionConfig } from "../config/contribution.js";
import { getSkill } from "../marketplace/index.js";
import { getPopularUnreviewedSkills, getMyContributions, computeMilestoneState } from "../marketplace/popular-unreviewed.js";
import { getRecentTraces } from "../graph/trace-store.js";
import { executeSkill } from "../execution/index.js";
import { rankEndpoints } from "../ranking/index.js";
import {
  extractBrowserAuth,
  importBrowserCookiesIntoTab,
  loginWithBrowserFallback,
  loadAuthProfileBestEffort,
  saveAuthProfileBestEffort,
} from "../auth/index.js";
import { consumeDashboardPairingToken, recordFeedback, recordDiagnostics, recordExecution, getApiKey, getAgentId, getRecentLocalSkill, recordAnalyticsSession, listSkills, type AnalyticsSessionPayload } from "../client/index.js";
import { ROUTE_LIMITS } from "../ratelimit/index.js";
import { listRecentSessionsForDomain } from "../session-logs.js";
import { attachAgentOutcomeHints } from "../agent-outcome.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { writeDomainNote, readDomainNote } from "../extraction/domain-notes.js";
import { buildStructuredDataHeader } from "../extraction/index.js";
import {
  BrowseSessionError,
  buildSnapResponse,
  createRegisteredBrowseSession,
  extractBrowseFailureMessage,
  getOrCreateNavigateBrowseSession,
  isBrowseSessionLive,
  isRecoverableBrowseFailure,
  type BrowseSession,
  withSerializedStrictBrowseSession,
  removeBrowseSession,
} from "./browse-session.js";
import { cacheBrowseRequests, harEntriesToRawRequests, type CaptureDiagnostic } from "./browse-index.js";
import { readActiveSessions } from "./session-store.js";
import { isUrlWaitHint, resolveSubmitWaitHint, submitBrowseForm } from "./browse-submit.js";
import { AUTH_PROBE_JS, classifyAuthSignals, type AuthProbeResult } from "./auth-detection.js";
import { diagnoseSnapshot } from "./browse-snap-diagnostics.js";
import { cleanupStaleSkills } from "../stale-cleanup-runner.js";
import {
  decideCheckpointPublish,
  decideExplicitPublish,
  getCapturePipelineSettings,
  updateCapturePipelineSettings,
  getBrowserAttachEnabled,
  setBrowserAttachEnabled,
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
export function passiveIndexFromRequests(
  requests: RawRequest[],
  pageUrl: string,
  options: { publishAfterIndex?: boolean } = {},
): Promise<void> {
  if (requests.length === 0) return Promise.resolve();

  let domain: string;
  try { domain = new URL(pageUrl).hostname; } catch { return Promise.resolve(); }
  const intent = `browse ${domain}`;

  // Returns the inner pipeline's promise so the drain bridge can await
  // durability; legacy fire-and-forget callers discard `Promise<void>` safely.
  return (async () => {
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

/**
 * Number of registered browse sessions. Exposed for the mcp-serve idle
 * reaper — when this is zero AND no HTTP activity for UNBROWSE_SERVE_IDLE_MS,
 * the daemon self-exits to stop zombie-process accumulation.
 */
export function getBrowseSessionCount(): number {
  return browseSessions.size;
}

/**
 * Test-only: clear the in-memory browse session Map. Does NOT touch
 * sessions.jsonl. Used by tests to reset module state between cases.
 */
export function __clearBrowseSessionsForTest(): void {
  browseSessions.clear();
}

/**
 * Rehydrate browse sessions from ~/.unbrowse/sessions.jsonl into the
 * in-memory Map. Called on daemon startup so active sessions survive
 * mcp-serve restarts (reaper, crash, OOM). Dead tabs are caught lazily
 * by `isBrowseSessionLive` on first use — we don't probe Kuri here
 * because Kuri may not be up yet at server-bootstrap time.
 *
 * Skips the `client` field — that's rebuilt lazily from brokerPort via
 * `brokerForSession` when the session is next touched.
 */
export function rehydrateBrowseSessions(): { restored: number } {
  let restored = 0;
  try {
    for (const s of readActiveSessions()) {
      if (browseSessions.has(s.sessionId)) continue;
      browseSessions.set(s.sessionId, {
        sessionId: s.sessionId,
        tabId: s.tabId,
        url: s.url,
        domain: s.domain,
        harActive: s.harActive,
        brokerPort: s.brokerPort,
        // client is undefined — brokerForSession will resolve it from brokerPort
      });
      restored++;
    }
  } catch (err) {
    console.warn(`[session-store] rehydrate failed: ${(err as Error).message}`);
  }
  return { restored };
}
const inspectedHarEntries = new Map<string, KuriHarEntry[]>();

function rememberInspectedHarEntries(sessionId: string, entries: KuriHarEntry[]): void {
  if (entries.length === 0) return;
  const existing = inspectedHarEntries.get(sessionId) ?? [];
  inspectedHarEntries.set(sessionId, [...existing, ...entries]);
}

function drainInspectedHarEntries(sessionId: string): KuriHarEntry[] {
  const entries = inspectedHarEntries.get(sessionId) ?? [];
  inspectedHarEntries.delete(sessionId);
  return entries;
}

function browseBrokerPorts(): number[] {
  return Array.from({ length: BROWSE_BROKER_MAX }, (_, index) => BROWSE_BROKER_BASE_PORT + index);
}

function brokerForSession(session: BrowseSession | undefined): kuri.KuriClient {
  if (session?.client) return session.client as kuri.KuriClient;
  if (session?.brokerPort !== undefined) return kuri.getKuriClient(session.brokerPort);
  return kuri.getKuriClient();
}

// Per-session Kuri isolation (opt-in, default OFF). With
// UNBROWSE_PER_SESSION_KURI set, every NEW browse session gets its own Kuri
// broker on a dedicated port instead of load-balancing the fixed
// BROWSE_BROKER_MAX pool. A distinct port is a distinct brokerCreateQueues key
// (browse-session.ts withBrokerCreateLock), so concurrent /v1/browse/go calls
// stop serializing through one create-lock and stop cross-binding tabs (the
// conc>6 gate-collector corruption, .bench-gate/20260517T102334Z). Dedicated
// ports sit above the pool base; startOn() free-port-resolves a requested port
// if it is occupied, so a stale cursor value never collides on the wire.
// Allocation is synchronous: selectBrowseBrokerClient has no await before it
// returns, so concurrent callers each take a unique cursor value atomically on
// the single-threaded event loop.
const PER_SESSION_BROKER_BASE_PORT = BROWSE_BROKER_BASE_PORT + 100;
let perSessionBrokerCursor = 0;

function perSessionKuriEnabled(): boolean {
  const v = process.env.UNBROWSE_PER_SESSION_KURI;
  return v === "1" || v?.toLowerCase() === "true";
}

function allocatePerSessionBrokerPort(): number {
  return PER_SESSION_BROKER_BASE_PORT + perSessionBrokerCursor++;
}

export function selectBrowseBrokerClient(requestedSessionId?: string): kuri.KuriClient {
  if (requestedSessionId) {
    const existing = browseSessions.get(requestedSessionId);
    if (existing?.client) return existing.client as kuri.KuriClient;
    if (existing) return brokerForSession(existing);
    // Explicit session_id with no existing match: caller declared "this is a
    // new isolated session" (typical of parallel MCP sub-agents / gate
    // collectors). Always dedicate a fresh broker port so concurrent named
    // sessions cannot cross-bind on the pool broker. The previous opt-in
    // env-flag default left this on port 7700 and the 4-probe parallel MCP
    // falsifier showed 50% session loss; isolating by named-session honors
    // the caller's contract without forcing an env flag.
    return kuri.getKuriClient(allocatePerSessionBrokerPort());
  }

  if (perSessionKuriEnabled()) {
    // NEW unnamed session under per-session isolation: dedicate a fresh broker.
    return kuri.getKuriClient(allocatePerSessionBrokerPort());
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
    const reviewCommand = result.skill_id
      ? `unbrowse_review --skill ${result.skill_id} ...`
      : "unbrowse_review with skill id from this response";
    const publishCommand = checkpointPublishCommand(
      result.skill_id,
      result.publish_policy.mode === "blacklisted" || result.publish_policy.mode === "prompt",
    );

    if (!result.pipeline.index_queued) {
      return action === "sync"
        ? `Checkpoint recorded, but no new capture was available to index. Continue browsing, then run \`unbrowse close${sessionHint}\` for the final checkpoint.`
        : "Final checkpoint recorded, but no new capture was available to index or publish.";
    }

    const sharePointers = getContributionConfig().contribution.share_pointers;

    if (result.publish_policy.mode === "auto") {
      if (!sharePointers) {
        return action === "sync"
          ? `Checkpoint saved. Local index queued. share_pointers=false (private) — nothing publishes to the public marketplace. Run \`${reviewCommand}\` to enrich descriptions locally, or flip to public via \`unbrowse_settings share_pointers=true\` to earn x402 rewards. Continue browsing then \`unbrowse close${sessionHint}\`.`
          : `Final checkpoint saved. Local index queued. share_pointers=false (private) — nothing publishes to the public marketplace. Run \`${reviewCommand}\` to enrich descriptions locally, or flip to public via \`unbrowse_settings share_pointers=true\` to earn x402 rewards on execution. Rewards land in your wallet — run \`unbrowse setup\` to pair one if you have not already.`;
      }
      return action === "sync"
        ? `Checkpoint saved. Local index queued. Public marketplace publish is GATED on review — call \`${reviewCommand}\` to ship (you are opted in by default: reviewed skills publish publicly and earn x402 rewards in your wallet — pair one via \`unbrowse setup\` if needed). To keep this domain private instead, call \`unbrowse_settings share_pointers=false\` BEFORE review. Continue browsing then \`unbrowse close${sessionHint}\`.`
        : `Final checkpoint saved. Local index queued. Public marketplace publish is GATED on review — call \`${reviewCommand}\` to ship (you are opted in by default: reviewed skills publish publicly and earn x402 rewards in your wallet — pair one via \`unbrowse setup\` if needed). To keep this domain private instead, call \`unbrowse_settings share_pointers=false\` BEFORE review.`;
    }

    const base = result.publish_policy.mode === "disabled"
      ? "Checkpoint saved. Local index queued, but auto-publish is disabled in settings."
      : `Checkpoint saved. Local index queued, but auto-publish did not run: ${result.publish_policy.reason}`;

    const suffix = result.skill_id
      ? ` Review the indexed contract via \`${reviewCommand}\`, then run \`${publishCommand}\` only if you own this index.`
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
    const contributionCfg = getContributionConfig();

    // Best-effort upstream fetch of the per-agent sponsor status. The local
    // settings endpoint must stay responsive even when the backend is down,
    // so failures fall through to a degraded-but-honest shape (enabled=false,
    // zero spend, zero remaining) instead of bubbling a 502 to the MCP caller.
    // The agent's API key is forwarded so the backend can scope the bucket to
    // this caller — there is no cross-agent leakage path.
    let sponsorStatus: {
      enabled: boolean;
      cap_daily_usd: number;
      spent_today_usd: number;
      remaining_today_usd: number;
      global_cap_daily_usd: number;
      global_spent_today_usd: number;
    } = {
      enabled: false,
      cap_daily_usd: 0,
      spent_today_usd: 0,
      remaining_today_usd: 0,
      global_cap_daily_usd: 0,
      global_spent_today_usd: 0,
    };
    try {
      const apiKey = getApiKey();
      if (apiKey) {
        const res = await fetch(`${BETA_API_URL}/v1/account/sponsor-status`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) {
          const parsed = await res.json() as Partial<typeof sponsorStatus>;
          sponsorStatus = {
            enabled: !!parsed.enabled,
            cap_daily_usd: Number(parsed.cap_daily_usd ?? 0),
            spent_today_usd: Number(parsed.spent_today_usd ?? 0),
            remaining_today_usd: Number(parsed.remaining_today_usd ?? 0),
            global_cap_daily_usd: Number(parsed.global_cap_daily_usd ?? 0),
            global_spent_today_usd: Number(parsed.global_spent_today_usd ?? 0),
          };
        }
      }
    } catch {
      // Degraded mode — see comment above; we return the zeroed shape.
    }

    // Best-effort earnings summary, parallel to sponsor status. Same
    // degraded-shape pattern: backend down → zeros, not 502. Kept compact
    // (totals + milestones only) so the GET response stays small; the
    // dedicated `/v1/account/earnings` route returns the full breakdown.
    let earningsSummary: {
      total_earned_usd: number;
      creator_earned_usd: number;
      indexer_credited_usd: number;
      transaction_count: number;
      next_milestone_usd: number | null;
      progress_to_next_pct: number;
    } = {
      total_earned_usd: 0,
      creator_earned_usd: 0,
      indexer_credited_usd: 0,
      transaction_count: 0,
      next_milestone_usd: 1,
      progress_to_next_pct: 0,
    };
    try {
      const apiKey = getApiKey();
      const agentId = getAgentId();
      if (apiKey && agentId) {
        const headers = { Authorization: `Bearer ${apiKey}` };
        const [creatorRes, indexerRes] = await Promise.all([
          fetch(`${BETA_API_URL}/v1/transactions/creator/${encodeURIComponent(agentId)}`, { headers }).catch(() => null),
          fetch(`${BETA_API_URL}/v1/attribution/indexer/${encodeURIComponent(agentId)}`, { headers }).catch(() => null),
        ]);
        const creatorJson = creatorRes?.ok ? await creatorRes.json().catch(() => null) as Record<string, unknown> | null : null;
        const indexerJson = indexerRes?.ok ? await indexerRes.json().catch(() => null) as Record<string, unknown> | null : null;
        const creatorLedger = (creatorJson?.ledger && typeof creatorJson.ledger === "object") ? creatorJson.ledger as Record<string, unknown> : null;
        const creatorEarned = Number(creatorLedger?.total_earned_usd ?? 0);
        const indexerCredited = Number(indexerJson?.total_credited_usd ?? 0);
        const total = creatorEarned + indexerCredited;
        const milestoneRungs = [1, 10, 100, 1000];
        const nextMilestone = milestoneRungs.find((m) => total < m) ?? null;
        earningsSummary = {
          total_earned_usd: Number(total.toFixed(6)),
          creator_earned_usd: creatorEarned,
          indexer_credited_usd: indexerCredited,
          transaction_count: Number(creatorLedger?.transaction_count ?? 0),
          next_milestone_usd: nextMilestone,
          progress_to_next_pct: nextMilestone ? Math.min(100, Math.round((total / nextMilestone) * 100)) : 100,
        };
      }
    } catch {
      // Degraded shape — earningsSummary already initialized to zeros.
    }

    return reply.send({
      capture_pipeline: getCapturePipelineSettings(),
      browser: { attach_existing_chrome: getBrowserAttachEnabled() },
      contribution: {
        share_pointers: contributionCfg.contribution.share_pointers,
        auto_review: contributionCfg.contribution.auto_review,
        set_via: contributionCfg.contribution.set_via,
        ...(contributionCfg.contribution.set_at ? { set_at: contributionCfg.contribution.set_at } : {}),
      },
      marketplace_visibility: contributionCfg.contribution.share_pointers ? "public" : "private",
      sponsor_status: sponsorStatus,
      earnings_summary: earningsSummary,
    });
  });


  // GET /v1/account/earnings — aggregate user-side earnings (creator payouts +
  // indexer attribution). Proxies upstream ledgers so the agent has a single
  // surface. When `verbose=true`, also lists per-skill contributions with
  // execution counts so the agent can see WHICH skills are paying.
  app.get("/v1/account/earnings", async (req, reply) => {
    const q = req.query as { verbose?: string | boolean };
    const verbose = q.verbose === true || q.verbose === "true" || q.verbose === "1";
    const apiKey = getApiKey();
    const agentId = getAgentId();

    if (!agentId) {
      return reply.send({
        ok: false,
        registered: false,
        total_earned_usd: 0,
        next_step: "Not paired yet. Run `unbrowse setup` to register an agent. Earnings start accruing once you publish a skill that other agents execute.",
      });
    }

    const fetchJson = async (path: string): Promise<unknown | null> => {
      try {
        const headers: Record<string, string> = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const res = await fetch(`${BETA_API_URL}${path}`, { headers });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const [creatorRaw, indexerRaw] = await Promise.all([
      fetchJson(`/v1/transactions/creator/${encodeURIComponent(agentId)}`),
      fetchJson(`/v1/attribution/indexer/${encodeURIComponent(agentId)}`),
    ]);

    const creator = (creatorRaw && typeof creatorRaw === "object") ? (creatorRaw as Record<string, unknown>) : null;
    const indexer = (indexerRaw && typeof indexerRaw === "object") ? (indexerRaw as Record<string, unknown>) : null;
    const creatorLedger = (creator?.ledger && typeof creator.ledger === "object") ? (creator.ledger as Record<string, unknown>) : null;
    const recentTxs = Array.isArray(creator?.transactions) ? (creator.transactions as unknown[]).slice(0, 10) : [];

    const creatorEarnedUsd = Number(creatorLedger?.total_earned_usd ?? 0);
    const indexerEarnedUsd = Number(indexer?.total_credited_usd ?? 0);
    const totalEarnedUsd = creatorEarnedUsd + indexerEarnedUsd;

    const milestones = computeMilestoneState(totalEarnedUsd);

    // Per-skill breakdown (verbose only). Joins local manifests with the
    // trace store to surface WHICH captures are being executed.
    const contributions = verbose ? await getMyContributions(agentId) : [];

    let next_step: string;
    if (totalEarnedUsd === 0) {
      next_step = "No earnings yet. Publish skills (auto_review=true makes captures publish on close) and earn x402 rewards when other agents execute them. Run `unbrowse setup` to pair a wallet so rewards land somewhere claimable.";
    } else if (milestones.next_usd) {
      next_step = `$${totalEarnedUsd.toFixed(2)} earned across ${contributions.length || creatorLedger?.transaction_count || 0} contribution(s). ${milestones.progress_to_next_pct}% to the next $${milestones.next_usd} milestone. Pair a wallet via \`unbrowse setup\` if you have not already.`;
    } else {
      next_step = `$${totalEarnedUsd.toFixed(2)} earned. You have passed every standard milestone — pair a wallet via \`unbrowse setup\` to claim.`;
    }

    return reply.send({
      ok: true,
      registered: true,
      agent_id: agentId,
      total_earned_usd: Number(totalEarnedUsd.toFixed(6)),
      creator: creatorLedger ? {
        total_earned_usd: Number(creatorLedger.total_earned_usd ?? 0),
        transaction_count: Number(creatorLedger.transaction_count ?? 0),
        first_transaction_at: creatorLedger.first_transaction_at ?? null,
        last_transaction_at: creatorLedger.last_transaction_at ?? null,
      } : null,
      indexer: indexer ? {
        total_credited_usd: Number(indexer.total_credited_usd ?? 0),
        execution_count: Number(indexer.execution_count ?? 0),
        avg_delta: Number(indexer.avg_delta ?? 0),
        cumulative_delta: Number(indexer.cumulative_delta ?? 0),
        first_attributed_at: indexer.first_attributed_at ?? null,
        last_attributed_at: indexer.last_attributed_at ?? null,
      } : null,
      recent_transactions: recentTxs,
      ...(verbose ? { contributions } : { contributions_summary: { count: contributions.length } }),
      milestones,
      next_step,
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
      share_pointers?: boolean;
      auto_review?: boolean;
      attach_existing_chrome?: boolean;
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

    const contributionUpdate: { contribution: Partial<ContributionConfig["contribution"]> } = { contribution: {} };
    if (typeof body.share_pointers === "boolean") {
      contributionUpdate.contribution.share_pointers = body.share_pointers;
      contributionUpdate.contribution.set_via = "mode-command";
    }
    if (typeof body.auto_review === "boolean") {
      contributionUpdate.contribution.auto_review = body.auto_review;
      contributionUpdate.contribution.set_via = "mode-command";
    }
    if (Object.keys(contributionUpdate.contribution).length > 0) {
      setContributionConfig(contributionUpdate);
    }

    const contributionCfg = getContributionConfig();
    const sharePointers = contributionCfg.contribution.share_pointers;
    const autoReview = contributionCfg.contribution.auto_review;

    let next_step: string;
    if (!sharePointers) {
      next_step = "share_pointers=false (private). Captures stay local; nothing publishes to the public marketplace and no x402 rewards accrue. Flip back with share_pointers=true.";
    } else if (!settings.auto_publish_checkpoints) {
      next_step = "share_pointers=true but auto_publish_checkpoints=false: reviewed skills will not auto-publish on close/sync. Use unbrowse_publish explicitly, or re-enable auto_publish.";
    } else if (autoReview) {
      next_step = "share_pointers=true + auto_review=true (you are fully opted in). Every capture auto-stamps reviewed_at on close/sync and publishes publicly with heuristic + LLM-augmented descriptions. Flip auto_review=false to require explicit unbrowse_review before publish.";
    } else {
      next_step = "share_pointers=true, auto_review=false: only skills the agent reviews via unbrowse_review publish to the marketplace. Unreviewed captures stay local. Set auto_review=true to skip the review step.";
    }

    if (typeof body.attach_existing_chrome === "boolean") {
      setBrowserAttachEnabled(body.attach_existing_chrome);
    }
    return reply.send({
      ok: true,
      capture_pipeline: settings,
      browser: { attach_existing_chrome: getBrowserAttachEnabled() },
      contribution: {
        share_pointers: sharePointers,
        auto_review: autoReview,
        set_via: contributionCfg.contribution.set_via,
        ...(contributionCfg.contribution.set_at ? { set_at: contributionCfg.contribution.set_at } : {}),
      },
      marketplace_visibility: sharePointers ? "public" : "private",
      next_step,
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
      marketplace_publish: (() => {
        const decision = decideCheckpointPublish(s.domain || profileName(s.url));
        return {
          enabled: decision.publishQueued,
          mode: decision.mode,
          reason: decision.reason,
        };
      })(),
      suggested_commands: [
        `unbrowse inspect --session ${s.sessionId} --pretty`,
        `unbrowse resolve --intent "<task>" --url "${s.url}" --pretty`,
        `unbrowse close --session ${s.sessionId}`,
      ],
    }));
    const latest = sessions[sessions.length - 1] ?? null;
    return reply.send({ sessions, count: sessions.length, latest_session_id: latest?.session_id ?? null });
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
        rememberInspectedHarEntries(session.sessionId, harEntries);
        try { await broker.harStart(session.tabId); } catch { /* ignore */ }
      } catch (err) {
        harError = err instanceof Error ? err.message : String(err);
      }
    }

    const rawRequests = [
      ...(Array.isArray(intercepted) ? intercepted : []),
      ...harEntriesToRawRequests(harEntries, session.url),
    ];
    const candidateEndpoints = extractEndpoints(rawRequests as Parameters<typeof extractEndpoints>[0], undefined, {
      pageUrl: session.url,
      finalUrl: session.url,
    }).slice(0, 10).map((endpoint) => ({
      endpoint_id: endpoint.endpoint_id,
      method: endpoint.method,
      url_template: endpoint.url_template,
      description: endpoint.description ?? generateLocalDescription(endpoint),
      reliability_score: endpoint.reliability_score,
      idempotency: endpoint.idempotency,
      auth_token_count: endpoint.auth_tokens?.length ?? 0,
    }));
    const publishDecision = decideCheckpointPublish(session.domain || profileName(session.url));

    return reply.send({
      session: {
        session_id: session.sessionId,
        tab_id: session.tabId,
        url: session.url,
        domain: session.domain,
        har_active: session.harActive,
        streaming_publish_active: streamingWatchers.has(session.sessionId),
        marketplace_publish: {
          enabled: publishDecision.publishQueued,
          mode: publishDecision.mode,
          reason: publishDecision.reason,
        },
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
      candidate_endpoints: candidateEndpoints,
      candidate_endpoint_count: candidateEndpoints.length,
      next_actions: [
        {
          title: "Resolve from captured evidence",
          command: `unbrowse resolve --intent "<task>" --url "${session.url}" --pretty`,
          why: "Runs the normal resolver after the current in-flight capture has been exposed.",
        },
        {
          title: "Checkpoint and publish review material",
          command: `unbrowse sync --session ${session.sessionId} --pretty`,
          why: "Keeps the tab open and compiles current browser traffic into local skill evidence.",
        },
        {
          title: "Close after judging",
          command: `unbrowse close --session ${session.sessionId}`,
          why: "Flushes final capture, saves auth, and stops the live tab.",
        },
      ],
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
    const { intent, params, context, projection, confirm_unsafe, confirm_third_party_terms, dry_run, force_capture, visual_context, budget_ms, require_proof } = req.body as {
      intent: string;
      params?: Record<string, unknown>;
      context?: { url?: string; domain?: string };
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      confirm_third_party_terms?: boolean;
      dry_run?: boolean;
      force_capture?: boolean;
      visual_context?: boolean;
      budget_ms?: number;
      require_proof?: boolean;
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
      const result = await resolveAndExecute(intent, params ?? {}, context, projection, { confirm_unsafe, confirm_third_party_terms, dry_run, force_capture, client_scope: clientScope, budget_ms, require_proof });

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

      if (learned && endpoints.length > 0) {
        const cacheKey = buildResolveCacheKey(learned.domain, intent, url);
        const scopedKey = scopedCacheKey(clientScope, cacheKey);
        writeSkillSnapshot(scopedKey, learned);
        const domainKey = getDomainReuseKey(url ?? learned.domain);
        if (domainKey) {
          domainSkillCache.set(domainKey, {
            skillId: learned.skill_id,
            localSkillPath: snapshotPathForCacheKey(scopedKey),
            ts: Date.now(),
          });
          persistDomainCache();
        }
      }

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
    const reviewedAt = new Date().toISOString();
    skill.updated_at = reviewedAt;
    // reviewed_at acts as the publish-gate marker: processIndexJob skips
    // marketplace publish for any skill missing this field. Stamping it
    // here is what unlocks the public publish path.
    skill.reviewed_at = reviewedAt;
    const updatedWorkflowArtifact = applyWorkflowSchemaReviews(readWorkflowArtifact(skill.skill_id), reviews);
    if (updatedWorkflowArtifact) writeWorkflowArtifact(updatedWorkflowArtifact);

    const indexed = await indexSkillLocally(buildSkillIndexJob(skill, clientScope));

    // You are opted in by default: publish publicly once reviewed. share_pointers=false
    // means the user explicitly removed themselves from the marketplace; the
    // domain blacklist/promptlist still gates per-domain. publishIndexedSkill
    // handles the rest of the validation chain.
    const { contribution } = getContributionConfig();
    const checkpointDecision = decideCheckpointPublish(indexed.domain);
    let publishStatus: "indexed" | "published" | "blocked-validation" | "awaiting_share_optin" | "blocked_by_domain_rule" = "indexed";
    let publishMessage: string | undefined;
    if (!contribution.share_pointers) {
      publishStatus = "awaiting_share_optin";
      publishMessage = "share_pointers=false — skill reviewed and indexed locally, but not published. Run `unbrowse_settings share_pointers=true` (or `unbrowse mode public`) to publish and earn x402 rewards on execution. Rewards land in your wallet — run `unbrowse setup` to pair one if you have not already.";
    } else if (!checkpointDecision.publishQueued) {
      publishStatus = "blocked_by_domain_rule";
      publishMessage = checkpointDecision.reason;
    } else {
      try {
        const publishResult = await publishIndexedSkill(indexed);
        publishStatus = publishResult.publishStatus;
      } catch (err) {
        publishStatus = "indexed";
        publishMessage = `Publish attempt failed: ${(err as Error).message}. Skill remains indexed locally; retry via unbrowse_publish.`;
      }
    }

    return reply.send({
      ok: true,
      skill_id: indexed.skill.skill_id,
      endpoints_updated: reviews.length,
      indexed: true,
      reviewed_at: reviewedAt,
      publish_status: publishStatus,
      ...(publishMessage ? { publish_message: publishMessage } : {}),
      endpoint_count: indexed.skill.endpoints.length,
    });
  });


  // GET /v1/skills/publish-suggestions — local skills that are unreviewed
  // but have proven local usage. Substrate surfaces what exists; the agent
  // decides whether to apply. Filters can be tuned via query params.
  app.get("/v1/skills/publish-suggestions", async (req, reply) => {
    const q = req.query as {
      min_executions?: string | number;
      min_success_rate?: string | number;
      limit?: string | number;
    };
    const opts: Parameters<typeof getPopularUnreviewedSkills>[0] = {};
    if (q.min_executions !== undefined) opts.min_executions = Number(q.min_executions);
    if (q.min_success_rate !== undefined) opts.min_success_rate = Number(q.min_success_rate);
    if (q.limit !== undefined) opts.limit = Number(q.limit);

    const suggestions = await getPopularUnreviewedSkills(opts);
    const { contribution } = getContributionConfig();
    return reply.send({
      ok: true,
      count: suggestions.length,
      suggestions,
      auto_review_enabled: contribution.auto_review,
      share_pointers: contribution.share_pointers,
      next_step: suggestions.length === 0
        ? "No popular unreviewed skills found locally."
        : `Found ${suggestions.length} popular skill(s) used locally but never published. POST /v1/skills/publish-suggestions/apply with skill_ids[] to stamp reviewed_at and publish, or set auto_review=true for future captures.`,
    });
  });

  // POST /v1/skills/publish-suggestions/apply — accept the suggestion: stamp
  // reviewed_at on each named skill, re-index, and publish. Equivalent to
  // calling /review with no endpoint edits — heuristic + LLM-augmented
  // descriptions are accepted as-is.
  app.post("/v1/skills/publish-suggestions/apply", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const body = (req.body ?? {}) as { skill_ids?: string[] };
    if (!Array.isArray(body.skill_ids) || body.skill_ids.length === 0) {
      return reply.code(400).send({ error: "skill_ids[] required" });
    }

    const { contribution } = getContributionConfig();
    const results: Array<{
      skill_id: string;
      ok: boolean;
      publish_status?: string;
      publish_message?: string;
      error?: string;
    }> = [];

    for (const skill_id of body.skill_ids) {
      try {
        const skill = await loadSkillForMutation(skill_id, clientScope);
        if (!skill) {
          results.push({ skill_id, ok: false, error: "not_found" });
          continue;
        }
        const reviewedAt = new Date().toISOString();
        skill.reviewed_at = reviewedAt;
        skill.updated_at = reviewedAt;

        const indexed = await indexSkillLocally(buildSkillIndexJob(skill, clientScope));
        const checkpointDecision = decideCheckpointPublish(indexed.domain);

        if (!contribution.share_pointers) {
          results.push({
            skill_id,
            ok: false,
            publish_status: "awaiting_share_optin",
            publish_message: "share_pointers=false — flip via unbrowse_settings share_pointers=true to publish.",
          });
          continue;
        }
        if (!checkpointDecision.publishQueued) {
          results.push({
            skill_id,
            ok: false,
            publish_status: "blocked_by_domain_rule",
            publish_message: checkpointDecision.reason,
          });
          continue;
        }

        const publishResult = await publishIndexedSkill(indexed);
        results.push({
          skill_id,
          ok: publishResult.publishStatus === "published",
          publish_status: publishResult.publishStatus,
        });
      } catch (err) {
        results.push({ skill_id, ok: false, error: (err as Error).message });
      }
    }

    const published = results.filter((r) => r.publish_status === "published").length;
    return reply.send({
      ok: true,
      total: results.length,
      published,
      results,
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

  // POST /v1/skills/from-routes — feed routes_observed (from sandbox-replay /
  // unbrowse fetch) through extractEndpoints + indexSkillLocally so every
  // authenticated agent fetch contributes to the marketplace flywheel.
  // Body: { routes: ObservedRoute[], target_origin: string, intent?: string }
  // Returns: { ok, skill_id, indexed_count, published }
  app.post("/v1/skills/from-routes", async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const body = req.body as {
      routes?: Array<{
        url: string;
        method: string;
        status: number;
        final_url?: string;
        content_type?: string;
        body_excerpt?: string;
        body_size?: number;
        redirected?: boolean;
      }>;
      target_origin?: string;
      intent?: string;
    } | undefined;

    if (!body?.routes?.length) return reply.code(400).send({ error: "routes[] required" });
    if (!body.target_origin) return reply.code(400).send({ error: "target_origin required" });

    // Quality gates: drop noise BEFORE extraction.
    // - Only 200s (failed routes are not useful endpoints)
    // - No HTML responses (those are documents, not API calls)
    // - body_size > 64 (likely real data, not empty/error envelope)
    // - Skip first-party tracking beacons via known patterns
    const TRACKING_BEACONS = /\.(google-analytics|googletagmanager|segment\.io|datadog|newrelic|sentry|amplitude|mixpanel|hotjar)\.(com|io)|\/_next\/(static|image)\/|\.(woff2?|ttf|eot|otf|png|jpg|jpeg|gif|webp|svg|ico|css|map|mp4|webm)(\?|$)/i;

    const filtered = body.routes.filter((r) => {
      if (r.status < 200 || r.status >= 300) return false;
      if ((r.body_size ?? 0) < 64) return false;
      const ct = (r.content_type ?? "").toLowerCase();
      if (ct.startsWith("text/html") || ct.startsWith("application/xhtml")) return false;
      if (TRACKING_BEACONS.test(r.url)) return false;
      return true;
    });

    if (filtered.length === 0) {
      return reply.send({
        ok: true,
        indexed_count: 0,
        skipped: body.routes.length,
        reason: "all routes filtered (non-200, HTML, beacon, or empty body)",
      });
    }

    const { getRegistrableDomain } = await import("../domain.js");
    const { nanoid } = await import("nanoid");
    const { selectMarketplacePublishEndpoints } = await import("../publish-admission.js");

    // Build EndpointDescriptors directly from routes. We KNOW these work
    // (status 200 + non-HTML JSON body), so skip extractEndpoints' capture-time
    // heuristics (BM25 scoring, request-header signals, etc.) which are tuned
    // for messy HAR data, not post-hoc verified routes.
    type Endpoint = import("../types/index.js").EndpointDescriptor;
    const endpoints: Endpoint[] = filtered.map((r) => {
      // URL parameterization: replace ID-shaped path segments with {placeholders}.
      // /repos/owner/repo → /repos/{owner}/{repo} would over-parameterize. Be
      // conservative: only replace numeric IDs and explicit UUIDs/hashes.
      let urlTemplate = r.url;
      try {
        const u = new URL(r.url);
        const segments = u.pathname.split("/").map((seg) => {
          if (/^\d+$/.test(seg)) return "{id}";
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "{uuid}";
          if (/^[0-9a-f]{32,}$/i.test(seg) && seg.length >= 32) return "{hash}";
          return seg;
        });
        u.pathname = segments.join("/");
        urlTemplate = u.toString();
      } catch { /* keep raw */ }

      const method = r.method.toUpperCase() as Endpoint["method"];
      const idempotency: Endpoint["idempotency"] = method === "GET" || method === "HEAD" || method === "OPTIONS" ? "idempotent" : "unknown";
      const isJson = (r.content_type ?? "").toLowerCase().includes("json");

      const ep: Endpoint = {
        endpoint_id: nanoid(),
        method,
        url_template: urlTemplate,
        idempotency,
        verification_status: "verified",
        reliability_score: 1.0,
        last_verified_at: new Date().toISOString(),
      };
      if (r.content_type) ep.headers_template = { "content-type": r.content_type };
      if (isJson && r.body_excerpt) {
        // Best-effort yields[] from the first object's keys.
        try {
          const parsed = JSON.parse(r.body_excerpt);
          const yields = Array.isArray(parsed)
            ? (parsed[0] && typeof parsed[0] === "object" ? Object.keys(parsed[0]).slice(0, 16) : [])
            : (parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 16) : []);
          if (yields.length > 0) {
            ep.response_schema = { sample_field_names: yields } as Endpoint["response_schema"];
          }
        } catch { /* truncated/invalid JSON — skip yields */ }
      }
      return ep;
    });


    let domain: string;
    try { domain = getRegistrableDomain(new URL(body.target_origin).hostname); }
    catch { return reply.code(400).send({ error: "could not parse target_origin domain" }); }

    const intent = body.intent || `fetch ${domain}`;
    const existingSkill = findExistingSkillForDomain(domain, intent);

    // Merge with existing endpoints if a skill exists.
    // mergeEndpoints already imported at top
    const mergedEndpoints = existingSkill
      ? mergeEndpoints(existingSkill.endpoints, endpoints)
      : endpoints;

    const draft: import("../types/index.js").SkillManifest = {
      skill_id: existingSkill?.skill_id ?? nanoid(),
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: existingSkill?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: domain,
      intent_signature: intent,
      domain,
      description: `API skill for ${domain} (built from observed routes)`,
      owner_type: "agent",
      endpoints: mergedEndpoints,
      intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
    };

    const indexed = await indexSkillLocally(buildSkillIndexJob(draft, clientScope));

    // Marketplace publish gated by mode (same as capture).
    const admission = selectMarketplacePublishEndpoints(draft);
    let publishedAt: string | undefined;
    let publishStatus: "indexed" | "published" | "blocked-validation" = "indexed";
    if (admission.endpoints.length > 0) {
      try {
        const result = await publishIndexedSkill(indexed);
        publishStatus = result.publishStatus;
        publishedAt = result.publishedAt;
      } catch (e) {
        // Best effort — local indexing succeeded, publish is bonus.
        console.warn(`[from-routes] publish failed: ${(e as Error).message}`);
      }
    }

    try { cachePublishedSkill(indexed.skill); } catch { /* best-effort */ }

    let skillmd_path: string | undefined;
    try {
      const { exportSkillMdLocal } = await import("../skillmd.js");
      skillmd_path = exportSkillMdLocal(indexed.skill) ?? undefined;
    } catch { /* best-effort */ }

    return reply.send({
      ok: true,
      skill_id: indexed.skill.skill_id,
      domain,
      intent,
      indexed_count: endpoints.length,
      total_endpoints: mergedEndpoints.length,
      skipped: body.routes.length - filtered.length,
      publish_status: publishStatus,
      published_at: publishedAt,
      skillmd_path,
    });
  });

  // GET /v1/skills/:skill_id/skill.md — render SkillManifest as agentskills.io
  // SKILL.md format. Body emits `unbrowse execute` commands so installed skills
  // require the unbrowse runtime. Distribution: skills.sh; execution: unbrowse.
  app.get("/v1/skills/:skill_id/skill.md", async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    if (!skill_id) return reply.code(400).send({ error: "skill_id required" });

    const { join } = await import("node:path");
    const { existsSync, readFileSync, readdirSync } = await import("node:fs");
    const { homedir } = await import("node:os");

    let skill: import("../types/index.js").SkillManifest | null = null;
    try {
      const cacheDir = process.env.UNBROWSE_SKILL_CACHE_DIR
        || join(process.env.UNBROWSE_CONFIG_DIR || join(homedir(), ".unbrowse"), "skill-cache");
      if (existsSync(cacheDir)) {
        const direct = join(cacheDir, `${skill_id}.json`);
        if (existsSync(direct)) skill = JSON.parse(readFileSync(direct, "utf-8"));
        if (!skill) {
          for (const f of readdirSync(cacheDir)) {
            if (!f.endsWith(".json")) continue;
            try {
              const s = JSON.parse(readFileSync(join(cacheDir, f), "utf-8")) as import("../types/index.js").SkillManifest;
              if (s.skill_id === skill_id) { skill = s; break; }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* fall through */ }

    if (!skill) return reply.code(404).send({ error: "skill not found", skill_id });

    const { renderSkillMd } = await import("../skillmd.js");
    const md = renderSkillMd(skill);
    return reply.type("text/markdown; charset=utf-8").send(md);
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
    const { intent, operation_id, known_bindings, max_operations, require_proof } = req.body as {
      intent?: string;
      operation_id?: string;
      known_bindings?: Record<string, unknown>;
      max_operations?: number;
      require_proof?: boolean;
    };
    const skill = getRecentLocalSkill(skill_id, clientScope) ?? await getSkill(skill_id, clientScope);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    return reply.send(toAgentSkillChunkView(getSkillChunk(skill, {
      intent,
      seed_operation_id: operation_id,
      known_bindings,
      max_operations,
    }), skill.endpoints, { requireProof: require_proof === true }));
  });

  // POST /v1/skills/:skill_id/execute
  app.post("/v1/skills/:skill_id/execute", { config: { rateLimit: ROUTE_LIMITS["/v1/skills/:skill_id/execute"] } }, async (req, reply) => {
    const clientScope = clientScopeFor(req);
    const { skill_id } = req.params as { skill_id: string };
    const { params, projection, confirm_unsafe, confirm_third_party_terms, dry_run, intent, context_url } = req.body as {
      params?: Record<string, unknown>;
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      confirm_third_party_terms?: boolean;
      dry_run?: boolean;
      intent?: string;
      context_url?: string;
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
      let execResult = await executeSkill(skill, execParams, projection, { confirm_unsafe, confirm_third_party_terms, dry_run, intent, contextUrl: context_url, client_scope: clientScope });

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
          execResult = await executeSkill(skill, execParams, projection, { confirm_unsafe, confirm_third_party_terms, dry_run, intent, contextUrl: context_url, client_scope: clientScope });
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
          // Strip the just-evicted endpoint_id from recovery params — otherwise
          // resolveAndExecute carries it forward and the second execute hits
          // `endpoint_not_found` because executeEndpoint already evicted it
          // from the local cache on the 404 (see src/execution/index.ts:3473).
          // The whole point of recovery is "this endpoint is stale; let
          // resolve pick a fresh one." Probe 003 crates.io 2026-05-19:
          // first execute returned 404 → evicted 3bqb → recovery
          // resolveAndExecute({endpoint_id: 3bqb, ...}) → endpoint_not_found
          // even though skill V still had 8PHsp5fAXZX1P4Z8nuT9_ available.
          const { endpoint_id: _stale, ...recoveryParams } = execParams;
          void _stale;
          const freshResult = await resolveAndExecute(
            intent || skill.intent_signature,
            { ...recoveryParams, url: recoveryUrl },
            { url: recoveryUrl },
            projection,
            // local_skills_only: we already hold the failed skill in
            // hand and just need to find a sibling endpoint or capture
            // afresh — there's no value in waiting up to 2500ms for a
            // marketplace round-trip whose result would be ignored.
            // PR #506 follow-up to PR #503: cuts 404-recovery latency.
            { confirm_unsafe, confirm_third_party_terms, dry_run, intent: intent || skill.intent_signature, client_scope: clientScope, local_skills_only: true }
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
      interactive_only,
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
      interactive_only?: boolean;
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
        interactiveOnly: interactive_only === true,
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
    pid: process.pid,
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
      const latestSession = Array.from(browseSessions.values()).at(-1);
      return reply.code(error.statusCode).send({
        error: error.code,
        ...(latestSession ? { latest_session_id: latestSession.sessionId } : {}),
        next_action: latestSession
          ? {
              title: "Retry with latest active session",
              command: `unbrowse inspect --session ${latestSession.sessionId} --pretty`,
              why: "A live session exists; inspect it or pass --session to the browser command.",
            }
          : {
              title: "Open a browser session",
              command: 'unbrowse go "<url>" --pretty',
              why: "This command needs a live Kuri-backed browse session.",
            },
      });
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
    // Each capture-setup step is wrapped so an early failure doesn't
    // wedge the entire navigate path — but unlike the pre-fix code
    // (`.catch(() => {})` silently swallowing every error) we now LOG
    // the failure so the operator sees which step failed when the
    // close pipeline subsequently reports `requests_count: 0`. Gate
    // run 20260518T115632Z showed SPA probes (npm, crates.io,
    // dockerhub, dev.to) capturing zero requests with no signal as to
    // whether harStart failed, the interceptor didn't inject, or the
    // page truly made no XHR — surfacing each step's outcome
    // disambiguates that.
    const captureStep = async (name: string, fn: () => Promise<unknown>) => {
      try { await fn(); return true; } catch (e) {
        console.warn(
          `[capture-setup] ${name} failed for session=${session.sessionId} tab=${session.tabId}: ${(e as Error)?.message ?? e}`,
        );
        return false;
      }
    };
    await captureStep("networkEnable", () => broker.networkEnable(session.tabId));
    // Hook the CDP Network.requestWillBeSent stream so request headers (Authorization,
    // x-csrf-*, etc.) from XHRs the JS interceptor or HAR miss are captured for replay.
    // Generic — no per-domain logic. Headers are persisted as a domain-session credential
    // at close time so executeEndpoint can replay them.
    await captureStep("enableNetworkHeaderCapture", () => enableNetworkHeaderCapture(session.tabId));
    const harOk = await captureStep("harStart", () => broker.harStart(session.tabId));
    // Register interceptor as init script so it runs before page JS on every navigation
    // This catches SSR hydration API calls (Reddit GraphQL, etc.) that fire before evaluate()
    await captureStep("addInitScript", () => broker.addInitScript(session.tabId, INTERCEPTOR_SCRIPT));
    await captureStep("scriptInject", () => broker.scriptInject(session.tabId, INTERCEPTOR_SCRIPT));
    // Only mark HAR active if harStart actually succeeded — pre-fix the
    // flag was set unconditionally, so a silently-failed harStart
    // produced an empty HAR drain at close, attributed to "site has no
    // XHR" instead of "we never started recording."
    session.harActive = harOk;
    await captureStep("injectInterceptor", () => injectInterceptor(session.tabId));
  }

  // ── Durable raw-capture spool (one-shot survival) ────────────────────
  // Produced at the tail of /v1/browse/go BEFORE reply.send so the
  // captured route survives a CLI exit that races the in-memory
  // pipeline (the existing flushBrowseCapture path only persists when
  // the process stays alive long enough for the ~40s enrich tail).
  // We do ONLY cheap broker reads here (harStop, drained interceptor
  // buffer, CDP header snapshots) plus an atomic disk write — never
  // enrich/cacheBrowseRequests. A later unbrowse process drains
  // ~/.unbrowse/queue/capture-pending/ via the bridge processor and
  // feeds the existing durable index queue.
  async function spoolBrowseCapture(
    session: BrowseSession,
    options: { pageHtml?: string } = {},
  ): Promise<{ written: boolean; path?: string; request_count: number }> {
    // 1. Drain the inspected HAR map (consumes) and stop+restart the
    //    broker's own HAR so we own a discrete window of entries.
    let harEntries: KuriHarEntry[] = drainInspectedHarEntries(session.sessionId);
    if (session.harActive) {
      try {
        const broker = brokerForSession(session);
        const stopResult = await broker.harStop(session.tabId);
        harEntries = [...harEntries, ...(stopResult.entries ?? [])];
        try { await broker.harStart(session.tabId); } catch { /* ignore */ }
      } catch { /* non-fatal */ }
    }

    // 2. Pull the live broker buffers (interceptor + CDP header snapshots)
    //    NOW — they are tab-keyed in module memory and a later process
    //    cannot recover them. RawRequest is the JSON-safe cut.
    const intercepted = await collectInterceptedRequests(session.tabId).catch(() => []);
    const interceptedAsRaw: RawRequest[] = intercepted.map((e) => ({
      url: e.url,
      method: e.method,
      request_headers: e.request_headers,
      request_body: e.request_body,
      response_status: e.response_status,
      response_headers: e.response_headers,
      response_body: e.response_body,
      timestamp: e.timestamp,
    }));
    const cdpHeaderRequests = getCapturedNetworkHeadersAsRequests(session.tabId);
    const harAsRaw = harEntriesToRawRequests(harEntries, session.url);
    const requests: RawRequest[] = [...harAsRaw, ...interceptedAsRaw, ...cdpHeaderRequests];

    if (requests.length === 0 && !options.pageHtml) {
      // Nothing worth spooling — no API-shaped capture and no SSR HTML
      // for a future DOM-fallback drain. Avoid noise on disk.
      return { written: false, request_count: 0 };
    }

    const domain = session.domain || profileName(session.url);
    const publishDecision = decideCheckpointPublish(domain);
    const envelope: CaptureSpoolEnvelope = {
      version: 1,
      domain,
      capturedAt: Date.now(),
      attempts: 0,
      capture: {
        sessionUrl: session.url,
        sessionDomain: domain,
        intent: `browse ${domain}`,
        requests,
        ...(options.pageHtml ? { pageHtml: options.pageHtml } : {}),
        publishAfterIndex: publishDecision.publishQueued,
      },
    };
    const path = await writeCaptureSpool(getCaptureSpoolDir(), envelope);
    return { written: true, path, request_count: requests.length };
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
    harEntries = [...drainInspectedHarEntries(session.sessionId), ...harEntries];

    const allRequests = await enrichPassiveCaptureRequests({
      tabId: session.tabId,
      captureUrl: session.url,
      harEntries,
      intent: `browse ${session.domain || profileName(session.url)}`,
    });

    // Removed the `allRequests.length === 0` early-return so SSR-only pages
    // (no captured XHRs) reach `cacheBrowseRequests`'s DOM-extraction
    // fallback at src/api/browse-index.ts:274-364. Previously every
    // fully-server-rendered site (news.ycombinator.com, MDN, Wikipedia,
    // static blogs) returned endpoint_count:0 and indexed:false from the
    // close pipeline, even though the page HTML was data-rich. The DOM
    // fallback already exists; it was just unreachable from this caller.

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
      extraAuthHeaderRequests: getCapturedNetworkHeadersAsRequests(session.tabId),
      getCookies: async () => {
        try {
          const c = await brokerForSession(session).getCookies(session.tabId);
          return c.map((k) => ({ name: k.name, value: k.value, domain: k.domain }));
        } catch { return []; }
      },
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
    inspectedHarEntries.delete(sessionId);
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
    capture_diagnostic: CaptureDiagnostic;
  }> {
    let harEntries: KuriHarEntry[] = [];
    if (session.harActive) {
      try {
        const { entries } = await brokerForSession(session).harStop(session.tabId);
        harEntries = entries;
      } catch { /* non-fatal */ }
    }
    harEntries = [...drainInspectedHarEntries(session.sessionId), ...harEntries];
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
    // Drain CDP Network.requestWillBeSent header snapshots into synthetic RawRequests
    // for auth-header extraction only. These capture Authorization / x-csrf-* / etc. from
    // XHRs the JS interceptor and HAR missed. Generic — works for any domain.
    const cdpExtraAuthRequests = getCapturedNetworkHeadersAsRequests(session.tabId);
    const syncResult = await cacheBrowseRequests({
      sessionUrl: session.url,
      sessionDomain: session.domain,
      requests: allRequests,
      getPageHtml: () => brokerForSession(session).getPageHtml(session.tabId),
      jsBundles: jsBundles.size > 0 ? jsBundles : undefined,
      intent: `browse ${session.domain || profileName(session.url)}`,
      extraAuthHeaderRequests: cdpExtraAuthRequests,
      getCookies: async () => {
        try {
          const c = await brokerForSession(session).getCookies(session.tabId);
          return c.map((k) => ({ name: k.name, value: k.value, domain: k.domain }));
        } catch { return []; }
      },
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
      capture_diagnostic: syncResult.capture_diagnostic,
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
            cookiesInjected = await importBrowserCookiesIntoTab(session.tabId, newDomain, broker);
          } else {
            cookiesInjected = await importBrowserCookiesIntoTab(session.tabId, newDomain, broker);
            await loadAuthProfileBestEffort(session.tabId, newDomain, "browse_go");
          }
          // Also inject Google OAuth cookies so "Login with Google" auto-completes.
          // Many sites use Google OAuth and the user may be logged into Google in another browser.
          if (cookiesInjected === 0) {
            const googleInjected = await importBrowserCookiesIntoTab(session.tabId, "google.com", broker);
            const accountsInjected = await importBrowserCookiesIntoTab(session.tabId, "accounts.google.com", broker);
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

        // Post-navigate liveness probe: previously this threw `{ error:
        // "CDP command failed" }` and turned every transient CDP hiccup
        // into a fatal /v1/browse/go failure — even when `broker.navigate`
        // had already succeeded and the page was actually loaded. Gate
        // run 20260518T115632Z had ~13 probes (lobste.rs, wikipedia,
        // arxiv, pypi, dockerhub, dev.to, reddit/programming, ...) fail
        // this way at conc=6 against URLs that work serially in-thread.
        //
        // The right shape is: navigate's own try/catch above already
        // recovers from spurious aborts (L2880-2916); by the time we
        // reach here the page is loaded. A transient liveness false here
        // doesn't mean the session is dead — it means the broker is
        // briefly unresponsive. Warn so the operator sees it, but don't
        // fail the request.
        const stillLive = await isBrowseSessionLive(session, browseClient).catch(() => false);
        if (!stillLive) {
          console.warn(
            `[browse-go] post-navigate liveness probe returned false for session=${session.sessionId} url=${session.url}; navigate already succeeded, continuing`,
          );
        }

        return { cookiesInjected };
      };

      let session: BrowseSession;
      let result: { cookiesInjected: number };
      if (sessionId) {
        // Create-on-unknown-id: a parallel caller (e.g. the gate collector)
        // may pre-assign a DISJOINT session_id per task. If it does not exist
        // yet, create it bound to that id (broker-create-locked, so concurrent
        // creates cannot cross-bind tabs), then take the strict serialized
        // navigate path. Existing ids keep the original strict behavior.
        if (!browseSessions.get(sessionId)) {
          await getOrCreateNavigateBrowseSession(
            browseSessions,
            browseClient,
            injectInterceptor,
            sessionId,
          );
        }
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

      // Detect auth walls: narrow signals only. Mere presence of a "Log In"
      // link in the navbar is NOT an auth wall; the page must have an actual
      // login form (<input type="password">) or explicit gating copy. See
      // ./auth-detection.ts for the rationale and signal list.
      let authRequired = false;
      let authHint: string | undefined;
      try {
        const broker = brokerForSession(session);
        const authProbe = await broker.evaluate(session.tabId, AUTH_PROBE_JS).catch(() => null);
        if (authProbe && typeof authProbe === "string") {
          const info = JSON.parse(authProbe) as AuthProbeResult;
          const classified = classifyAuthSignals(info);
          if (classified.required) {
            authRequired = true;
            authHint = `Page requires authentication (${classified.reason}). Visible Chrome opening for sign-in; cookies will save automatically. Retry unbrowse_go once you've logged in.`;
          }
        }
      } catch { /* non-fatal */ }

      // Auto-route to visible Chrome when an auth wall is detected. Headless
      // kuri can't show the user a login form, so swap modes fire-and-forget:
      // the headless session here is abandoned; agent retries unbrowse_go
      // after the user finishes signing in. Opt out with
      // UNBROWSE_AUTO_AUTH=0 / "false".
      const autoAuth = (process.env.UNBROWSE_AUTO_AUTH ?? "1").trim().toLowerCase();
      const autoAuthEnabled = autoAuth !== "0" && autoAuth !== "false";
      let loginWindowOpened = false;
      if (authRequired && autoAuthEnabled) {
        loginWindowOpened = true;
        const loginUrl = session.url;
        const loginDomain = session.domain;
        setImmediate(() => {
          loginWithBrowserFallback(loginUrl, { interactiveOnly: true })
            .catch((err) => console.log(`[auth] auto-login failed for ${loginDomain}: ${(err as Error).message}`));
        });
      }

      // Fix B: kick off streaming background publish for this session
      startStreamingWatcher(session);

      // Return the rendered page content inline so a content-read intent
      // is satisfied by this single call (minimal steps to the intent).
      // Reuses the exact extractor GET /v1/browse/text uses; best-effort,
      // never breaks go on failure. Indexing stays deferred (separate
      // concern, the background streaming watcher above).
      let page: { text: string; structured_data: string | null } | undefined;
      try {
        const pageBroker = brokerForSession(session);
        const text = await pageBroker.getText(session.tabId);
        if (typeof text === "string" && text.length > 0) {
          let structured: string | null = null;
          try {
            const html = await pageBroker.getPageHtml(session.tabId);
            if (typeof html === "string" && html.startsWith("<")) {
              structured = buildStructuredDataHeader(html);
            }
          } catch { /* getPageHtml best-effort */ }
          const augmented = structured ? `${structured}\n\n---\n\n${text}` : text;
          page = { text: augmented, structured_data: structured };
        }
      } catch { /* getText best-effort: never break go */ }

      // Durable capture spool: write the cheap raw cut to disk BEFORE
      // reply.send so the captured route survives a one-shot CLI exit.
      // Awaited (a fast disk write, not the ~40s enrich) so the bytes are
      // renamed into ~/.unbrowse/queue/capture-pending/ before the client
      // sees ok:true. The streaming watcher + close path keep their own
      // persistence; this is the crash/exit safety net for the one-shot
      // path the plan's GOAL targets. Best-effort: never breaks go.
      let spool_written = false;
      try {
        const spoolRes = await spoolBrowseCapture(session, page ? { pageHtml: page.text } : {});
        spool_written = spoolRes.written;
      } catch (err) {
        console.error(`[browse/go] spool failed (non-fatal): ${(err as Error).message}`);
      }
      return reply.send({
        ok: true,
        session_id: session.sessionId,
        url: session.url,
        tab_id: session.tabId,
        auth_profile: session.domain,
        ...(result.cookiesInjected > 0 ? { cookies_injected: result.cookiesInjected } : {}),
        ...(authRequired ? { auth_required: true, auth_hint: authHint } : {}),
        ...(loginWindowOpened ? { login_window_opened: true } : {}),
        ...(page ? { page } : {}),
        // Autonomy signals — agents read these to judge whether the system is
        // capturing in the background as advertised. No separate "verify" verb;
        // every go response is self-describing.
        autonomy: (() => {
          const publishDecision = decideCheckpointPublish(session.domain);
          return {
            har_active: session.harActive,
            streaming_publish_active: streamingWatchers.has(session.sessionId),
            attached_existing_chrome: result.attachedExistingChrome ?? false,
            chrome_debug_url: process.env.CHROME_DEBUG_URL ?? null,
            inspect_command: `unbrowse inspect --session ${session.sessionId} --pretty`,
            inspect_buffer: `GET ${process.env.UNBROWSE_API_BASE ?? "http://127.0.0.1:6969"}/v1/browse/sessions/${session.sessionId}/buffer`,
            // Publish gating — tells the agent whether captures will reach the
            // shared marketplace. The user controls this via `unbrowse settings`
            // and per-domain blacklist/promptlist. When false, captures stay
            // local and only this user benefits.
            marketplace_publish_enabled: publishDecision.publishQueued,
            marketplace_publish_mode: publishDecision.mode,
            marketplace_publish_reason: publishDecision.reason,
          };
        })(),
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
      const { session, result } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          const broker = brokerForSession(session);
          const snapshot = await broker.snapshot(session.tabId, filter);
          // Probe the actual landed URL so the agent can detect tab drift
          // (e.g. captcha redirect, adopted tab on a different host).
          const currentUrl = await broker.getCurrentUrl(session.tabId).catch(() => null);
          return { snapshot, currentUrl };
        },
      );
      const snapResponse = buildSnapResponse({
        snapshot: result.snapshot,
        session,
        currentUrl: result.currentUrl,
      });
      const diagnostic = diagnoseSnapshot(result.snapshot, snapResponse.current_url ?? session.url);
      return reply.send({ ...snapResponse, ...diagnostic });
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
  // If the page emits schema.org JSON-LD (ItemList/Product/Article/etc),
  // prepend a structured-data summary so the agent sees the publisher's
  // authoritative entity description before the rendered text. On SSR pages
  // the rendered DOM can include personalized widgets injected alongside
  // canonical content; the JSON-LD is pre-render and authoritative.
  app.get("/v1/browse/text", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          const broker = brokerForSession(session);
          const text = await broker.getText(session.tabId);
          let structured: string | null = null;
          try {
            const html = await broker.getPageHtml(session.tabId);
            if (typeof html === "string" && html.startsWith("<")) {
              structured = buildStructuredDataHeader(html);
            }
          } catch { /* getPageHtml best-effort */ }
          return { text, structured };
        },
      );
      const augmented = result.structured
        ? `${result.structured}\n\n---\n\n${result.text ?? ""}`
        : result.text;
      return reply.send({
        text: augmented,
        structured_data: result.structured ?? null,
        session_id: session.sessionId,
        tab_id: session.tabId,
      });
    } catch (error) {
      return sendBrowseSessionError(reply, error);
    }
  });

  // GET /v1/browse/markdown — page as markdown
  // Same prepend rule as /v1/browse/text — surface JSON-LD entities before
  // the rendered markdown.
  app.get("/v1/browse/markdown", async (req, reply) => {
    try {
      const browseClient = selectBrowseBrokerClient(requestedSessionId(req));
      const { session, result } = await withSerializedStrictBrowseSession(
        browseSessions,
        browseClient,
        requestedSessionId(req),
        async (session) => {
          const broker = brokerForSession(session);
          const markdown = await broker.getMarkdown(session.tabId);
          let structured: string | null = null;
          try {
            const html = await broker.getPageHtml(session.tabId);
            if (typeof html === "string" && html.startsWith("<")) {
              structured = buildStructuredDataHeader(html);
            }
          } catch { /* best-effort */ }
          return { markdown, structured };
        },
      );
      const augmented = result.structured
        ? `${result.structured}\n\n---\n\n${result.markdown ?? ""}`
        : result.markdown;
      return reply.send({
        markdown: augmented,
        structured_data: result.structured ?? null,
        session_id: session.sessionId,
        tab_id: session.tabId,
      });
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
        capture_diagnostic: syncResult.capture_diagnostic,
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
          const closedBrokerPort = session.brokerPort;
          removeBrowseSession(browseSessions, session.sessionId);
          // Per-session broker shutdown. When this session was on a dedicated
          // broker (port >= PER_SESSION_BROKER_BASE_PORT) and no other live
          // session still uses that port, tear down the kuri+chrome processes
          // so they don't leak. Pre-fix: every session_id since the broker
          // isolation fix allocated a fresh kuri + chrome that never got
          // stopped on close, so a single MCP session piled up 9 brokers +
          // 10 chromes after 5 closes (sample-{anchor-mdn,rank-reddit,...}).
          // Pool brokers (port < base) are intentionally kept; they're reused.
          if (
            typeof closedBrokerPort === "number"
            && closedBrokerPort >= PER_SESSION_BROKER_BASE_PORT
            && ![...browseSessions.values()].some((s) => s.brokerPort === closedBrokerPort)
          ) {
            await broker.stop().catch(() => {});
          }
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
        capture_diagnostic: syncResult.capture_diagnostic,
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
