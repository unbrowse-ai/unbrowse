import {
  cachePublishedSkill,
  findExistingSkillForDomain,
  getAgentId,
  getLocalWalletContext,
  isX402Error,
  recordOrchestrationPerf,
  recordRoutingTelemetry,
  searchIntentResolve,
} from "../client/index.js";
import * as kuri from "../kuri/client.js";
import { emitRouteTrace, hashValue, recordFailure } from "../telemetry.js";
import { publishSkill, getSkill } from "../marketplace/index.js";
import { decomposeGraphqlEndpoint, decomposeGrpcEndpoint, decomposeJsonRpcEndpoint, decomposeFormEndpoint, decomposeXmlEndpoint, executeSkill, isPageFetchEndpoint, buildPageFetchEndpoint, buildPageArtifactCapture } from "../execution/index.js";
import { sealSkillSnapshotHoles } from "../values/storage-hole-bindings.js";
import { fsSealedBlobStore } from "../values/sealed-blob-store.js";
import { deriveSealKey, deriveCommitmentKey } from "../values/signer.js";
import { trySsrFastPathOnBlock } from "../capture/ssr-fastpath.js";
import { tryCurlImpersonateFetch, tryCamoufoxFetch, tryX402UnblockerFetch } from "../capture/curl-impersonate-fallback.js";
import { looksBlocked } from "../capture/fetch-ladder.js";
import { resolveProxyUrl, resolveEgressProxy, proxiedFetchOnce } from "../execution/proxy-fetch.js";

// Native CLI web-search egress with residential-proxy FALLBACK. Keyless DDG (and other client-side
// web fetches) run from the USER's IP, which gets rate-limited under load — witnessed: DDG direct ->
// TimeoutError, DDG via IProyal -> on-target hits. Strategy: try DIRECT first (fast, the common case
// — a normal user's IP is not throttled), and only on a failure (timeout / block / non-2xx) RETRY
// through the resolved egress proxy (IProyal residential, ~/.identity/iproyal-creds, or
// UNBROWSE_PROXY_URL). This keeps normal use fast while staying resilient when the IP is throttled.
// A session-level circuit-breaker (`webEgressThrottled`) skips the doomed direct attempt once a
// throttle has been seen, so a throttled session doesn't pay the direct-timeout on every call.
// Opt out of the proxy with UNBROWSE_WEB_PROXY=0; force proxy-first with UNBROWSE_WEB_PROXY=force.
let webEgressThrottled = false;
const proxiedWebFetch: typeof fetch = async (input, init) => {
  const fwd = (i: typeof input, n: typeof init) => fetch(i as Parameters<typeof fetch>[0], n);
  const mode = process.env.UNBROWSE_WEB_PROXY;
  const proxyUrl = mode === "0" ? undefined : resolveEgressProxy();
  const url = typeof input === "string" ? input : (input as URL).toString();
  const viaProxy = async () => {
    const { response } = await proxiedFetchOnce(url, (init ?? {}) as RequestInit, proxyUrl);
    return response;
  };
  // Proxy-first only when explicitly forced OR the session already saw a throttle (avoid the
  // repeated direct-timeout tax on a known-throttled IP).
  if (proxyUrl && (mode === "force" || webEgressThrottled)) {
    try { return await viaProxy(); } catch { return fwd(input, init); }
  }
  try {
    const res = await fwd(input, init);
    if (proxyUrl && !res.ok) { webEgressThrottled = true; try { return await viaProxy(); } catch { return res; } }
    return res;
  } catch (e) {
    if (!proxyUrl) throw e;
    webEgressThrottled = true; // remember: this IP is throttled/blocked for the session
    return await viaProxy();
  }
};

import { rankEndpoints, rankEndpointsServerFirst } from "../client/rank-server-first.js";
import {
  getSkillChunk,
  getEndpointDescriptionMetadata,
  knownBindingsFromInputs,
  computeReachableEndpoints,
  ensureSkillOperationGraph,
  toAgentWorkflowDagView,
  applyProjectedEdgeConfidences,
  filterDagOperationsByRankedEndpoints,
} from "../lib/graph-core/index.js";
import { fetchDagAdvisoryPlan, applyDagAdvisoryBoosts } from "./dag-advisor.js";
import { getRegistrableDomain, isSameBrandDomain } from "../domain.js";
import { extractTemplateQueryBindings, mergeContextTemplateParams, normalizeQueryBindingKey } from "../template-params.js";
import { writeDebugTrace } from "../debug-trace.js";
import { recordDagSessionAction, recordDagNegative, upsertDagEdgesFromOperationGraph } from "./dag-feedback.js";
import { syncEdgeConfidence, getCachedEdgeConfidenceProjection } from "../client/graph-client.js";
import { isStructuredSearchForm } from "../execution/search-forms.js";
import { attributeLifecycle, type LifecycleEvent } from "../runtime/lifecycle.js";
import { ddgSearch } from "../lib/ddg-search.js";
import { selectHoleProducer, bindingGraphFromOperationGraph } from "../lib/graph-core/hole-binding.js";
import { cachedResolution } from "../values/cached-resolution.js";
import { credentialFromAuthContext } from "../runtime/principal-scope.js";
import { isPersistableYield } from "../values/yield-safety.js";
import { getStoredAuth } from "../auth/index.js";
import { storeExecutionTrace, findTracesByIntent } from "../lib/graph-core/trace-store.js";
import { extractBindingsFromJson } from "../lib/graph-core/session.js";
import { queuePassiveSkillPublish } from "./passive-publish.js";
import { getPrefetchTargets, executePrefetch } from "../capture/prefetch.js";
import { DEFAULT_CAPTURE_TOKENS, computeTimingEconomics } from "./timing-economics.js";
import { checkPaymentRequirement } from "../payments/index.js";
import { checkWalletConfigured } from "../payments/wallet.js";
import type {
  ExecutionOptions,
  ExecutionTrace,
  OperationBinding,
  OrchestrationTiming,
  ProjectionOptions,
  ResponseSchema,
  SkillComposite,
  SkillManifest,
} from "../types/index.js";
import { TRACE_VERSION } from "../version.js";
import { nanoid } from "nanoid";
import { assessIntentResult, projectIntentData } from "../intent-match.js";
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { resolveAuthPrerequisites, deriveAuthDependencies, authRuntime } from "../auth/runtime.js";
import { decidePreResolveAuthGate } from "../auth/pre-resolve-gate.js";
import { getCredential } from "../vault/index.js";
import { pruneLocalCacheStateForSkill, type LocalCacheCleanupSummary } from "../stale-cleanup.js";
import {
  buildRoutingCandidateSnapshots,
  buildRoutingContextBuckets,
  createRoutingTelemetryCollector,
  deriveRoutingStepArtifacts,
  hashRoutingState,
  sanitizeRoutingEventBatch,
} from "../routing-telemetry.js";
import { runResolveRace } from "./resolve-race.js";
import { buildBloombergDirectDocumentResult, fetchDirectDocument } from "./direct-document.js";
import { pruneLocalCacheStateForSkill, type LocalCacheCleanupSummary } from "../stale-cleanup.js";

const CONFIDENCE_THRESHOLD = 0.3;
const LIVE_CAPTURE_TIMEOUT_MS = Number(process.env.UNBROWSE_LIVE_CAPTURE_TIMEOUT_MS ?? "120000");

/**
 * A page-artifact capture (buildPageArtifactCapture / camoufox / curl_cffi rescue) returns
 * {endpoint, result} where `result` is the extracted DATA — with no `available_endpoints`.
 * resolve/`explain` reports coverage from `available_endpoints`, so surfacing only the data
 * shows ZERO coverage for a page that genuinely has a callable DOM-extraction route. Merge
 * the artifact's endpoint into the result as a positive-score shortlist so the reported
 * capability matches the real one (same shape `mergeDomShortlist` uses).
 */
function artifactResultWithShortlist(
  artifact: { endpoint?: { endpoint_id?: string; method?: string; url_template?: string; description?: string; dom_extraction?: unknown } | undefined; result?: unknown },
  skillId: string,
  triggerUrl: string,
): unknown {
  const ep = artifact.endpoint;
  const res = artifact.result;
  if (!ep || !res || typeof res !== "object") return res;
  const rec = res as Record<string, unknown>;
  if (Array.isArray(rec.available_endpoints) && rec.available_endpoints.length > 0) return res;
  const shortlist = [{
    endpoint_id: ep.endpoint_id,
    source_skill_id: skillId,
    method: ep.method,
    url: ep.url_template,
    url_template: ep.url_template,
    description: ep.description,
    score: 1,
    ...(ep.dom_extraction ? { dom_extraction: ep.dom_extraction } : {}),
    trigger_url: triggerUrl,
  }];
  return { ...rec, available_endpoints: shortlist, available_operations: shortlist, shortlist_for_judgment: shortlist };
}

/** Flat map of top-level property names → types from a ResponseSchema.
 *  Gives agents enough shape to pick --path targets without full schema bloat. */
/** Recursive schema tree limited to `maxDepth` levels.
 *  Gives agents the response shape they need to pick --path/--extract targets. */
export function summarizeSchema(schema: ResponseSchema, maxDepth = 3): Record<string, unknown> | null {
  function walk(s: ResponseSchema, depth: number): unknown {
    if (depth <= 0) return s.type;
    if (s.type === "array" && s.items) {
      const inner = walk(s.items, depth - 1);
      return inner && typeof inner === "object" ? [inner] : [`${s.items.type ?? "unknown"}`];
    }
    if (s.properties) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties)) {
        out[k] = walk(v, depth - 1);
      }
      return out;
    }
    return s.type;
  }
  if (schema.properties) return walk(schema, maxDepth) as Record<string, unknown>;
  if (schema.type === "array" && schema.items) return { "[]": walk(schema.items, maxDepth - 1) } as Record<string, unknown>;
  return null;
}

/** Extract a compact map of leaf key→value pairs from a sample response.
 *  Digs into the first array item at each level, stops at maxLeaves.
 *  Gives agents concrete examples of extractable data. */
/** Extract a compact map of leaf key→value pairs from a sample response.
 *  Digs into the first array item at each level, stops at maxLeaves.
 *  Skips metadata noise to surface actual data fields agents care about. */
export function extractSampleValues(sample: unknown, maxLeaves = 12): Record<string, unknown> | null {
  if (sample == null) return null;
  const SKIP_KEYS = new Set([
    "__typename", "entryType", "itemType", "clientEventInfo", "feedbackInfo",
    "controllerData", "injectionType", "sortIndex", "cursor", "cursorType",
    "displayTreatment", "socialContext", "promotedMetadata", "feedbackKeys",
    "tweetDisplayType", "element", "component", "details",
  ]);
  const out: Record<string, unknown> = {};
  let count = 0;
  function walk(obj: unknown, path: string, depth: number): void {
    if (count >= maxLeaves || depth > 10) return;
    if (obj == null) return;
    if (Array.isArray(obj)) {
      if (obj.length > 0) walk(obj[0], path + "[]", depth + 1);
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (count >= maxLeaves) break;
        if (SKIP_KEYS.has(k)) continue;
        const p = path ? `${path}.${k}` : k;
        if (v != null && typeof v === "object") {
          walk(v, p, depth + 1);
        } else if (v != null && v !== "" && v !== 0 && v !== false) {
          out[p] = typeof v === "string" && (v as string).length > 80
            ? (v as string).slice(0, 77) + "..."
            : v;
          count++;
        }
      }
      return;
    }
  }
  walk(sample, "", 0);
  return count > 0 ? out : null;
}
const BROWSER_CAPTURE_SKILL_ID = "browser-capture";

// Per-domain skill cache: after a live capture succeeds, cache the skill for 60s so
// subsequent requests hit the local cache instead of re-capturing (avoids EmergentDB lag).
const capturedDomainCache = new Map<
  string,
  { skill: SkillManifest; endpointId?: string; expires: number }
>();
// In-flight capture queue: concurrent callers for the same domain/scope should wait for
// the same live capture instead of failing fast.
const captureInFlight = new Map<
  string,
  Promise<{ learned_skill?: SkillManifest; trace: ExecutionTrace; result: unknown; parity_baseline?: unknown }>
>();
// Cross-client profile lock: some sites/profile dirs do not tolerate parallel browser
// launches against the same domain/profile. Serialize live captures per domain.
const captureDomainLocks = new Map<string, Promise<void>>();
// Route cache: intent+domain → skill_id, skips search+getSkill on repeat queries.
const skillRouteCache = new Map<
  string,
  { skillId: string; domain: string; endpointId?: string; localSkillPath?: string; ts: number }
>();
const ROUTE_CACHE_FILE = join(process.env.HOME ?? "/tmp", ".unbrowse", "route-cache.json");
const SKILL_SNAPSHOT_DIR = process.env.UNBROWSE_SKILL_SNAPSHOT_DIR
  ?? join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");
const ISOLATED_SKILL_SNAPSHOT_MODE = !!process.env.UNBROWSE_SKILL_SNAPSHOT_DIR;

// Domain-level skill cache: maps domain → best skillId (independent of intent/URL)
// This enables cross-intent reuse: "find keyboards" seeds cache, "find monitors" reuses it
export const domainSkillCache = new Map<string, { skillId: string; endpointId?: string; localSkillPath?: string; ts: number }>();
const DOMAIN_CACHE_FILE = join(process.env.HOME ?? "/tmp", ".unbrowse", "domain-skill-cache.json");

// Local skill caches (the internal-API HOLE-PIPING replay, pointer→pointer→value) — ON BY DEFAULT.
// Originally hard-disabled because stale skill_ids 404'd on execute (masking real backend gaps). That
// reason is CLOSED: the replay SELF-HEALS — a cached endpoint that fails on auto-exec invalidates +
// re-resolves (shouldFallbackToLiveCaptureAfterAutoexecFailure → invalidateResolveCacheEntries, route
// path ~:4856; the domain-cache evicts stale/low-score ~:4899). So a cached endpoint binds the RESOLVED
// VALUE (Exodus 28:32 — the binding around the hole, that it not be torn; sign the resolved blob, not
// the pointer string) — failures stay visible AND the holed endpoint is replayed instead of a cold
// re-resolve. Disable explicitly with UNBROWSE_LOCAL_CACHES=0; UNBROWSE_STATELESS=1 also forces off.
const LOCAL_CACHES_ENABLED =
  process.env.UNBROWSE_STATELESS !== "1" && process.env.UNBROWSE_LOCAL_CACHES !== "0";
/** Call-time read of the local-caches gate (persist/replay functions read this so a runtime env
 *  change is honoured. ON unless STATELESS or LOCAL_CACHES=0). */
function localCachesEnabled(): boolean {
  return process.env.UNBROWSE_STATELESS !== "1" && process.env.UNBROWSE_LOCAL_CACHES !== "0";
}

export function persistDomainCache() {
  if (!LOCAL_CACHES_ENABLED || ISOLATED_SKILL_SNAPSHOT_MODE) return;
  try {
    const dir = dirname(DOMAIN_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DOMAIN_CACHE_FILE, JSON.stringify(Object.fromEntries(domainSkillCache)), "utf-8");
  } catch { /* best effort */ }
}

if (LOCAL_CACHES_ENABLED && !ISOLATED_SKILL_SNAPSHOT_MODE) {
  try {
    if (existsSync(DOMAIN_CACHE_FILE)) {
      const data = JSON.parse(readFileSync(DOMAIN_CACHE_FILE, "utf-8"));
      for (const [k, v] of Object.entries(data)) {
        const entry = v as { skillId: string; endpointId?: string; localSkillPath?: string; ts: number };
        if (Date.now() - entry.ts < 7 * 24 * 60 * 60_000) {
          domainSkillCache.set(k, entry);
        }
      }
      console.error(`[domain-cache] loaded ${domainSkillCache.size} entries from disk`);
    }
  } catch { /* fresh start */ }
}

// Persist route cache to disk (debounced, with sync flush option)
let _routeCacheDirty = false;
function _writeRouteCacheToDisk() {
  if (!LOCAL_CACHES_ENABLED || ISOLATED_SKILL_SNAPSHOT_MODE) { _routeCacheDirty = false; return; }
  try {
    const dir = dirname(ROUTE_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = Object.fromEntries(skillRouteCache);
    writeFileSync(ROUTE_CACHE_FILE, JSON.stringify(entries), "utf-8");
  } catch { /* best effort */ }
  _routeCacheDirty = false;
}
function persistRouteCache() {
  _routeCacheDirty = true;
}
/** Flush route cache to disk immediately so other requests/processes see it. */
function flushRouteCacheSync() {
  _writeRouteCacheToDisk();
}
const routeCacheFlushTimer = setInterval(() => {
  if (!_routeCacheDirty) return;
  _writeRouteCacheToDisk();
}, 5_000);

/** Invalidate stale route cache entries for a domain and flush to disk immediately */
export function invalidateRouteCacheForDomain(domain: string): void {
  let deleted = 0;
  for (const [k] of skillRouteCache) {
    if (k.includes(`:${domain}:`) || k.includes(`:${domain.replace(/^www\./, "")}:`)) {
      skillRouteCache.delete(k);
      deleted++;
    }
  }
  if (deleted > 0 && LOCAL_CACHES_ENABLED) {
    // Flush immediately (not debounced) so other processes see the change
    try {
      const dir = dirname(ROUTE_CACHE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(ROUTE_CACHE_FILE, JSON.stringify(Object.fromEntries(skillRouteCache)), "utf-8");
    } catch { /* best effort */ }
    console.log(`[route-cache] invalidated ${deleted} stale entries for ${domain}`);
  }
}
routeCacheFlushTimer.unref?.();

// Load route cache from disk on startup (skipped when disk caches disabled)
if (LOCAL_CACHES_ENABLED && !ISOLATED_SKILL_SNAPSHOT_MODE) {
  try {
    if (existsSync(ROUTE_CACHE_FILE)) {
      const data = JSON.parse(readFileSync(ROUTE_CACHE_FILE, "utf-8"));
      for (const [k, v] of Object.entries(data)) {
        const entry = v as { skillId: string; domain: string; endpointId?: string; localSkillPath?: string; ts: number };
        if (Date.now() - entry.ts < 24 * 60 * 60_000) {
          skillRouteCache.set(k, entry);
        }
      }
      console.error(`[route-cache] loaded ${skillRouteCache.size} entries from disk`);
    }
  } catch { /* fresh start */ }
}
const routeResultCache = new Map<
  string,
  {
    skill: SkillManifest;
    endpointId?: string;
    result: unknown;
    trace: ExecutionTrace;
    expires: number;
  }
>();
const ROUTE_CACHE_TTL = 24 * 60 * 60_000; // 24 hours (persisted to disk)
const MARKETPLACE_HYDRATE_LIMIT = Math.max(1, Number(process.env.UNBROWSE_MARKETPLACE_HYDRATE_LIMIT ?? 4));
const MARKETPLACE_GET_SKILL_TIMEOUT_MS = Math.max(250, Number(process.env.UNBROWSE_MARKETPLACE_GET_SKILL_TIMEOUT_MS ?? 2500));
const MARKETPLACE_DOMAIN_SEARCH_K = Math.max(1, Number(process.env.UNBROWSE_MARKETPLACE_DOMAIN_SEARCH_K ?? 5));
const MARKETPLACE_GLOBAL_SEARCH_K = Math.max(1, Number(process.env.UNBROWSE_MARKETPLACE_GLOBAL_SEARCH_K ?? 10));
type SkillRouteCacheEntry = {
  skillId: string;
  domain: string;
  endpointId?: string;
  localSkillPath?: string;
  ts: number;
};
type RouteCacheCandidate = {
  scopedKey: string;
  scope: string;
  entry: SkillRouteCacheEntry;
  skill: SkillManifest;
};

export function scopedCacheKey(scope: string, key: string): string {
  return `${scope}:${key}`;
}

function scopedResolveCacheKeys(scope: string, key: string): string[] {
  return scope === "global"
    ? [scopedCacheKey("global", key)]
    : [scopedCacheKey(scope, key), scopedCacheKey("global", key)];
}

export function snapshotPathForCacheKey(cacheKey: string): string {
  const digest = createHash("sha1").update(cacheKey).digest("hex");
  return join(SKILL_SNAPSHOT_DIR, `${digest}.json`);
}

export function writeSkillSnapshot(cacheKey: string, skill: SkillManifest): string | undefined {
  // v7 stateless gate (Day-5 worker E): under UNBROWSE_STATELESS=1 disk
  // snapshots are suppressed. Already opt-in via UNBROWSE_LOCAL_CACHES;
  // stateless makes the suppression unambiguous (stricter superset).
  // Precedence: STATELESS wins over OFFLINE (Heb 7:18-19).
  if (process.env.UNBROWSE_STATELESS === "1") return undefined;
  if (!localCachesEnabled()) return undefined;
  try {
    mkdirSync(SKILL_SNAPSHOT_DIR, { recursive: true });
    const target = snapshotPathForCacheKey(cacheKey);
    // Seal-at-persist (opt-in, UNBROWSE_SEAL_STORAGE_HOLES=1): replace any plaintext
    // page_metadata.localStorage on the operation graph with sha256 commitments + push the
    // sealed blobs off-graph. Fail-CLOSED: if sealing is unavailable, skip persistence rather
    // than write plaintext. Flag off (default) → behaviour unchanged.
    let toWrite: SkillManifest = skill;
    if (process.env.UNBROWSE_SEAL_STORAGE_HOLES === "1") {
      try { toWrite = sealSkillSnapshotHoles(skill, deriveSealKey(), deriveCommitmentKey(), fsSealedBlobStore()); }
      catch { return undefined; }
    }
    writeFileSync(target, JSON.stringify(toWrite), "utf-8");
    return target;
  } catch {
    return undefined;
  }
}

// --- Composite contracts (the persisted contract sub-DAG of a multi-step resolution) ---
// internal/composition-persist-replay-plan.md lever 3. A composite is a local cache like a skill
// snapshot, under the same gate (off unless UNBROWSE_LOCAL_CACHES=1) — it can go stale exactly
// like the routes it composes; the backend graph stays the source of truth.
// Dir + gate read at CALL time (not module load) so a bench can flip UNBROWSE_LOCAL_CACHES
// mid-process and so the store is testable without env-at-import hoisting games.
function compositeSnapshotDir(): string {
  return process.env.UNBROWSE_COMPOSITE_DIR
    ?? join(process.env.HOME ?? "/tmp", ".unbrowse", "composites");
}

export interface PersistedComposite {
  composite_id: string;
  intent_signature: string;
  domain: string;
  target: string;
  steps: ChainStepInfo[];
  edges: CompositeEdge[];
  created_at: string;
  /** Merkle content-id: structure ⊕ the constituent endpoints' content-hashes. A constituent
   *  endpoint definition change re-hashes this, so a (domain,target) lookup hit can detect the
   *  composite is stale and re-walk instead of serving the old chain. Absent on pre-Merkle
   *  composites → treated as stale (fail-closed). */
  content_id?: string;
}
// NOTE (cache cascade, Dominion prune): a composite's VALUE cascade does NOT live here. readComposite
// is the PRE-walk lookup — the resolved values don't exist yet at read time, so a value_id on the
// composite is structurally inert. The values-ledger pointer→pointer cascade (a change in a consumed
// value invalidating a dependent) lives in src/values/cached-resolution.ts (cachedResolution.dependsOn),
// which is where resolved VALUES are content-addressed. Composites carry only the SHAPE cascade.

/** Content-address a composite by what makes it the SAME DAG: the domain, the target endpoint, the
 *  ordered constituent endpoints, and the binding edges. This is structural identity (used by
 *  settle/publish, levers 5–6) — intent phrasing is metadata, NOT identity, since the prerequisite
 *  structure is a property of the target endpoint, not how the user asked. */
export function compositeAddress(
  domain: string,
  target: string,
  steps: ChainStepInfo[],
  edges: CompositeEdge[],
): string {
  const canonical = [
    `domain:${domain}`,
    `target:${target}`,
    `steps:${steps.map((s) => s.endpoint_id).join(">")}`,
    `edges:${edges.map((e) => `${e.from}.${e.binding}->${e.to}`).sort().join("|")}`,
  ].join("::");
  return `composite:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** Content-hash of ONE endpoint's replay-relevant definition. A re-capture that changes the method
 *  or URL template re-hashes the endpoint, which cascades into any composite that includes it. Only
 *  the fields that affect replay correctness are folded (NOT volatile metadata like timestamps). */
export function endpointContentHash(ep: { endpoint_id: string; method?: string; url_template?: string }): string {
  const canonical = `id:${ep.endpoint_id}::method:${ep.method ?? ""}::url:${ep.url_template ?? ""}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Merkle content-id for a composite: the structural address ⊕ the ordered content-hashes of its
 * constituent endpoints (looked up in `endpointContentById`). A constituent endpoint definition
 * change ⇒ its content-hash changes ⇒ the composite content-id changes ⇒ a (domain,target) lookup
 * hit recomputes a different id and invalidates (cascade). A step whose endpoint is absent from the
 * current skill hashes as "gone" (also a change → invalidate). Deterministic; no clock.
 */
export function compositeContentId(
  domain: string,
  target: string,
  steps: ChainStepInfo[],
  edges: CompositeEdge[],
  endpointContentById: Map<string, string>,
): string {
  const stepHashes = steps.map((s) => `${s.endpoint_id}=${endpointContentById.get(s.endpoint_id) ?? "gone"}`).join(">");
  const canonical = `${compositeAddress(domain, target, steps, edges)}::steps:${stepHashes}`;
  return `cid:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** Build the endpoint content-hash map from a skill's current endpoints (the inputs to a recompute). */
export function endpointContentMap(endpoints: Array<{ endpoint_id: string; method?: string; url_template?: string }>): Map<string, string> {
  return new Map(endpoints.map((ep) => [ep.endpoint_id, endpointContentHash(ep)]));
}

/** Replay LOOKUP key — what a resolve knows BEFORE the walk: the domain and the target endpoint it
 *  picked. Maps to the persisted composite so replay finds the recorded step order without re-walking.
 *  (The full content-address needs steps+edges, which only exist after the walk — so the filename is
 *  this pre-walk key, and composite_id rides inside as the structural identity.) */
export function compositeLookupKey(domain: string, target: string): string {
  const canonical = `domain:${domain}::target:${target}`;
  return `lookup:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function compositeFilePath(lookupKey: string): string {
  return join(compositeSnapshotDir(), `${lookupKey.replace(/[^a-z0-9]/gi, "_")}.json`);
}

export function writeComposite(
  c: PersistedComposite,
  // Current skill endpoints — stamps the Merkle content_id so a later readComposite can detect a
  // constituent change and cascade-invalidate. Omitted → content_id left as-is (legacy).
  currentEndpoints?: Array<{ endpoint_id: string; method?: string; url_template?: string }>,
): string | undefined {
  if (process.env.UNBROWSE_STATELESS === "1") return undefined;
  if (process.env.UNBROWSE_LOCAL_CACHES !== "1") return undefined;
  try {
    mkdirSync(compositeSnapshotDir(), { recursive: true });
    const target = compositeFilePath(compositeLookupKey(c.domain, c.target));
    const stamped =
      currentEndpoints && !c.content_id
        ? { ...c, content_id: compositeContentId(c.domain, c.target, c.steps, c.edges, endpointContentMap(currentEndpoints)) }
        : c;
    writeFileSync(target, JSON.stringify(stamped), "utf-8");
    return target;
  } catch {
    return undefined;
  }
}

/** Look up a persisted composite by the pre-walk key (domain + target endpoint). On hit, the caller
 *  replays the recorded `steps` in order instead of re-deriving the prerequisite order. */
export function readComposite(
  domain: string,
  target: string,
  // The CURRENT skill endpoints. When supplied, the stored composite is validated by recomputing its
  // Merkle content-id from these endpoints — a constituent definition change (or a pre-Merkle
  // composite with no content_id) yields a mismatch and the entry is invalidated (return undefined →
  // the caller re-walks), never served stale. Omitted → legacy behaviour (return as-is).
  currentEndpoints?: Array<{ endpoint_id: string; method?: string; url_template?: string }>,
): PersistedComposite | undefined {
  try {
    const path = compositeFilePath(compositeLookupKey(domain, target));
    if (!existsSync(path)) return undefined;
    const c = JSON.parse(readFileSync(path, "utf-8")) as PersistedComposite;
    if (currentEndpoints) {
      if (!c.content_id) return undefined; // fail-closed: pre-Merkle composite → re-walk once
      const expected = compositeContentId(domain, target, c.steps, c.edges, endpointContentMap(currentEndpoints));
      if (expected !== c.content_id) return undefined; // a constituent SHAPE changed → cascade-invalidate
    }
    return c;
  } catch {
    return undefined;
  }
}

/**
 * Lever 6 — the ALWAYS-ON replay source: a composite that travelled back ATTACHED to the resolved
 * skill manifest (published by whichever agent first walked it). A foreign agent that never walked
 * the chain replays it. Pure; ungated (unlike the local-disk cache) — the resolved skill is data
 * the backend already returned, not a local cache. Matched by the target endpoint id.
 */
export function findCompositeInSkill(
  skill: { composites?: SkillComposite[] } | undefined,
  target: string,
): SkillComposite | undefined {
  return skill?.composites?.find((c) => c.target === target && c.steps.length > 0);
}

/** Attach a freshly-walked composite to a skill (dedup by composite_id) so it travels with the
 *  skill into the local cache and any subsequent publish — the path by which lever 6 reaches the
 *  backend graph. Mutates `skill.composites` in place. Returns true iff it was newly added (a caller
 *  can then queue a republish to propagate the new composite to the backend). */
export function attachCompositeToSkill(skill: SkillManifest, composite: SkillComposite): boolean {
  const list = skill.composites ?? (skill.composites = []);
  if (list.some((c) => c.composite_id === composite.composite_id)) return false;
  list.push(composite);
  return true;
}

function hasSearchBindings(endpoint: SkillManifest["endpoints"][number]): boolean {
  const haystack = JSON.stringify({
    url: endpoint.url_template,
    query: endpoint.query ?? {},
    body_params: endpoint.body_params ?? {},
    body: endpoint.body ?? {},
    semantic: endpoint.semantic ?? {},
  }).toLowerCase();
  return /(basicsearchkey|query|keyword|search|lookup|find|term)/.test(haystack);
}

function scoreSkillSnapshot(skill: SkillManifest): number {
  let score = 0;
  for (const endpoint of skill.endpoints) {
    const active = endpoint.verification_status !== "disabled";
    if (active) score += 20;
    if (endpoint.dom_extraction || endpoint.response_schema) score += 10;
    if (hasSearchBindings(endpoint)) score += 40;
    if (endpoint.method === "POST") score += 6;
    if (/\/result-page\b/i.test(endpoint.url_template)) score += 12;
    if (/captured page artifact/i.test(endpoint.description ?? "")) score -= 18;
  }
  return score + skill.endpoints.length;
}

export function pickPreferredSkillSnapshot(
  primary: SkillManifest,
  candidates: SkillManifest[],
): SkillManifest {
  let best = primary;
  let bestScore = scoreSkillSnapshot(primary);
  for (const candidate of candidates) {
    if (candidate.skill_id !== primary.skill_id) continue;
    const candidateScore = scoreSkillSnapshot(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

export function readSkillSnapshot(path?: string): SkillManifest | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const primary = JSON.parse(readFileSync(path, "utf-8")) as SkillManifest;
    if (!existsSync(SKILL_SNAPSHOT_DIR)) return primary;
    const siblingSnapshots: SkillManifest[] = [];
    for (const entry of readdirSync(SKILL_SNAPSHOT_DIR)) {
      if (!entry.endsWith(".json")) continue;
      const candidatePath = join(SKILL_SNAPSHOT_DIR, entry);
      if (candidatePath === path) continue;
      try {
        const candidate = JSON.parse(readFileSync(candidatePath, "utf-8")) as SkillManifest;
        if (candidate.skill_id === primary.skill_id) siblingSnapshots.push(candidate);
      } catch {
        /* ignore bad snapshot */
      }
    }
    return pickPreferredSkillSnapshot(primary, siblingSnapshots);
  } catch {
    return undefined;
  }
}

function findBestLocalDomainSnapshot(
  requestedDomain: string,
  intent: string,
  contextUrl?: string,
  excludeSkillIds?: ReadonlySet<string>,
): SkillManifest | undefined {
  if (!existsSync(SKILL_SNAPSHOT_DIR)) return undefined;
  const targetDomain = getRegistrableDomain(requestedDomain);
  const bestBySkill = new Map<string, SkillManifest>();
  for (const entry of readdirSync(SKILL_SNAPSHOT_DIR)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const candidate = JSON.parse(readFileSync(join(SKILL_SNAPSHOT_DIR, entry), "utf-8")) as SkillManifest;
      if (getRegistrableDomain(candidate.domain) !== targetDomain) continue;
      if (excludeSkillIds?.has(candidate.skill_id)) continue;
      const existing = bestBySkill.get(candidate.skill_id);
      bestBySkill.set(
        candidate.skill_id,
        existing ? pickPreferredSkillSnapshot(existing, [candidate]) : candidate,
      );
    } catch {
      /* ignore bad snapshot */
    }
  }
  let best: SkillManifest | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of bestBySkill.values()) {
    if (!hasUsableEndpoints(candidate)) continue;
    if (!isCachedSkillRelevantForIntent(candidate, intent, contextUrl)) continue;
    if (!marketplaceSkillMatchesContext(candidate, intent, contextUrl)) continue;
    const ranked = rankEndpoints(candidate.endpoints, intent, candidate.domain, contextUrl);
    const topScore = ranked[0]?.score ?? Number.NEGATIVE_INFINITY;
    const composite = topScore + scoreSkillSnapshot(candidate);
    if (composite > bestScore) {
      best = candidate;
      bestScore = composite;
    }
  }
  return best;
}

/**
 * Find an endpoint by ID across all locally-cached skill snapshots.
 * Used by execute's defensive recovery path when the agent passes an
 * endpoint_id that's not in the currently-loaded skill (BUG-3 from the
 * 2026-05-17 MCP bench-gate: a publish that re-merged endpoints with
 * different url_template normalization could shift the stableEndpointId,
 * making the resolve-returned ID look "gone" to execute even though the
 * endpoint descriptor still exists in an earlier snapshot of the same
 * skill_id). When the agent's resolve returned this ID, the agent's
 * execute should be able to use it. Substrate honors the contract.
 *
 * Returns the first matching endpoint found in any snapshot. Scans every
 * snapshot — small N (low-hundreds of skills max on a working machine),
 * O(skills * endpoints/skill) per lookup, fine for an exceptional path.
 */
export function findEndpointInSkillHistory(
  endpointId: string,
  skillId?: string,
): { endpoint: SkillManifest["endpoints"][number]; via_skill: SkillManifest } | undefined {
  if (!existsSync(SKILL_SNAPSHOT_DIR)) return undefined;
  if (!endpointId) return undefined;
  for (const entry of readdirSync(SKILL_SNAPSHOT_DIR)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const candidate = JSON.parse(readFileSync(join(SKILL_SNAPSHOT_DIR, entry), "utf-8")) as SkillManifest;
      // If the caller named a skill_id, prefer same-id matches but still
      // return cross-skill matches as a last resort — same endpoint_id
      // implies same (method, url_template) by construction of
      // stableEndpointId, so the endpoint IS the same logical operation.
      if (skillId && candidate.skill_id !== skillId) continue;
      const ep = (candidate.endpoints ?? []).find((e) => e.endpoint_id === endpointId);
      if (ep) return { endpoint: ep, via_skill: candidate };
    } catch {
      /* ignore bad snapshot */
    }
  }
  // Fallback: any skill (not just the named one) that contains this endpoint_id.
  if (skillId) {
    for (const entry of readdirSync(SKILL_SNAPSHOT_DIR)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const candidate = JSON.parse(readFileSync(join(SKILL_SNAPSHOT_DIR, entry), "utf-8")) as SkillManifest;
        if (candidate.skill_id === skillId) continue; // already scanned
        const ep = (candidate.endpoints ?? []).find((e) => e.endpoint_id === endpointId);
        if (ep) return { endpoint: ep, via_skill: candidate };
      } catch {
        /* ignore bad snapshot */
      }
    }
  }
  return undefined;
}


function isIpv4Hostname(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isIpv6Hostname(hostname: string): boolean {
  return hostname.includes(":");
}

function isPortSensitiveHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    isIpv4Hostname(normalized) ||
    isIpv6Hostname(normalized) ||
    !normalized.includes(".")
  );
}

export function getDomainReuseKey(input?: string | null): string | null {
  if (!input) return null;
  try {
    const parsed = new URL(input);
    if (isPortSensitiveHostname(parsed.hostname)) return parsed.host.toLowerCase();
    return getRegistrableDomain(parsed.hostname);
  } catch {
    return getRegistrableDomain(input);
  }
}

function endpointMatchesContextOrigin(
  endpoint: SkillManifest["endpoints"][number],
  contextUrl?: string,
): boolean {
  if (!contextUrl) return true;
  try {
    const context = new URL(contextUrl);
    if (!isPortSensitiveHostname(context.hostname)) return true;
    const sameOrigin = (candidate?: string | null): boolean => {
      if (!candidate) return false;
      try {
        return new URL(candidate).origin === context.origin;
      } catch {
        return false;
      }
    };
    return sameOrigin(endpoint.url_template) || sameOrigin(endpoint.trigger_url ?? null);
  } catch {
    return true;
  }
}

function endpointTargetsMismatchedLocalReplayHost(
  endpoint: SkillManifest["endpoints"][number],
  contextUrl?: string,
): boolean {
  if (!contextUrl) return false;
  try {
    const context = new URL(contextUrl);
    if (isPortSensitiveHostname(context.hostname)) return false;
    const endpointUrl = new URL(endpoint.url_template);
    if (!/^https?:$/i.test(endpointUrl.protocol)) return false;
    if (!isPortSensitiveHostname(endpointUrl.hostname)) return false;
    return endpointUrl.origin !== context.origin;
  } catch {
    return false;
  }
}

function endpointHasNegativeTag(
  endpoint: SkillManifest["endpoints"][number],
  tag: string,
): boolean {
  return (endpoint.semantic?.negative_tags ?? []).some(
    (candidate) => candidate.trim().toLowerCase() === tag.trim().toLowerCase(),
  );
}

function isResolveUsableEndpointForIntent(
  endpoint: SkillManifest["endpoints"][number],
  intent?: string,
  contextUrl?: string,
): boolean {
  if (endpointTargetsMismatchedLocalReplayHost(endpoint, contextUrl)) return false;
  if (isMessagingIntent(intent, contextUrl) && !endpointMatchesMessagingContext(endpoint, contextUrl)) {
    return false;
  }
  if (isFeedTimelineIntent(intent, contextUrl) && endpointHasNegativeTag(endpoint, "helper")) {
    return false;
  }
  return true;
}

function normalizeRouteContext(url?: string): string {
  if (!url) return "root";
  try {
    const parsed = new URL(url);
    const keep = ["q", "query", "keywords", "term", "search", "type", "tab", "f", "sort"];
    const query = new URLSearchParams();
    for (const key of keep) {
      const value = parsed.searchParams.get(key);
      if (value) query.set(key, value);
    }
    const queryText = query.toString();
    return `${parsed.origin}${parsed.pathname}${queryText ? `?${queryText}` : ""}`;
  } catch {
    return url;
  }
}

export function buildResolveCacheKey(domain: string | null, intent: string, url?: string): string {
  return `${domain || "global"}:${intent.trim().toLowerCase()}:${normalizeRouteContext(url)}`;
}

function promoteLearnedSkill(
  scope: string,
  cacheKey: string,
  skill: SkillManifest,
  endpointId?: string,
  contextUrl?: string,
): void {
  if (!localCachesEnabled()) return;
  const localSkillPath = writeSkillSnapshot(cacheKey, skill);
  capturedDomainCache.set(cacheKey, { skill, endpointId, expires: Date.now() + 5 * 60_000 });
  skillRouteCache.set(cacheKey, {
    skillId: skill.skill_id,
    domain: skill.domain,
    endpointId,
    ...(localSkillPath ? { localSkillPath } : {}),
    ts: Date.now(),
  });
  persistRouteCache();
  // Also cache at domain level for cross-intent reuse
  const domainKey = getDomainReuseKey(contextUrl ?? skill.domain);
  if (domainKey) {
    domainSkillCache.set(domainKey, {
      skillId: skill.skill_id,
      endpointId,
      ...(localSkillPath ? { localSkillPath } : {}),
      ts: Date.now(),
    });
    persistDomainCache();
  }
}

function cacheResolvedSkill(
  cacheKey: string,
  skill: SkillManifest,
  endpointId?: string,
): void {
  if (!localCachesEnabled()) return;
  const localSkillPath = writeSkillSnapshot(cacheKey, skill);
  skillRouteCache.set(cacheKey, {
    skillId: skill.skill_id,
    domain: skill.domain,
    endpointId,
    ...(localSkillPath ? { localSkillPath } : {}),
    ts: Date.now(),
  });
  persistRouteCache();
}

function promoteResultSnapshot(
  cacheKey: string,
  skill: SkillManifest,
  endpointId: string | undefined,
  result: unknown,
  trace: ExecutionTrace,
): void {
  if (!localCachesEnabled()) return;
  routeResultCache.set(cacheKey, {
    skill,
    endpointId,
    result,
    trace,
    expires: Date.now() + ROUTE_CACHE_TTL,
  });
}

function buildCachedResultResponse(
  cached: {
    skill: SkillManifest;
    endpointId?: string;
    result: unknown;
    trace: ExecutionTrace;
  },
  source: "marketplace" | "live-capture",
  timing: OrchestrationTiming,
): OrchestratorResult {
  const now = new Date().toISOString();
  return {
    result: cached.result,
    trace: {
      ...cached.trace,
      trace_id: nanoid(),
      started_at: now,
      completed_at: now,
      endpoint_id: cached.endpointId ?? cached.trace.endpoint_id,
      skill_id: cached.skill.skill_id,
    },
    source,
    skill: cached.skill,
    timing,
  };
}

function invalidateResolveCacheEntries(cacheKeys: string[], domainKeys: string[] = []): void {
  let routeCacheDirty = false;
  let domainCacheDirty = false;
  for (const cacheKey of new Set(cacheKeys.filter(Boolean))) {
    routeResultCache.delete(cacheKey);
    capturedDomainCache.delete(cacheKey);
    if (skillRouteCache.delete(cacheKey)) routeCacheDirty = true;
  }
  for (const domainKey of new Set(domainKeys.filter(Boolean))) {
    if (domainSkillCache.delete(domainKey)) domainCacheDirty = true;
  }
  if (routeCacheDirty) persistRouteCache();
  if (domainCacheDirty) persistDomainCache();
}

async function getSkillWithTimeout(
  skillId: string,
  scope: string,
  timeoutMs = MARKETPLACE_GET_SKILL_TIMEOUT_MS,
): Promise<SkillManifest | null> {
  return Promise.race([
    getSkill(skillId, scope),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

export function promoteExplicitExecution(
  scope: string,
  intent: string | undefined,
  contextUrl: string | undefined,
  skill: SkillManifest,
  endpointId: string | undefined,
  result: unknown,
): boolean {
  if (!intent || !contextUrl) return false;
  const assessment = assessIntentResult(result, intent);
  if (assessment.verdict === "fail") return false;
  const cacheKey = buildResolveCacheKey(skill.domain, intent, contextUrl);
  promoteLearnedSkill(scope, cacheKey, skill, endpointId, contextUrl);
  return true;
}

export function shouldBypassLiveCaptureQueue(_url?: string): boolean {
  // Phase 8.3 cleanup: per-host structured-replay registry was deleted.
  // Live capture is no longer bypassed for "known-rewriteable" hosts.
  return false;
}

function withContextReplayEndpoint(
  skill: SkillManifest,
  _intent: string,
  _contextUrl?: string,
): SkillManifest {
  // Phase 8.3 cleanup: per-host structured-replay registry was deleted.
  // The probe-first executor now derives replay URLs at execute time, so this
  // pre-resolve canonical-endpoint augmentation is a no-op.
  return skill;
}

function isSearchLikeIntent(intent?: string, contextUrl?: string): boolean {
  if (/\b(search|find|lookup|browse|discover)\b/i.test(intent ?? "")) return true;
  try {
    const pathname = contextUrl ? new URL(contextUrl).pathname.toLowerCase() : "";
    return /\/(?:search|basic-search|result-page|results?|discover|browse)\b/.test(pathname);
  } catch {
    return false;
  }
}

function buildLocalCanonicalReplaySkill(
  _intent: string,
  _contextUrl: string,
): SkillManifest | undefined {
  // Phase 8.3 cleanup: per-host structured-replay registry was deleted.
  // No deterministic local canonical skill can be synthesised without it;
  // the live-capture path is the sole source of truth now.
  return undefined;
}

export function isCachedSkillRelevantForIntent(
  skill: SkillManifest,
  intent?: string,
  contextUrl?: string,
): boolean {
  if (!hasUsableEndpoints(skill)) return false;
  if (contextUrl && !skill.endpoints.some((endpoint) => endpointMatchesContextOrigin(endpoint, contextUrl))) {
    return false;
  }
  if (!intent || intent.trim().length === 0) return true;
  const resolvedSkill = withContextReplayEndpoint(skill, intent, contextUrl);
  const usableEndpoints = resolvedSkill.endpoints.filter((endpoint) =>
    isResolveUsableEndpointForIntent(endpoint, intent, contextUrl),
  );
  if (usableEndpoints.length === 0) return false;
  const candidateSkill =
    usableEndpoints.length === resolvedSkill.endpoints.length
      ? resolvedSkill
      : { ...resolvedSkill, endpoints: usableEndpoints };
  if (isFeedTimelineIntent(intent, contextUrl)) {
    const hasFeedLikeEndpoint = candidateSkill.endpoints.some((endpoint) =>
      endpointMatchesFeedTimelineContext(endpoint, contextUrl),
    );
    if (!hasFeedLikeEndpoint) return false;
  }
  const ranked = rankEndpoints(
    candidateSkill.endpoints,
    intent,
    candidateSkill.domain,
    contextUrl,
  );
  const top = ranked[0];
  const isSearchIntent = isSearchLikeIntent(intent, contextUrl);
  if (
    top &&
    isSearchIntent &&
    contextUrl &&
    /captured page artifact/i.test(top.endpoint.description ?? "") &&
    top.endpoint.response_schema?.type !== "array" &&
    top.endpoint.url_template === contextUrl &&
    !skillHasBetterStructuredSearchEndpoint(
      resolvedSkill,
        top.endpoint.endpoint_id,
        intent,
        contextUrl,
    )
  ) {
    return false;
  }
  if (
    top &&
    isEducationCatalogIntent(intent) &&
    isRootContextUrl(contextUrl) &&
    /captured page artifact/i.test(top.endpoint.description ?? "") &&
    top.endpoint.url_template === contextUrl
  ) {
    return false;
  }
  if (isSearchIntent) {
    const hasStructuredSearchEndpoint = candidateSkill.endpoints.some((endpoint) =>
      endpointHasSearchBindings(endpoint) &&
      (!!endpoint.dom_extraction || !!endpoint.response_schema) &&
      endpointMatchesContextOrigin(endpoint, contextUrl) &&
      endpointMatchesExplicitSearchContext(endpoint, contextUrl),
    );
    if (hasStructuredSearchEndpoint) return true;
    // Allow SSR-extracted or RPC-style endpoints that match the intent by URL path,
    // even without declared search bindings (e.g. youtubei/v1/search for "search songs")
    if (top && top.score >= 0) {
      try {
        const topPath = new URL(top.endpoint.url_template).pathname.toLowerCase();
        if (/\/(search|find|query|browse|explore)\b/.test(topPath)) return true;
      } catch {}
    }
    if (collectExplicitSearchContextBindingKeys(contextUrl).size > 0) return false;
  }
  // Primary gate: positive relevance score wins outright.
  if ((top?.score ?? Number.NEGATIVE_INFINITY) >= 0) return true;
  // Weak-relevance fallback: when the best endpoint is slightly negative
  // (e.g. opensea's features.opensea.io/api/frontend scored -1.4) but is
  // on the same registrable domain as the request context, return it
  // rather than dropping the whole skill. Dropping yields "no relevant
  // endpoint discovered" which is worse for the agent than a weakly-
  // scored on-domain API call they can inspect and decide on.
  if (top && top.score >= -5 && contextUrl) {
    try {
      const epHost = new URL(top.endpoint.url_template).hostname;
      const ctxHost = new URL(contextUrl).hostname;
      const epReg = getRegistrableDomain(epHost);
      const ctxReg = getRegistrableDomain(ctxHost);
      if (epReg && ctxReg && epReg === ctxReg) return true;
    } catch {
      /* malformed URL — fall through to reject */
    }
  }
  return false;
}

export function assessLocalExecutionResult(
  endpoint: SkillManifest["endpoints"][number],
  result: unknown,
  intent: string,
  trace?: ExecutionTrace,
): { verdict: "pass" | "fail" | "skip"; reason: string } {
  const semanticAssessment = assessIntentResult(result, intent);
  if (!/\b(search|find|lookup|browse|discover)\b/i.test(intent)) return semanticAssessment;
  if (endpoint.response_schema?.type !== "array") return semanticAssessment;
  if (Array.isArray(result)) {
    if (result.length === 0) return { verdict: "fail", reason: "search_empty_results" };
    const rows = result.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
    if (rows.length === 0) return semanticAssessment;
    const authBounce = rows.some((row) => {
      const title = String(row.title ?? row.name ?? "").trim().toLowerCase();
      const description = String(row.description ?? row.summary ?? "").trim().toLowerCase();
      const link = String(row.link ?? row.url ?? "").trim().toLowerCase();
      return /^(about|home|welcome)\b/.test(title) ||
        /\b(login|log in|sign in|password)\b/.test(`${title} ${description}`) ||
        /\/(?:about|home|login)\b/.test(link);
    });
    if (authBounce) return { verdict: "fail", reason: "search_auth_or_homepage_bounce" };
    const hasStructuredRows = rows.some((row) =>
      typeof row.title === "string" ||
      typeof row.name === "string" ||
      typeof row.case_name === "string" ||
      typeof row.citation === "string",
    );
    if (hasStructuredRows) return { verdict: "pass", reason: "search_result_rows" };
    return semanticAssessment;
  }
  if (result == null || typeof result !== "object") return semanticAssessment;

  const record = result as Record<string, unknown>;
  const title = String(record.title ?? "").trim().toLowerCase();
  const link = String(record.link ?? record.url ?? "").trim().toLowerCase();
  const description = String(record.description ?? "").trim().toLowerCase();
  const finalUrl = String(
    (trace?.result as Record<string, unknown> | undefined)?._extraction &&
      typeof (trace?.result as Record<string, unknown>)._extraction === "object"
      ? ((trace?.result as Record<string, unknown>)._extraction as Record<string, unknown>).final_url ?? ""
      : "",
  )
    .trim()
    .toLowerCase();
  const looksLikeHomeOrAuthPage =
    /^(about|home|welcome)\b/.test(title) ||
    /\b(login|log in|sign in|password)\b/.test(`${title} ${description}`) ||
    /\/(?:about|home|login)\b/.test(`${link} ${finalUrl}`);
  if (looksLikeHomeOrAuthPage) {
    return { verdict: "fail", reason: "search_auth_or_homepage_bounce" };
  }
  return { verdict: "fail", reason: "search_result_shape_mismatch" };
}

function isEducationCatalogIntent(intent?: string): boolean {
  return /\b(module|modules|course|courses|class|classes|lesson|lessons|timetable|schedule|semester|semesters)\b/i.test(intent ?? "");
}

function isFeedTimelineIntent(intent?: string, contextUrl?: string): boolean {
  const text = `${intent ?? ""} ${contextUrl ?? ""}`.toLowerCase();
  const asksForPosts = /\b(post|posts|tweet|tweets|status|statuses|update|updates)\b/.test(text);
  if (!asksForPosts) return false;
  return /\b(feed|timeline|stream|home|for-you|for_you|latest)\b/.test(text) || /\/(feed|home)\//.test(text);
}

function isMessagingIntent(intent?: string, contextUrl?: string): boolean {
  const text = `${intent ?? ""} ${contextUrl ?? ""}`.toLowerCase();
  return /\b(message|messages|messaging|mailbox|inbox|conversation|conversations|chat|dm|dms|thread|threads)\b/.test(text)
    || /\/messaging\b/.test(text);
}

function endpointMatchesMessagingContext(
  endpoint: SkillManifest["endpoints"][number],
  contextUrl?: string,
): boolean {
  const haystack = [
    endpoint.url_template,
    endpoint.trigger_url ?? "",
    endpoint.description ?? "",
    endpoint.semantic?.action_kind ?? "",
    endpoint.semantic?.resource_kind ?? "",
    endpoint.semantic?.description_in ?? "",
    endpoint.semantic?.description_out ?? "",
    JSON.stringify(endpoint.response_schema ?? {}),
  ]
    .join(" ")
    .toLowerCase();

  if (/\b(message|messages|messaging|mailbox|inbox|conversation|conversations|chat|dm|dms|thread|threads)\b/.test(haystack)) {
    return true;
  }

  if (!contextUrl) return false;
  try {
    const contextPath = new URL(contextUrl).pathname;
    const endpointPath = new URL(endpoint.url_template).pathname;
    if (contextPath === endpointPath && /\/messaging\b/.test(contextPath)) return true;
  } catch {
    // ignore malformed endpoint/template urls
  }

  try {
    const triggerPath = endpoint.trigger_url ? new URL(endpoint.trigger_url).pathname : "";
    if (/\/messaging\b/.test(triggerPath)) return true;
  } catch {
    // ignore malformed trigger urls
  }

  return false;
}

function endpointMatchesFeedTimelineContext(
  endpoint: SkillManifest["endpoints"][number],
  contextUrl?: string,
): boolean {
  const haystack = [
    endpoint.url_template,
    endpoint.trigger_url ?? "",
    endpoint.description ?? "",
    endpoint.semantic?.action_kind ?? "",
    endpoint.semantic?.resource_kind ?? "",
    endpoint.semantic?.description_in ?? "",
    endpoint.semantic?.description_out ?? "",
    JSON.stringify(endpoint.response_schema ?? {}),
  ]
    .join(" ")
    .toLowerCase();
  const mentionsFeed = /\b(feed|timeline|stream|mainfeed|main feed|home)\b/.test(haystack);
  const mentionsPosts = /\b(post|posts|tweet|tweets|status|statuses|update|updates)\b/.test(haystack);
  if (mentionsFeed && mentionsPosts) return true;
  if (!contextUrl) return false;
  try {
    const contextPath = new URL(contextUrl).pathname;
    const endpointPath = new URL(endpoint.url_template).pathname;
    if (endpointPath === contextPath) return true;
  } catch {
    // ignore
  }
  try {
    if (!endpoint.trigger_url) return false;
    const triggerPath = new URL(endpoint.trigger_url).pathname;
    return triggerPath === new URL(contextUrl).pathname;
  } catch {
    return false;
  }
}

function endpointHasSearchBindings(
  endpoint: SkillManifest["endpoints"][number],
): boolean {
  // Primary check: if the endpoint carries a structured search form, use the
  // canonical isStructuredSearchForm predicate (fields.length > 0 && submit_selector set).
  if (endpoint.search_form && isStructuredSearchForm(endpoint.search_form)) {
    return true;
  }
  // Fallback: regex over serialised query/body/semantic keys for API-style search params.
  const haystack = JSON.stringify({
    query: endpoint.query ?? {},
    body: endpoint.body ?? {},
    body_params: endpoint.body_params ?? {},
    semantic: endpoint.semantic ?? {},
  }).toLowerCase();
  return /(?:^|[^a-z])(q|s|text|basicsearchkey|basic_search_key|query|keyword|search|lookup|find|term)(?:[^a-z]|$)/.test(haystack);
}

function isSearchBindingLikeKey(key: string): boolean {
  return /\b(q|query|queries|keyword|keywords|search|lookup|find|term|text|rawquery|raw_query)\b/i.test(key);
}

function collectExplicitSearchContextBindingKeys(contextUrl?: string): Set<string> {
  const keys = new Set<string>();
  if (!contextUrl) return keys;
  try {
    const url = new URL(contextUrl);
    for (const rawKey of url.searchParams.keys()) {
      if (!isSearchBindingLikeKey(rawKey)) continue;
      keys.add(rawKey.toLowerCase());
      keys.add(normalizeQueryBindingKey(rawKey).toLowerCase());
    }
  } catch {
    // ignore malformed context urls
  }
  return keys;
}

function collectEndpointBindingKeys(
  endpoint: SkillManifest["endpoints"][number],
): Set<string> {
  const keys = new Set<string>();
  const add = (rawKey?: string | null) => {
    if (!rawKey) return;
    const trimmed = rawKey.trim();
    if (!trimmed) return;
    keys.add(trimmed.toLowerCase());
    keys.add(normalizeQueryBindingKey(trimmed).toLowerCase());
  };
  for (const rawKey of Object.keys(extractTemplateQueryBindings(endpoint.url_template))) add(rawKey);
  for (const rawKey of Object.keys(endpoint.query ?? {})) add(rawKey);
  for (const rawKey of Object.keys(endpoint.body ?? {})) add(rawKey);
  for (const rawKey of Object.keys(endpoint.body_params ?? {})) add(rawKey);
  for (const rawKey of Object.keys(endpoint.semantic?.example_request ?? {})) add(rawKey);
  for (const field of endpoint.search_form?.fields ?? []) add(field.name);
  for (const binding of endpoint.semantic?.requires ?? []) add(binding.key);
  return keys;
}

function endpointMatchesExplicitSearchContext(
  endpoint: SkillManifest["endpoints"][number],
  contextUrl?: string,
): boolean {
  const contextBindings = collectExplicitSearchContextBindingKeys(contextUrl);
  if (contextBindings.size === 0) return true;
  if (!endpointHasSearchBindings(endpoint)) return false;
  const endpointBindings = collectEndpointBindingKeys(endpoint);
  if (endpointBindings.size === 0) return false;
  for (const key of contextBindings) {
    if (endpointBindings.has(key)) return true;
  }
  const contextHasSearchAlias = [...contextBindings].some((key) => isSearchBindingLikeKey(key));
  const endpointHasSearchAlias = [...endpointBindings].some((key) => isSearchBindingLikeKey(key));
  return contextHasSearchAlias && endpointHasSearchAlias;
}

function skillHasBetterStructuredSearchEndpoint(
  skill: SkillManifest,
  currentEndpointId: string | undefined,
  intent: string,
  contextUrl?: string,
): boolean {
  if (!isSearchLikeIntent(intent, contextUrl)) return false;
  return rankEndpoints(skill.endpoints, intent, skill.domain, contextUrl).some((candidate) =>
    candidate.endpoint.endpoint_id !== currentEndpointId &&
    isResolveUsableEndpointForIntent(candidate.endpoint, intent, contextUrl) &&
    endpointHasSearchBindings(candidate.endpoint) &&
    (!!candidate.endpoint.dom_extraction || !!candidate.endpoint.response_schema) &&
    endpointMatchesExplicitSearchContext(candidate.endpoint, contextUrl) &&
    candidate.score >= 0
  );
}

export function skillHasContextStructuredSearchEndpoint(
  skill: SkillManifest,
  intent: string,
  contextUrl?: string,
): boolean {
  if (!isSearchLikeIntent(intent, contextUrl)) return false;
  return skill.endpoints.some((endpoint) =>
    endpointHasSearchBindings(endpoint) &&
    (!!endpoint.dom_extraction || !!endpoint.response_schema) &&
    endpointMatchesContextOrigin(endpoint, contextUrl) &&
    endpointMatchesExplicitSearchContext(endpoint, contextUrl),
  );
}

function scoreRouteCacheCandidate(
  candidate: RouteCacheCandidate,
  intent: string,
  contextUrl?: string,
): number {
  const resolvedSkill = withContextReplayEndpoint(candidate.skill, intent, contextUrl);
  const ranked = dedupeObservedOverBundle(
    rankEndpoints(resolvedSkill.endpoints, intent, resolvedSkill.domain, contextUrl),
  );
  const top = ranked[0];
  let score = top?.score ?? Number.NEGATIVE_INFINITY;
  const cachedEndpoint = candidate.entry.endpointId
    ? resolvedSkill.endpoints.find((endpoint) => endpoint.endpoint_id === candidate.entry.endpointId)
    : undefined;

  if (!cachedEndpoint && candidate.entry.endpointId) return score - 25;
  if (!cachedEndpoint) return score;

  const cachedRank = ranked.findIndex(
    (rankedCandidate) => rankedCandidate.endpoint.endpoint_id === cachedEndpoint.endpoint_id,
  );
  if (cachedRank === 0) score += 25;
  else if (cachedRank > 0) score += Math.max(0, 10 - cachedRank);
  else score -= 20;

  if (endpointHasSearchBindings(cachedEndpoint)) score += 15;
  if (cachedEndpoint.dom_extraction || cachedEndpoint.response_schema) score += 8;

  const isCapturedPageArtifact = /captured page artifact/i.test(cachedEndpoint.description ?? "");
  if (isCapturedPageArtifact) score -= 10;
  if (
    isCapturedPageArtifact &&
    skillHasBetterStructuredSearchEndpoint(
      resolvedSkill,
      cachedEndpoint.endpoint_id,
      intent,
      contextUrl,
    )
  ) {
    score -= 80;
  }

  return score;
}

export function chooseBestRouteCacheCandidate(
  candidates: RouteCacheCandidate[],
  intent: string,
  contextUrl?: string,
): RouteCacheCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const scoreDelta = scoreRouteCacheCandidate(b, intent, contextUrl) - scoreRouteCacheCandidate(a, intent, contextUrl);
    if (scoreDelta !== 0) return scoreDelta;
    return b.entry.ts - a.entry.ts;
  })[0] ?? null;
}

function isRootContextUrl(contextUrl?: string): boolean {
  if (!contextUrl) return false;
  try {
    return new URL(contextUrl).pathname === "/";
  } catch {
    return false;
  }
}

async function withDomainCaptureLock<T>(domain: string, fn: () => Promise<T>): Promise<T> {
  const prev = captureDomainLocks.get(domain);
  if (prev) {
    try {
      await prev;
    } catch {
      /* previous capture failure shouldn't poison next */
    }
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  captureDomainLocks.set(domain, gate);
  try {
    return await fn();
  } finally {
    release();
    if (captureDomainLocks.get(domain) === gate) captureDomainLocks.delete(domain);
  }
}

export interface ResolveResultWithDiagnostic {
  available_operations?: Array<{ operation: string; url?: string; method?: string; requires_auth?: boolean; description?: string }>;
  diagnostic?: import("../types/skill.js").ResolveResultDiagnostic;
}

export interface OrchestratorResult {
  result: ResolveResultWithDiagnostic | unknown;
  trace: ExecutionTrace;
  source: "marketplace" | "live-capture" | "dom-fallback" | "first-pass" | "route-cache" | "browser-action" | "defer" | "exa" | "direct-fetch" | "direct-document";
  skill: SkillManifest;
  timing: OrchestrationTiming;
}

type AutoExecDecision = {
  orchestratorResult: OrchestratorResult;
  autoexecFailedAll: boolean;
};

export function shouldFallbackToLiveCaptureAfterAutoexecFailure(
  autoexecFailedAll: boolean,
  contextUrl?: string,
): boolean {
  return autoexecFailedAll && !!contextUrl;
}

/**
 * Generic "is this an obvious direct JSON API?" signal, derived purely from
 * evidence — never a per-domain registry (CLAUDE.md ranker philosophy bans
 * those). The strongest signal is a content-type the upstream itself
 * declared (`application/json`, `+json`, `text/json`) on a 2xx/3xx response.
 * Captured from the race's HEAD/GET-1byte probe (`probeUrl`). When true, the
 * caller's URL IS the data — a direct fetch of its body always beats Exa
 * web-search highlights ABOUT the topic (1 Thess 5:21 — hold fast the good).
 */
export function probeLooksLikeDirectJsonApi(probe: {
  status: number;
  content_type?: string;
}): boolean {
  if (!(probe.status >= 200 && probe.status < 400)) return false;
  const ct = (probe.content_type ?? "").toLowerCase();
  return ct.includes("application/json") || ct.includes("+json") || ct.includes("text/json");
}

/**
 * Companion to probeLooksLikeDirectJsonApi for HTML documents. When a probe
 * winner is a 2xx page served as HTML (not JSON — that's handled by the JSON
 * fast-path), the caller's own URL is the ground truth and a direct-document
 * fetch beats returning Exa "links about the topic". Thin SPA shells are caught
 * downstream by buildDirectDocumentResult's rejector and fall through to Exa /
 * the serial XHR ladder. Content-type signal only — no per-domain heuristic.
 */
export function probeLooksLikeFetchableHtmlDocument(probe: {
  status: number;
  content_type?: string;
}): boolean {
  if (!(probe.status >= 200 && probe.status < 400)) return false;
  if (probeLooksLikeDirectJsonApi(probe)) return false;
  const ct = (probe.content_type ?? "").toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml");
}

/**
 * Fetch the caller's URL directly and return parsed JSON when the response is
 * JSON-shaped (by content-type OR body-sniff). Returns null when the body is
 * not usable JSON, the fetch fails, or the response is not ok. Used by BOTH
 * the probe-winner fast path (restores the direct-fetch-over-exa contracts
 * c3f05a50 / 3b3e67d1 / a4bfd532 / 6bb821ff) and the post-race serial path so
 * obvious JSON APIs never fall through to the Exa shortcut on a budget race.
 *
 * `fetchImpl` is a test seam — production passes the global `fetch`.
 */
export async function tryDirectJsonFetch(
  url: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch; curlFallback?: typeof tryCurlImpersonateFetch },
): Promise<{ data: unknown; content_type: string } | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 15000;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json, text/html;q=0.5", "User-Agent": "unbrowse/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    const ctSaysJson = ct.includes("application/json") || ct.includes("+json") || ct.includes("text/json");
    if (ctSaysJson) {
      const data = await res.json();
      return { data, content_type: ct };
    }
    // Body-sniff: some APIs return valid JSON with text/html or text/plain.
    const bodyText = await res.text();
    if (bodyText.length < 2_000_000) {
      const trimmed = bodyText.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed !== null && typeof parsed === "object") {
            return { data: parsed, content_type: ct };
          }
        } catch {
          /* not JSON — caller falls through */
        }
      }
    }
    return null;
  } catch {
    // Native fetch stalled/failed. bun's fetch can hang on certain servers'
    // TLS/HTTP config where curl succeeds (observed: usgs.gov geojson — native
    // fetch times out, curl returns in ~1.2s). Rescue the probe-winner JSON
    // fast path with a direct curl-impersonate fetch and parse the JSON. Mirrors
    // replayRecipe's rescue; on any miss return null and the caller falls through.
    try {
      const curl = await (opts?.curlFallback ?? tryCurlImpersonateFetch)({ url, timeoutMs, forceDirect: true });
      if (curl && curl.status >= 200 && curl.status < 400 && curl.html) {
        const trimmed = curl.html.trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          const parsed = JSON.parse(curl.html);
          if (parsed !== null && typeof parsed === "object") {
            return { data: parsed, content_type: "application/json" };
          }
        }
      }
    } catch { /* curl unavailable / non-JSON — fall through to null */ }
    return null;
  }
}

export function shouldReuseRouteResultSnapshot(
  cached: {
    expires: number;
    skill: SkillManifest;
  },
  intent: string,
  contextUrl?: string,
  now = Date.now(),
): boolean {
  if (cached.expires <= now) return false;
  if (isRouteCacheEntryStale({ skillId: cached.skill.skill_id, domain: cached.skill.domain, ts: cached.expires - ROUTE_CACHE_TTL }, cached.skill)) return false;
  return isCachedSkillRelevantForIntent(cached.skill, intent, contextUrl);
}

/**
 * Returns true when a route cache entry is stale because its pinned endpoint
 * has been disabled, failed verification, or has a critically low reliability
 * score — indicating the endpoint is no longer reliably available.
 *
 * An entry with no pinned endpointId is never considered stale by this check
 * since the skill itself may still have usable endpoints.
 */
export function isRouteCacheEntryStale(
  entry: SkillRouteCacheEntry,
  skill: SkillManifest,
): boolean {
  if (!entry.endpointId) return false;
  const endpoint = skill.endpoints.find((ep) => ep.endpoint_id === entry.endpointId);
  if (!endpoint) return true; // endpoint removed from skill → stale
  if (endpoint.verification_status === "disabled" || endpoint.verification_status === "failed") return true;
  // Treat as stale when reliability has dropped below the auto-deprecation floor
  if (typeof endpoint.reliability_score === "number" && endpoint.reliability_score < 0.2) return true;
  return false;
}

export function pruneLocalCacheEntriesForSkill(skill: SkillManifest): LocalCacheCleanupSummary {
  const summary = pruneLocalCacheStateForSkill(skill, {
    capturedDomainCache,
    skillRouteCache,
    routeResultCache,
    domainSkillCache,
  });
  if (summary.route_cache_entries_removed > 0) persistRouteCache();
  if (summary.domain_cache_entries_removed > 0) persistDomainCache();
  return summary;
}

function computeCompositeScore(embeddingScore: number, skill: SkillManifest): number {
  // Average reliability across endpoints
  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability =
    reliabilities.length > 0
      ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
      : 0.5;

  // Freshness: 1 / (1 + daysSinceUpdate / 30)
  const daysSinceUpdate =
    (Date.now() - new Date(skill.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  const freshnessScore = 1 / (1 + daysSinceUpdate / 30);

  // Verification bonus: 1.0 if all verified, 0.5 if some, 0.0 if none
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verificationBonus =
    skill.endpoints.length > 0
      ? verifiedCount === skill.endpoints.length
        ? 1.0
        : verifiedCount > 0
          ? 0.5
          : 0.0
      : 0.0;

  return (
    0.4 * embeddingScore + 0.3 * avgReliability + 0.15 * freshnessScore + 0.15 * verificationBonus
  );
}

type RankedCandidate = { endpoint: SkillManifest["endpoints"][number]; score: number };

function prefersEndpoint(a: RankedCandidate, b: RankedCandidate): RankedCandidate {
  const aBundle = /inferred from js bundle/i.test(a.endpoint.description ?? "");
  const bBundle = /inferred from js bundle/i.test(b.endpoint.description ?? "");
  if (aBundle !== bBundle) return aBundle ? b : a;
  const aSchema = !!a.endpoint.response_schema;
  const bSchema = !!b.endpoint.response_schema;
  if (aSchema !== bSchema) return aSchema ? a : b;
  return a.score >= b.score ? a : b;
}

function dedupeObservedOverBundle(ranked: RankedCandidate[]): RankedCandidate[] {
  const byRoute = new Map<string, RankedCandidate>();
  for (const candidate of ranked) {
    let key = `${candidate.endpoint.method}:${candidate.endpoint.url_template}`;
    try {
      const url = new URL(candidate.endpoint.url_template);
      key = `${candidate.endpoint.method}:${url.origin}${url.pathname}`;
    } catch {
      /* keep raw key */
    }
    const existing = byRoute.get(key);
    byRoute.set(key, existing ? prefersEndpoint(existing, candidate) : candidate);
  }
  return Array.from(byRoute.values()).sort((a, b) => b.score - a.score);
}

function extractBinaryVerdict(payload: Record<string, unknown>): "pass" | "fail" | "skip" {
  for (const value of Object.values(payload)) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === "pass" || normalized.startsWith("pass ")) return "pass";
    if (normalized === "fail" || normalized.startsWith("fail ")) return "fail";
    if (normalized.includes('"pass"')) return "pass";
    if (normalized.includes('"fail"')) return "fail";
  }
  return "skip";
}

function obviousSemanticMismatch(
  intent: string,
  endpoint: SkillManifest["endpoints"][number],
  result: unknown,
): boolean {
  const haystack = `${intent} ${endpoint.url_template} ${endpoint.description ?? ""}`.toLowerCase();
  const wantsChannels =
    /\b(channel|channels|guild|guilds|message|messages|thread|threads|dm|chat)\b/.test(
      intent.toLowerCase(),
    );
  const resultKeys =
    result && typeof result === "object"
      ? Object.keys(result as Record<string, unknown>)
          .join(" ")
          .toLowerCase()
      : "";
  if (wantsChannels) {
    if (
      /\b(experiment|experiments|promotion|promotions|affinit|fingerprint|assignment|config|status)\b/.test(
        haystack,
      )
    )
      return true;
    if (/\b(guild_experiments|guild_affinities|fingerprint|assignments)\b/.test(resultKeys))
      return true;
  }
  const wantsPosts = /\b(post|posts|tweet|tweets|status|statuses|timeline|feed)\b/.test(
    intent.toLowerCase(),
  );
  if (wantsPosts && result && typeof result === "object") {
    const keys = JSON.stringify(result).toLowerCase();
    if (/\b(accounts|users|profiles)\b/.test(keys) && !/\b(statuses|posts|tweets)\b/.test(keys))
      return true;
  }
  return false;
}

function inferDefaultParam(
  paramName: string,
  intent: string,
): string | number | boolean | undefined {
  const name = paramName.toLowerCase();
  const intentLower = intent.toLowerCase();
  if (name === "limit" || name === "count" || name === "per_page" || name === "page_size")
    return 20;
  if (name === "page") return 1;
  if (name === "offset") return 0;
  if (name === "resolve") {
    if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(intentLower)) return false;
    return true;
  }
  if (name === "type") {
    if (/\b(post|posts|status|statuses|tweet|tweets)\b/.test(intentLower)) return "statuses";
    if (/\b(repo|repository|repositories)\b/.test(intentLower)) return "repositories";
    if (/\b(person|people|profile|profiles|member|members)\b/.test(intentLower)) return "accounts";
  }
  return undefined;
}

/**
 * Use the LLM judge to infer template parameter values from a natural-language intent.
 * Given an endpoint's url_template and the user's intent, the LLM figures out what values
 * to fill in for each unbound {param}. This generalizes across ANY website — no hardcoded
 * param name lists or regex patterns needed.
 *
 * Returns a map of param_name → inferred_value for params the LLM could resolve.
 * Params it can't resolve are omitted.
 */
const SEARCH_INTENT_STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "boss", "but", "by", "do", "doing", "fact", "for", "from", "get",
  "going", "had", "has", "have", "i", "if", "im", "in", "into", "is", "it", "its", "just",
  "let", "like", "me", "my", "now", "of", "on", "or", "our", "s", "says", "search", "should",
  "show", "so", "take", "taking", "tell", "that", "the", "their", "them", "there", "these",
  "they", "this", "thoroughly", "to", "up", "us", "was", "we", "were", "what", "where", "which", "who",
  "why", "with", "would", "you", "your",
]);

const SEARCH_DIRECTIVE_PREFIX =
  /^(search\s+for|search|find\s+me|find|look\s+for|looking\s+for|show\s+me|show|get\s+me|get|browse|discover|shop\s+for|buy)\s+/i;
const SEARCH_TRAILING_SITE_HINT = /\s+(on|at|from|in|via)\s+\S+$/i;
const SEARCH_INSTRUCTION_NOISE =
  /\b(do not|don't|dont|tell me|let me know|extremely thoroughly|thoroughly|random cases|for the sake of it|if there is no such|if none exists|if no such)\b/i;
const SEARCH_PRIORITY_PATTERN =
  /\b(high|court|appeal|leave|adduce|evidence|assessment|damages?|tranche|tranches|started|late|stage|hearing|trial|mediation|case|cases|allow|allowed)\b/;

function isLikelySearchParam(
  urlTemplate: string,
  param: string,
): boolean {
  const lowerParam = param.toLowerCase();
  if (/(^q$|^k$|basicsearchkey|basic_search_key|query|keyword|keywords|search|lookup|find|term|phrase|querystr|query_string)/.test(lowerParam)) {
    return true;
  }
  try {
    const parsed = new URL(urlTemplate.replace(/\{[^}]+\}/g, "x"));
    for (const [key, value] of parsed.searchParams.entries()) {
      if (key === param || value === "x") {
        if (/(^q$|^k$|query|keyword|keywords|search|lookup|find|term|phrase|querystr|query_string)/.test(key.toLowerCase())) {
          return true;
        }
      }
    }
  } catch {
    /* ignore malformed templates */
  }
  return false;
}

function collectSearchBindingKeys(
  endpoint: SkillManifest["endpoints"][number],
): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(endpoint.body_params ?? {})) {
    if (isLikelySearchParam(endpoint.url_template, key)) keys.add(key);
  }
  for (const key of Object.keys(endpoint.query ?? {})) {
    if (isLikelySearchParam(endpoint.url_template, key)) keys.add(key);
  }
  for (const [rawKey, bindingKey] of Object.entries(extractTemplateQueryBindings(endpoint.url_template))) {
    if (isLikelySearchParam(endpoint.url_template, rawKey)
      || isLikelySearchParam(endpoint.url_template, bindingKey)) {
      keys.add(bindingKey);
    }
  }
  for (const match of endpoint.url_template.matchAll(/\{([^}]+)\}/g)) {
    const key = match[1];
    if (isLikelySearchParam(endpoint.url_template, key)) keys.add(key);
  }
  return [...keys];
}

function stripSearchIntentBoilerplate(intent: string): string {
  return intent
    .trim()
    .replace(SEARCH_DIRECTIVE_PREFIX, "")
    .replace(SEARCH_TRAILING_SITE_HINT, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractLiteralSearchTermsFromIntent(intent: string): string | null {
  const stripped = stripSearchIntentBoilerplate(intent);
  if (!stripped) return null;
  const clauses = stripped
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length <= 1) return stripped;

  const scored = clauses.map((clause, index) => {
    const tokens = clause
      .toLowerCase()
      .replace(/[^a-z0-9\-/]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !SEARCH_INTENT_STOPWORDS.has(token));
    let score = Math.min(tokens.length, 12);
    if (/["“”']/.test(clause)) score += 4;
    if (/[()]/.test(clause)) score += 2;
    if (/\d/.test(clause)) score += 2;
    if (SEARCH_INSTRUCTION_NOISE.test(clause)) score -= 8;
    return { clause, index, score };
  });

  const selected = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.clause.replace(/\s+/g, " ").trim());

  const joined = (selected.length > 0 ? selected.join(" ") : stripped).trim();
  return joined || null;
}

export function inferSearchParamOverrides(
  endpoint: SkillManifest["endpoints"][number],
  intent: string,
  explicitParams: Record<string, unknown> = {},
): Record<string, string> {
  if (!/\b(search|find|lookup|browse|discover)\b/i.test(intent)) return {};
  const keys = collectSearchBindingKeys(endpoint);
  if (keys.length === 0) return {};
  const selectedTerms = selectSearchTermsForExecution(intent);
  if (!selectedTerms) return {};
  const overrides: Record<string, string> = {};
  for (const key of keys) {
    if (explicitParams[key] != null && explicitParams[key] !== "") continue;
    overrides[key] = selectedTerms;
  }
  return overrides;
}

export function selectSearchTermsForExecution(intent: string): string | null {
  const literal = extractLiteralSearchTermsFromIntent(intent);
  const condensed = extractSearchTermsFromIntent(intent);
  if (!literal) return condensed;
  if (!condensed || condensed === literal) return literal;
  const wordCount = literal.split(/\s+/).filter(Boolean).length;
  const hasQuotedPhrase = /["“”]/.test(literal);
  const hasSentencePunctuation = /[.!?]/.test(literal);
  const tooLongForSingleField = literal.length > 180 || wordCount > 24;
  if (hasQuotedPhrase && !tooLongForSingleField) return literal;
  if (!hasSentencePunctuation && !tooLongForSingleField) return literal;
  if (tooLongForSingleField) {
    const compactPhraseQuery = buildCompactPhraseSearchQuery(intent);
    if (compactPhraseQuery) return compactPhraseQuery;
  }
  return condensed;
}

function buildCompactPhraseSearchQuery(intent: string): string | null {
  const stripped = stripSearchIntentBoilerplate(intent);
  if (!stripped) return null;
  const sourceText = extractLiteralSearchTermsFromIntent(intent) ?? stripped;
  const clauses = sourceText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const phraseScores = new Map<string, { score: number; clauseIndex: number }>();
  const remember = (rawPhrase: string, score: number, clauseIndex: number) => {
    const phrase = rawPhrase
      .toLowerCase()
      .replace(/[^a-z0-9\s/-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!phrase) return;
    const words = phrase.split(/\s+/).filter(Boolean);
    const contentWords = words.filter((word) => !SEARCH_INTENT_STOPWORDS.has(word));
    if (contentWords.length < 2) return;
    if (!contentWords.some((word) => SEARCH_PRIORITY_PATTERN.test(word))) return;
    if (words.length > 8) return;
    if (SEARCH_INSTRUCTION_NOISE.test(phrase)) return;
    const priorityHits = contentWords.filter((word) => SEARCH_PRIORITY_PATTERN.test(word)).length;
    const proceduralHits = contentWords.filter((word) => /^(started|tranche|tranches|allow|allowed)$/.test(word)).length;
    const startsBadly = /^(eg|\d)$/.test(words[0] ?? "") || /^\d+$/.test(words[0] ?? "");
    const endsBadly = /^(eg|\d)$/.test(words[words.length - 1] ?? "") || /^\d+$/.test(words[words.length - 1] ?? "");
    const connectorHits = words.filter((word) => ["of", "to", "for", "at", "after"].includes(word)).length;
    if (/\b(such|none|random)\b/.test(phrase)) return;
    const boostedScore =
      score
      + Math.min(contentWords.length, 4)
      + priorityHits * 3
      + proceduralHits * 4
      + connectorHits
      + (words.length >= 3 && words.length <= 5 ? 2 : 0)
      + (/\d/.test(phrase) ? 2 : 0)
      - (startsBadly ? 4 : 0)
      - (endsBadly ? 4 : 0)
      - (/\beg\b/.test(phrase) ? 6 : 0);
    const existing = phraseScores.get(phrase);
    if (!existing || boostedScore > existing.score) phraseScores.set(phrase, { score: boostedScore, clauseIndex });
  };

  for (const [clauseIndex, clause] of clauses.entries()) {
    for (const match of clause.matchAll(/["“”']([^"“”']{3,80})["“”']/g)) {
      remember(match[1], 12, clauseIndex);
    }
  }

  for (const [clauseIndex, clause] of clauses.entries()) {
    for (const match of clause.matchAll(/\b[a-z0-9-]+(?:\s+(?:of|to|for|at|after)\s+[a-z0-9-]+){1,4}\b/gi)) {
      remember(match[0], 14, clauseIndex);
    }
    const tokens = clause
      .toLowerCase()
      .replace(/[^a-z0-9\s/-]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    for (let start = 0; start < tokens.length; start++) {
      for (let size = 2; size <= 6 && start + size <= tokens.length; size++) {
        const slice = tokens.slice(start, start + size);
        if (SEARCH_INTENT_STOPWORDS.has(slice[0]) || SEARCH_INTENT_STOPWORDS.has(slice[slice.length - 1])) continue;
        remember(slice.join(" "), 6 - Math.abs(size - 4), clauseIndex);
      }
    }
  }

  const selected: string[] = [];
  const selectedRaw: string[] = [];
  let currentLength = 0;
  const clauseCounts = new Map<number, number>();
  for (const [phrase, meta] of Array.from(phraseScores.entries())
    .sort((a, b) => b[1].score - a[1].score || a[0].length - b[0].length)) {
    if (selectedRaw.some((chosen) => chosen.includes(phrase) || phrase.includes(chosen))) continue;
    if ((clauseCounts.get(meta.clauseIndex) ?? 0) >= 2) continue;
    const rendered = `"${phrase}"`;
    const nextLength = currentLength === 0 ? rendered.length : currentLength + 1 + rendered.length;
    if (nextLength > 140) continue;
    selected.push(rendered);
    selectedRaw.push(phrase);
    clauseCounts.set(meta.clauseIndex, (clauseCounts.get(meta.clauseIndex) ?? 0) + 1);
    currentLength = nextLength;
    if (selected.length >= 4) break;
  }

  return selected.length > 0 ? selected.join(" ") : null;
}

function condenseSearchIntent(intent: string): string | null {
  const wantsSearchAction = /\b(search|find|lookup|look\s+for|browse|discover)\b/i.test(intent);
  const tokens = intent
    .toLowerCase()
    .replace(/[^a-z0-9\][\-/]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !SEARCH_INTENT_STOPWORDS.has(token));
  const scored = new Map<string, { token: string; index: number; score: number }>();
  tokens.forEach((token, index) => {
    let score = 0;
    if (SEARCH_PRIORITY_PATTERN.test(token)) score += 10;
    if (token.length >= 8) score += 2;
    if (index < 12) score += 1;
    const existing = scored.get(token);
    if (!existing || score > existing.score) {
      scored.set(token, { token, index, score });
    }
  });
  const budget = wantsSearchAction ? 13 : 14;
  const selected = Array.from(scored.values())
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, budget)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.token);
  if (selected.length === 0) return null;
  if (wantsSearchAction && selected[0] !== "search") {
    selected.unshift("search");
  }
  return selected.join(" ");
}

/** Strip meta-phrases from intent to get raw search terms. Returns null if intent is too complex. */
export function extractSearchTermsFromIntent(intent: string): string | null {
  let terms = stripSearchIntentBoilerplate(intent).toLowerCase();
  if (!terms) return null;
  const words = terms.split(/\s+/).filter(Boolean);
  if (terms.length > 160 || words.length > 20 || /[.!?]/.test(terms)) {
    return condenseSearchIntent(terms);
  }
  // If there are multiple clauses (dates, locations, filters), fall back to LLM
  if (/\b(from|to|between|before|after|near|in\s+\w+,?\s+\w+|under\s+\$|over\s+\$|cheaper\s+than|more\s+than)\b/i.test(terms)) {
    return null;
  }
  return terms || null;
}

export interface ChainStepInfo { endpoint_id: string; ok: boolean; yielded: string[] }
export interface CompositeEdge { from: string; binding: string; to: string }

/**
 * Derive the binding edges of a composite contract: each resolved binding key maps back to the
 * prerequisite step that yielded it → an edge (prerequisite → binding → target). This turns a
 * walked chain into the inspectable sub-DAG a future lever persists + replays as one unit.
 */
export function buildCompositeEdges(
  target: string,
  steps: ChainStepInfo[],
  boundKeys: string[],
): CompositeEdge[] {
  return boundKeys
    .map((binding) => {
      const from = steps.find((s) => s.yielded.includes(binding));
      return from ? { from: from.endpoint_id, binding, to: target } : null;
    })
    .filter((e): e is CompositeEdge => e !== null);
}

export interface ReplayDecision {
  prereqOrder: string[];
  replayedCompositeId?: string;
}

/**
 * Lever 4 (replay) — decide the prerequisite order for a resolve. If a composite was persisted for
 * this (domain, target) and every recorded step is still replayable (exists + auto-executable, never
 * an irreversible op), run the recorded order first (the known-good DAG), appending any extra live
 * advisory prereqs the composite didn't record. Otherwise fall back to the live order unchanged — a
 * stale/missing/now-irreversible constituent cleanly degrades to full recompute. Pure + testable.
 */
/** The minimal composite shape replay needs: its identity and its ordered steps. Both the
 *  local-disk PersistedComposite and a skill-manifest SkillComposite satisfy it. */
type ReplayableComposite = { composite_id: string; steps: { endpoint_id: string }[] };

export function planPrereqOrder(
  livePrereqOrder: string[],
  persisted: ReplayableComposite | undefined,
  isReplayable: (endpointId: string) => boolean,
): ReplayDecision {
  if (persisted && persisted.steps.length > 0) {
    const recordedOrder = persisted.steps.map((s) => s.endpoint_id);
    if (recordedOrder.every((id) => isReplayable(id))) {
      return {
        prereqOrder: [
          ...recordedOrder,
          ...livePrereqOrder.filter((p) => !recordedOrder.includes(p)),
        ],
        replayedCompositeId: persisted.composite_id,
      };
    }
  }
  return { prereqOrder: livePrereqOrder };
}

/**
 * Walk the prerequisite chain — the runtime DAG-recompute (north star). When the target
 * endpoint has params left unbound, instead of LLM-guessing them, find a prerequisite endpoint
 * that YIELDS that binding key (per the operation DAG's provides/requires), execute it FIRST,
 * and extract the real value from its result. Dependent steps then run in true dependency order
 * with real threaded values, not guesses.
 *
 * Bounded + safe: one prerequisite execution per yielded key (cached by endpoint_id), only for
 * keys a prerequisite actually provides, one level deep. A prerequisite failure is skipped (the
 * caller falls back to LLM inference), so this never regresses the existing path.
 */
/** TTL (ms) for persisting prerequisite-step results in the resolution ledger. ON by default — the
 *  two cold-audit safety findings that justified the old opt-in escape hatch are now CLOSED, not
 *  gated away:
 *   (A) one-time/stale-token replay → isPersistableYield rejects any one-time/auth-bearing yield key
 *       (token/nonce/CSRF/session/...) AND any auth-backed endpoint.
 *   (B) cross-principal via cookies → the per-prereq principal now folds the domain's stored cookies
 *       (credentialFromAuthContext), so a cookie-authed yield partitions per (headers+cookies).
 *  So persistence is safe on by default. UNBROWSE_STATELESS=1 still forces 0 (the stateless binary
 *  writes no local state); UNBROWSE_RESOLVE_CACHE_TTL_MS=0 also disables it explicitly. */
function prereqCacheTtlMs(): number {
  if (process.env.UNBROWSE_STATELESS === "1") return 0;
  return Math.max(0, Number(process.env.UNBROWSE_RESOLVE_CACHE_TTL_MS ?? 600_000) || 0);
}
export async function walkPrerequisiteChain(
  skill: SkillManifest,
  unboundParams: string[],
  prerequisiteOrder: string[],
  baseParams: Record<string, unknown>,
  queryIntent: string,
  projection: Parameters<typeof executeSkill>[2],
  options: Parameters<typeof executeSkill>[3],
  steps: Array<{ endpoint_id: string; ok: boolean; yielded: string[] }>,
  // The TARGET endpoint whose holes are being filled. When set, the skill's operation_graph edges
  // bind each hole to the RIGHT producer (Ex 28:32 — which hole fits which); omitted → order fallback.
  consumerId?: string,
  // Test seam (dependency injection): the per-prerequisite execution fn. Defaults to the real
  // executeSkill (zero prod change); a witness injects a controlled/counting fn to exercise the
  // walk's persist+replay deterministically without network.
  execFn: typeof executeSkill = executeSkill,
): Promise<Record<string, string | number | boolean>> {
  const resolved: Record<string, string | number | boolean> = {};
  const executed = new Map<string, Record<string, unknown>>(); // endpoint_id → extracted yields
  const epProvides = (ep: (typeof skill.endpoints)[number] | undefined): OperationBinding[] =>
    (ep?.semantic?.provides ?? []) as OperationBinding[];
  // Explicit DAG edges disambiguate which producer fills each hole when several yield the same key.
  const bindingGraph = bindingGraphFromOperationGraph(skill.operation_graph);

  // Persistent values-ledger cascade (the firmament): each prerequisite's yields are content-addressed
  // in the resolution ledger — not just the per-call `executed` Map — partitioned by the VERIFIED auth
  // principal (no cross-tenant replay) and folded pointer→pointer so an earlier step's VALUE change
  // cascade-invalidates the later steps that ran in its context (keyWithDeps). Gated by ttl: 0 under
  // UNBROWSE_STATELESS → cachedResolution is pass-through (behaviour unchanged). Fail-open: any ledger
  // error → live recompute; only `cacheable` (ok + non-empty yields) results are ever stored, so an
  // error / empty / auth-required prerequisite is never written to a shared key.
  const prereqTtlMs = prereqCacheTtlMs();
  const authHeaders = baseParams.auth_headers as Record<string, string> | undefined;
  let priorPointer: string | undefined; // the prior executed step's result pointer — the cascade edge

  for (const param of unboundParams) {
    if (resolved[param] != null) continue;
    // 1) explicit edge (operation_graph) → the RIGHT producer; must be in the executable order.
    let prereqId: string | null =
      consumerId ? selectHoleProducer(param, consumerId, bindingGraph, prerequisiteOrder) : null;
    if (prereqId && !prerequisiteOrder.includes(prereqId)) prereqId = null;
    // 2) fallback: the first prerequisite (in dependency order) that yields this binding key.
    if (!prereqId) {
      prereqId = prerequisiteOrder.find((id) => {
        const ep = skill.endpoints.find((e) => e.endpoint_id === id);
        return ep && epProvides(ep).some((b) => b.key === param);
      }) ?? null;
    }
    if (!prereqId) continue;
    const prereqEp = skill.endpoints.find((e) => e.endpoint_id === prereqId);
    if (!prereqEp) continue;

    let extracted = executed.get(prereqId);
    if (!extracted) {
      // Bind this step to the prior step's pointer (pointer→pointer): if an earlier prerequisite's
      // value changes, its pointer changes → this step re-keys → recompute (never serve a stale yield
      // produced in a now-changed context). Omitted for the first step (leaf).
      const dependsOn = priorPointer ? [priorPointer] : undefined;
      // Per-prereq principal: fold the prereq DOMAIN's stored cookies into the auth credential, not
      // headers alone (cold-audit finding B — cookies are the common auth vector the header-only
      // principal missed). A cookie-authed yield now partitions per (headers+cookies) → a different
      // user (different cookies) gets a different cache partition; never a cross-principal read. Only
      // read the vault when caching is actually on (ttl>0), so the default path pays nothing.
      let prereqPrincipal: string | undefined;
      if (prereqTtlMs > 0) {
        let prereqDomain = skill.domain;
        try { prereqDomain = new URL(prereqEp.url_template).hostname; } catch { /* keep skill.domain */ }
        const prereqCookies = await getStoredAuth(prereqDomain).catch(() => null);
        prereqPrincipal = credentialFromAuthContext(authHeaders, prereqCookies);
      }
      try {
        const res = await cachedResolution<{ ok: boolean; yields: Record<string, unknown> }>({
          key: `prereq ${skill.skill_id}|${prereqId}|${queryIntent}`,
          ttlMs: prereqTtlMs,
          principal: prereqPrincipal,
          dependsOn,
          // Persist only a SAFE prereq yield (cold-audit findings A+B): successful, non-empty, from a
          // NON-auth-backed endpoint (no cookie-authed user data under the cookie-blind anon principal),
          // and with NO one-time/auth-bearing yield key (no token/nonce/CSRF replay). Any doubt → miss.
          cacheable: (r) => isPersistableYield(r.ok, r.yields, prereqEp, skill),
          recompute: async () => {
            const out = await execFn(
              skill,
              { ...baseParams, endpoint_id: prereqId, intent: queryIntent },
              projection,
              { ...options, intent: queryIntent },
            );
            const ok = !!out?.trace?.success;
            const yields = extractBindingsFromJson(
              ok ? JSON.stringify(out.result) : undefined,
              epProvides(prereqEp),
            );
            return { ok, yields };
          },
        });
        steps.push({ endpoint_id: prereqId, ok: res.value.ok, yielded: Object.keys(res.value.yields) });
        if (!res.value.ok) continue;
        // Advance the cascade edge to this step's pointer (when persisted; pass-through under ttl<=0).
        if (res.pointer) priorPointer = res.pointer;
        extracted = res.value.yields;
        executed.set(prereqId, extracted);
      } catch {
        steps.push({ endpoint_id: prereqId, ok: false, yielded: [] });
        continue;
      }
    }

    const raw = extracted?.[param];
    // Scalars thread directly; an array/object yield (e.g. a list of ids) threads its first scalar.
    const scalar = Array.isArray(raw) ? raw[0] : raw;
    if (scalar != null && (typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean")) {
      resolved[param] = scalar;
    }
  }
  return resolved;
}

async function inferParamsFromIntent(
  urlTemplate: string,
  intent: string,
  unboundParams: string[],
  endpointDescription?: string,
): Promise<Record<string, string>> {
  if (unboundParams.length === 0) return {};

  // Fast path: single search-like param — extract search terms directly
  if (unboundParams.length === 1) {
    const param = unboundParams[0];
    if (isLikelySearchParam(urlTemplate, param, endpointDescription)) {
      const searchTerms = selectSearchTermsForExecution(intent);
      if (searchTerms) {
        return { [param]: searchTerms };
      }
    }
  }

  // Skip LLM call — unbound params will cause execution deferral, which shows
  // the agent the endpoint's input_params with examples. The agent fills them via --params.
  return {};
}


async function withOpTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return await Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout:${ms}`)), ms),
    ),
  ]);
}

async function withAbortableOpTimeout<T>(
  label: string,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label}_timeout:${ms}`)), ms);
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason ?? new Error(`${label}_timeout:${ms}`)),
          { once: true },
        ),
      ),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function inferPreferredEntityTokens(intent: string): string[] {
  const lower = intent.toLowerCase();
  if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(lower))
    return ["statuses", "posts", "tweets", "timeline"];
  if (/\b(person|people|profile|profiles|member|members|user|users)\b/.test(lower)) {
    return [
      "accounts",
      "user",
      "users",
      "profile",
      "profiles",
      "person",
      "people",
      "member",
      "members",
      "screen_name",
      "userbyscreenname",
    ];
  }
  if (/\b(company|companies|organization|organisations|business|org)\b/.test(lower))
    return ["company", "companies", "organization", "business", "org"];
  if (/\b(repo|repos|repository|repositories)\b/.test(lower))
    return ["repositories", "repository", "repo"];
  if (/\b(topic|topics|trend|trends|hashtag|hashtags)\b/.test(lower))
    return ["trends", "trend", "topic", "topics", "hashtag"];
  return [];
}

function isAcceptableIntentResult(result: unknown, intent: string): boolean {
  return assessIntentResult(result, intent).verdict !== "fail";
}

function candidateMatchesPreferredEntity(
  candidate: RankedCandidate,
  preferredTokens: string[],
): boolean {
  if (preferredTokens.length === 0) return false;
  if (candidate.endpoint.dom_extraction || candidate.endpoint.method === "WS") return false;
  if (/inferred from js bundle/i.test(candidate.endpoint.description ?? "")) return false;
  const haystack = [
    candidate.endpoint.url_template,
    candidate.endpoint.description ?? "",
    JSON.stringify(candidate.endpoint.response_schema ?? {}),
  ]
    .join(" ")
    .toLowerCase();
  return preferredTokens.some((token) => haystack.includes(token.toLowerCase()));
}

function isDocumentLikeCandidate(candidate: RankedCandidate, contextUrl?: string): boolean {
  if (/captured page artifact/i.test(candidate.endpoint.description ?? "")) return true;
  if (candidate.endpoint.dom_extraction || candidate.endpoint.method === "WS") return false;
  try {
    const endpointUrl = new URL(candidate.endpoint.url_template);
    if (/\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(endpointUrl.pathname)) return false;
    if (!contextUrl) return false;
    const contextPage = new URL(contextUrl);
    return (
      endpointUrl.origin === contextPage.origin && endpointUrl.pathname === contextPage.pathname
    );
  } catch {
    return /captured page artifact/i.test(candidate.endpoint.description ?? "");
  }
}

function isConcreteEntityDetailIntent(intent: string, contextUrl?: string): boolean {
  if (!/\b(get|fetch|view)\b/i.test(intent)) return false;
  if (
    !/\b(company|companies|organization|organisations|business|org|person|people|profile|profiles|member|members|user|users|product|products|item|items|listing|listings)\b/i.test(
      intent,
    )
  )
    return false;
  if (!contextUrl) return false;
  try {
    const leaf = decodeURIComponent(
      new URL(contextUrl).pathname.split("/").filter(Boolean).pop() ?? "",
    ).toLowerCase();
    return (
      !!leaf &&
      !/^(search|explore|trending|tabs|home|for-you|foryou|latest|live|people|posts|videos)$/.test(
        leaf,
      )
    );
  } catch {
    return false;
  }
}

export function marketplaceSkillMatchesContext(
  skill: SkillManifest,
  intent: string,
  contextUrl?: string,
): boolean {
  if (contextUrl && !skill.endpoints.some((endpoint) => endpointMatchesContextOrigin(endpoint, contextUrl))) {
    return false;
  }
  if (isFeedTimelineIntent(intent, contextUrl)) {
    return skill.endpoints.some((endpoint) => endpointMatchesFeedTimelineContext(endpoint, contextUrl));
  }
  if (!contextUrl || !isConcreteEntityDetailIntent(intent, contextUrl)) return true;
  let contextPath = "";
  try {
    contextPath = new URL(contextUrl).pathname;
  } catch {
    return true;
  }
  if (!contextPath) return true;

  let hasApiLikeEndpoint = false;
  for (const endpoint of skill.endpoints ?? []) {
    let path = "";
    let triggerPath = "";
    try { path = new URL(endpoint.url_template).pathname; } catch { /* ignore */ }
    try { triggerPath = endpoint.trigger_url ? new URL(endpoint.trigger_url).pathname : ""; } catch { /* ignore */ }
    if (path === contextPath || triggerPath === contextPath) return true;

    const apiLike =
      /\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(endpoint.url_template) ||
      (!endpoint.dom_extraction && !!endpoint.response_schema && !/captured page artifact/i.test(endpoint.description ?? ""));
    if (apiLike) hasApiLikeEndpoint = true;
  }

  return hasApiLikeEndpoint;
}

function prioritizeIntentMatchedApis(
  ranked: RankedCandidate[],
  intent: string,
  contextUrl?: string,
): RankedCandidate[] {
  const preferred = inferPreferredEntityTokens(intent);
  if (preferred.length === 0) return ranked;
  const preferredApis = ranked.filter((candidate) =>
    candidateMatchesPreferredEntity(candidate, preferred),
  );
  if (preferredApis.length === 0) return ranked;
  const preferredIds = new Set(preferredApis.map((candidate) => candidate.endpoint.endpoint_id));
  return [
    ...preferredApis.sort((a, b) => {
      const aDoc = isDocumentLikeCandidate(a, contextUrl);
      const bDoc = isDocumentLikeCandidate(b, contextUrl);
      if (aDoc !== bDoc) return aDoc ? 1 : -1;
      return b.score - a.score;
    }),
    ...ranked.filter((candidate) => !preferredIds.has(candidate.endpoint.endpoint_id)),
  ];
}

async function agentSelectEndpoint(
  _intent: string,
  _skill: SkillManifest,
  _ranked: RankedCandidate[],
  _contextUrl?: string,
): Promise<string[] | null> {
  // Deterministic scoring from rankEndpoints + readiness bonuses is already applied upstream.
  // LLM reranking added ~8s latency for marginal benefit — removed.
  return null;
}

function agentJudgeExecution(
  intent: string,
  endpoint: SkillManifest["endpoints"][number],
  result: unknown,
): "pass" | "fail" | "skip" {
  // Fast deterministic heuristic — the host agent judges the data when it sees it.
  if (obviousSemanticMismatch(intent, endpoint, result)) return "fail";
  if (result == null) return "fail";
  if (Array.isArray(result)) return result.length > 0 ? "pass" : "fail";
  if (typeof result === "object") return Object.keys(result as Record<string, unknown>).length > 0 ? "pass" : "fail";
  if (typeof result === "string") return result.length > 0 ? "pass" : "fail";
  return "skip";
}

function normalizeParityRows(data: unknown, intent: string): Array<Record<string, unknown>> {
  const projected = projectIntentData(data, intent);
  if (Array.isArray(projected)) {
    return projected.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }
  if (projected && typeof projected === "object") return [projected as Record<string, unknown>];
  return [];
}

function compactParityValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim().toLowerCase().slice(0, 160);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => compactParityValue(item)).filter(Boolean).join("|");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).slice(0, 3).map((item) => compactParityValue(item)).filter(Boolean).join("|");
  }
  return "";
}

function parityFingerprint(row: Record<string, unknown>): string {
  const preferredKeys = [
    "id",
    "entityUrn",
    "urn",
    "url",
    "link",
    "slug",
    "name",
    "title",
    "headline",
    "author",
    "user",
    "content",
    "text",
    "body",
  ];
  const parts = preferredKeys
    .map((key) => compactParityValue(row[key]))
    .filter(Boolean)
    .slice(0, 4);
  if (parts.length > 0) return parts.join("::");
  return compactParityValue(row);
}

function localParityVerdict(
  intent: string,
  browserBaseline: unknown,
  replayResult: unknown,
): { verdict: "pass" | "fail" | "skip"; reason: string } {
  const browserAssessment = assessIntentResult(browserBaseline, intent);
  const replayAssessment = assessIntentResult(replayResult, intent);
  if (replayAssessment.verdict === "fail") return { verdict: "fail", reason: `replay_${replayAssessment.reason}` };
  if (browserAssessment.verdict === "fail") return { verdict: "skip", reason: `browser_${browserAssessment.reason}` };

  const browserRows = normalizeParityRows(browserBaseline, intent);
  const replayRows = normalizeParityRows(replayResult, intent);
  if (browserRows.length === 0 || replayRows.length === 0) return { verdict: "skip", reason: "insufficient_rows" };

  const browserPrints = new Set(browserRows.map(parityFingerprint).filter(Boolean));
  const replayPrints = new Set(replayRows.map(parityFingerprint).filter(Boolean));
  if (browserPrints.size === 0 || replayPrints.size === 0) return { verdict: "skip", reason: "insufficient_fingerprints" };

  let overlap = 0;
  for (const fingerprint of browserPrints) {
    if (replayPrints.has(fingerprint)) overlap += 1;
  }
  const overlapRatio = overlap / Math.max(1, Math.min(browserPrints.size, replayPrints.size));
  if (overlapRatio >= 0.4) return { verdict: "pass", reason: `fingerprint_overlap_${overlap}/${Math.min(browserPrints.size, replayPrints.size)}` };
  if (overlap === 0 && browserPrints.size >= 2 && replayPrints.size >= 1) {
    return { verdict: "fail", reason: "zero_overlap" };
  }
  return { verdict: "skip", reason: `low_overlap_${overlapRatio.toFixed(2)}` };
}

function agentJudgeParity(
  intent: string,
  browserBaseline: unknown,
  replayResult: unknown,
): "pass" | "fail" | "skip" {
  // Use local fingerprint-based parity only — LLM call removed.
  const local = localParityVerdict(intent, browserBaseline, replayResult);
  return local.verdict;
}

export function resolveEndpointTemplateBindings(
  endpoint: SkillManifest["endpoints"][number],
  params: Record<string, unknown> = {},
  contextUrl?: string,
): Record<string, unknown> {
  const merged = mergeContextTemplateParams(params, endpoint.url_template, contextUrl);
  for (const [key, value] of Object.entries(endpoint.path_params ?? {})) {
    if (merged[key] == null || merged[key] === "") merged[key] = value;
  }
  for (const [key, value] of Object.entries(endpoint.query ?? {})) {
    if (merged[key] == null || merged[key] === "") merged[key] = value;
  }
  const semanticExample = endpoint.semantic?.example_request;
  if (semanticExample && typeof semanticExample === "object") {
    for (const [key, value] of Object.entries(semanticExample)) {
      if (merged[key] == null || merged[key] === "") merged[key] = value;
    }
  }
  return merged;
}

export async function resolveAndExecute(
  intent: string,
  params: Record<string, unknown> = {},
  context?: { url?: string; domain?: string },
  projection?: ProjectionOptions,
  options?: ExecutionOptions,
): Promise<OrchestratorResult> {
  const t0 = Date.now();
  const timing: OrchestrationTiming = {
    search_ms: 0,
    get_skill_ms: 0,
    execute_ms: 0,
    total_ms: 0,
    source: "marketplace",
    cache_hit: false,
    candidates_found: 0,
    candidates_tried: 0,
    tokens_saved: 0,
    response_bytes: 0,
    time_saved_pct: 0,
    tokens_saved_pct: 0,
    actual_total_ms: 0,
    trace_version: TRACE_VERSION,
  };
  const decisionTrace: Record<string, unknown> = {
    intent,
    params,
    context,
    search_candidates: [] as unknown[],
    autoexec_attempts: [] as unknown[],
  };
  const queryIntent = selectSearchTermsForExecution(intent) ?? extractSearchTermsFromIntent(intent) ?? intent;
  if (queryIntent !== intent) decisionTrace.query_intent = queryIntent;
  // Domain-anchored variant for the backend search/exa call: when a target URL is present, a
  // bare generic intent ("find the main data/listing endpoint…") makes the remote exa service
  // return off-domain API-doc junk (bmo.com → docs.nex.ai) that matches the jargon but not the
  // site. Folding the domain in is ZERO extra latency (same single call) and empirically flips
  // the result on-target (bmo.com → developer.bmo.com/api/commercial). Marketplace vector-match
  // for a specific URL is near-always empty anyway, so anchoring the query doesn't cost recall.
  const searchDomainAnchor = context?.url && process.env.UNBROWSE_SEARCH_DOMAIN_ANCHOR !== "0"
    ? (() => { try { return new URL(context.url).hostname.replace(/^www\./, ""); } catch { return ""; } })()
    : "";
  const searchQueryIntent = searchDomainAnchor ? `${searchDomainAnchor} ${queryIntent}` : queryIntent;

  // Interop discovery (opt-in: UNBROWSE_INTEROP_DISCOVERY=1). Surface the
  // primitives a site already uses — x402 Bazaar resources, installed skills —
  // ranked by real adoption, so the agent is pointed at what it already pays for /
  // runs, not a redundant re-wrap. Zero added latency + no throw when the flag is
  // off (the gate short-circuits before any network call).
  try {
    const domainForInterop = context?.domain ?? (context?.url ? new URL(context.url).hostname : undefined);
    const { discoverSitePrimitives } = await import("../interop/mount.js");
    const interopPrimitives = await discoverSitePrimitives(queryIntent, domainForInterop);
    if (interopPrimitives.length > 0) {
      decisionTrace.interop_primitives = interopPrimitives.slice(0, 10);
    }
  } catch {
    // interop discovery is additive — never let it break resolve.
  }

  // When the agent explicitly passes endpoint_id, execute directly — they already chose.
  const agentChoseEndpoint = !!params.endpoint_id;

  const forceCapture = !!options?.force_capture;
  const clientScope = options?.client_scope ?? "global";
  // force_capture: clear domain caches so we go straight to browser capture
  if (forceCapture && context?.url) {
    const d = getDomainReuseKey(context.url) ?? new URL(context.url).hostname;
    for (const [k] of capturedDomainCache) {
      if (k.startsWith(`${clientScope}:`) && k.includes(`:${d}:`)) capturedDomainCache.delete(k);
    }
    for (const [k] of skillRouteCache) {
      if (k.startsWith(`${clientScope}:`) && k.includes(`:${d}:`)) skillRouteCache.delete(k);
    }
    for (const [k] of routeResultCache) {
      if (k.startsWith(`${clientScope}:`) && k.includes(`:${d}:`)) routeResultCache.delete(k);
    }
  }

  function finalize(
    source: OrchestrationTiming["source"],
    result: unknown,
    skillId?: string,
    skill?: SkillManifest,
    trace?: ExecutionTrace,
  ): OrchestrationTiming {
    timing.total_ms = Date.now() - t0;
    timing.actual_total_ms = timing.total_ms;
    timing.source = source;
    timing.skill_id = skillId;

    const economics = computeTimingEconomics({
      source,
      totalMs: timing.total_ms,
      result,
      skill,
      paidSearchUc: timing.paid_search_uc ?? 0,
      paidExecutionUc: timing.paid_execution_uc ?? 0,
    });
    timing.response_bytes = economics.response_bytes;
    timing.tokens_saved = economics.tokens_saved;
    timing.tokens_saved_pct = economics.tokens_saved_pct;
    timing.time_saved_pct = economics.time_saved_pct;
    timing.actual_cost_uc = economics.actual_cost_uc;
    if (economics.baseline_total_ms != null) timing.baseline_total_ms = economics.baseline_total_ms;
    if (economics.time_saved_ms != null) timing.time_saved_ms = economics.time_saved_ms;
    if (economics.baseline_cost_uc != null) timing.baseline_cost_uc = economics.baseline_cost_uc;
    if (economics.cost_saved_uc != null) timing.cost_saved_uc = economics.cost_saved_uc;

    // Stamp trace with token metrics so they persist in trace files
    if (trace) {
      trace.tokens_used = economics.response_tokens;
      trace.tokens_saved = timing.tokens_saved;
      trace.tokens_saved_pct = timing.tokens_saved_pct;
    }

    console.log(
      `[perf] ${source}: ${timing.total_ms}ms (time_saved=${timing.time_saved_pct}% tokens_saved=${timing.tokens_saved_pct}%${economics.baseline_source === "real" ? " [real baseline]" : economics.baseline_source === "estimated" ? " [estimated]" : ""})`,
    );

    // Lifecycle attribution: aggregate per-phase durations for observability
    const lifecycleSource: LifecycleEvent["source"] =
      source === "marketplace" ? "marketplace" : source === "route-cache" ? "cache" : "live-capture";
    const skillIdForLifecycle = skillId ?? "unknown";
    const now = new Date().toISOString();
    const lifecycleEvents: LifecycleEvent[] = [];
    if (timing.get_skill_ms > 0) {
      lifecycleEvents.push({ phase: "resolve", skill_id: skillIdForLifecycle, timestamp: now, duration_ms: timing.get_skill_ms, source: lifecycleSource });
    }
    if (timing.execute_ms > 0) {
      lifecycleEvents.push({ phase: "execute", skill_id: skillIdForLifecycle, timestamp: now, duration_ms: timing.execute_ms, source: lifecycleSource });
    }
    if (timing.total_ms > 0) {
      lifecycleEvents.push({ phase: "discover", skill_id: skillIdForLifecycle, timestamp: now, duration_ms: timing.total_ms, source: lifecycleSource });
    }
    const lifecycleTotals = attributeLifecycle(lifecycleEvents);
    if (lifecycleTotals.size > 0) {
      const breakdown = [...lifecycleTotals.entries()].map(([phase, ms]) => `${phase}=${ms}ms`).join(" ");
      console.log(`[lifecycle] ${breakdown}`);
    }
    // Fire-and-forget to backend
    recordOrchestrationPerf(timing).catch(() => {});
    // Persist anonymized local trace artifact (#28)
    emitRouteTrace({
      trace_id: trace?.trace_id ?? nanoid(),
      session_scope: clientScope,
      goal: intent,
      domain: context?.domain ?? (context?.url ? (() => { try { return new URL(context.url!).hostname; } catch { return ""; } })() : ""),
      started_at: new Date(t0).toISOString(),
      skill_id: skillId,
      endpoint_id: trace?.endpoint_id,
      source,
      status_code: trace?.status_code,
      response_bytes: timing.response_bytes,
      result,
      schema_match: trace?.success ?? false,
      candidates_considered: timing.candidates_found,
      bindings_before: params,
      bindings_resolved: {},
      bindings_missing: [],
      outcome: trace?.success === false ? "failure" : trace?.success ? "success" : "skip",
      error: trace?.error,
    });
    // Auto-file GitHub issues on repeated failures
    if (trace?.success === false && trace?.error && skillId) {
      const domain = context?.domain ?? (context?.url ? (() => { try { return new URL(context.url!).hostname; } catch { return ""; } })() : "");
      recordFailure({
        skillId,
        endpointId: trace.endpoint_id,
        domain,
        intent,
        url: context?.url,
        error: trace.error,
      });
    }
    if (!routingCompleted) {
      routingCompleted = true;
      routingCollector.addDomain(skill?.domain ?? context?.domain ?? context?.url);
      const finalOutcome =
        trace?.success === false
          ? "failure"
          : trace?.endpoint_id
            ? "success"
            : "defer";
      routingCollector.complete({
        outcome: finalOutcome,
        completedAt: new Date().toISOString(),
        totalApiCalls: routingApiCalls,
        retryCount: routingRetryCount,
        userOverride: agentChoseEndpoint,
        requiredRecovery: routingRequiredRecovery,
      });
      recordRoutingTelemetry(sanitizeRoutingEventBatch(routingCollector.toBatch())).catch(() => {});
    }
    return timing;
  }

  async function openBrowseSessionHandoff(url: string, tabId?: string): Promise<OrchestratorResult | null> {
    await kuri.start().catch(() => {});

    let handoffTabId = tabId ?? "";
    if (handoffTabId) {
      const currentUrl = await kuri.getCurrentUrl(handoffTabId).catch(() => "");
      if (!currentUrl) handoffTabId = "";
    }
    if (!handoffTabId) {
      handoffTabId = await kuri.newTab(url).catch(() => "");
    }
    if (!handoffTabId) return null;

    const domain = new URL(url).hostname.replace(/^www\./, "");
    try {
      const { extractBrowserCookies } = await import("../auth/browser-cookies.js");
      const { cookies } = extractBrowserCookies(domain);
      for (const cookie of cookies) await kuri.setCookie(handoffTabId, cookie).catch(() => {});
    } catch { /* non-fatal */ }
    await kuri.evaluate(handoffTabId, (await import("../capture/index.js")).INTERCEPTOR_SCRIPT).catch(() => {});
    await kuri.harStart(handoffTabId).catch(() => {});
    try {
      const routesModule = await import("../api/routes.js");
      if (typeof routesModule.registerBrowseSession === "function") {
        routesModule.registerBrowseSession(handoffTabId, url, domain);
      }
    } catch { /* routes module may not expose this yet */ }

    const now = new Date().toISOString();
    const trace: ExecutionTrace = {
      trace_id: nanoid(),
      skill_id: "browse-session",
      endpoint_id: "",
      started_at: now,
      completed_at: now,
      success: true,
    };
    return {
      result: {
        status: "browse_session_open",
        tab_id: handoffTabId,
        url,
        domain,
        message: `No cached API for this intent. Browser session open with auth on ${domain}. Use unbrowse snap/click/fill to achieve your intent. All traffic is being passively captured and indexed — run unbrowse close when done.`,
        next_step: "unbrowse snap --filter interactive",
        commands: [
          "unbrowse snap --filter interactive",
          "unbrowse click <ref>",
          "unbrowse fill <ref> <value>",
          "unbrowse press Enter",
          "unbrowse scroll",
          "unbrowse text",
          "unbrowse close",
        ],
      },
      trace,
      source: "browse-session" as any,
      skill: undefined as any,
      timing: finalize("browse-session" as any, null, "browse-session", undefined as any, trace),
    };
  }
  /** Always defer to the agent — auto-exec is unreliable and picks wrong endpoints. */
  async function buildDeferralWithAutoExec(
    skill: SkillManifest,
    source: "marketplace" | "live-capture",
    extraFields?: Record<string, unknown>,
  ): Promise<AutoExecDecision> {
    // WAVE 2 server-move: the agent-facing resolve shortlist is the
    // primary surface where ranking intelligence is observed. Round-trip
    // the backend rank route here (already an async context) so the
    // tuning weights live server-side. rankEndpointsServerFirst falls
    // back to the local ranker transparently on any backend failure, so
    // an offline resolve still returns a shortlist (degraded, not empty).
    let serverScores: Map<string, number> | undefined;
    try {
      const serverRanked = await rankEndpointsServerFirst(
        skill.endpoints,
        queryIntent,
        skill.domain,
        context?.url,
        params,
        skill.operation_graph,
      );
      const map = new Map<string, number>();
      for (const r of serverRanked) map.set(r.endpoint.endpoint_id, r.score);
      if (map.size > 0) serverScores = map;
    } catch {
      // x402 payment-required (the only throw path) — let the local
      // ranker decide rather than failing the whole resolve.
      serverScores = undefined;
    }
    return {
      orchestratorResult: buildDeferral(skill, source, extraFields, serverScores),
      autoexecFailedAll: false,
    };
  }

  /** Build a deferral response — returns the skill + ranked endpoints for the agent to choose.
   *  `serverScores` (WAVE 2 server-move): when the backend rank route
   *  produced an authoritative score map, it overrides the local
   *  (degraded-fallback) per-endpoint scores before the search-like and
   *  graph-reachability passes run. Absent => local ranker is authoritative
   *  (offline / backend-unreachable path; resolve never hard-fails). */
  function buildDeferral(
    skill: SkillManifest,
    source: "marketplace" | "live-capture",
    extraFields?: Record<string, unknown>,
    serverScores?: Map<string, number>,
  ): OrchestratorResult {
    const resolvedSkill = withContextReplayEndpoint(skill, queryIntent, context?.url);
    const usableEndpoints = resolvedSkill.endpoints.filter((endpoint) =>
      isResolveUsableEndpointForIntent(endpoint, queryIntent, context?.url),
    );
    const endpointScopedSkill =
      usableEndpoints.length === resolvedSkill.endpoints.length
        ? resolvedSkill
        : { ...resolvedSkill, endpoints: usableEndpoints };
    const knownBindings = knownBindingsFromInputs(params, context?.url);
    const chunk = getSkillChunk(endpointScopedSkill, {
      intent: queryIntent,
      known_bindings: knownBindings,
      include_full_relevant_graph: true,
    });
    let epRanked = rankEndpoints(endpointScopedSkill.endpoints, queryIntent, endpointScopedSkill.domain, context?.url, params);
    // WAVE 2 server-move: when the backend rank route returned an
    // authoritative score map, override the local (degraded-fallback)
    // scores so the ranking *intelligence* lives server-side and is no
    // longer recoverable from the client bundle. Endpoints the local
    // ranker kept but the server omitted are pinned below server-scored
    // ones (the server's noise filter dropped them on purpose). The
    // downstream search-like demotion + graph-reachability passes still
    // run on top, so structural invariants are preserved.
    if (serverScores && serverScores.size > 0 && epRanked.length > 0) {
      let anyServerScored = false;
      epRanked = epRanked.map((r) => {
        const s = serverScores.get(r.endpoint.endpoint_id);
        if (s == null) return r;
        anyServerScored = true;
        return { ...r, score: s };
      });
      if (anyServerScored) epRanked.sort((a, b) => b.score - a.score);
    }
    if (isSearchLikeIntent(queryIntent, context?.url)) {
      const hasStructuredSearchApi = epRanked.some((r) =>
        !r.endpoint.dom_extraction &&
        r.endpoint.response_schema &&
        endpointHasSearchBindings(r.endpoint)
      );
      if (hasStructuredSearchApi) {
        epRanked = epRanked.map((r) =>
          isPageFetchEndpoint(r.endpoint)
            ? { ...r, score: Math.min(r.score, 60) }
            : r
        );
        epRanked.sort((a, b) => b.score - a.score);
      }
    }
    // Graph-aware reachability filter. Edge confidences are
    // server-authoritative (the DAG moat): the structural topology is built
    // locally, but the cross-user online-learned confidence is projected
    // down here. The projection is whatever the server last returned for
    // this domain (cached in-process by syncEdgeConfidence, refreshed by the
    // fire-and-forget outcome reports). Degraded fallback: no cached
    // projection (backend never reached) leaves the local last-known /
    // structural confidence in place; resolve never hard-fails on this.
    let deferGraph = ensureSkillOperationGraph(endpointScopedSkill);
    if (endpointScopedSkill.domain && deferGraph.edges.length > 0) {
      // Fire-and-forget refresh so the NEXT resolve sees the latest
      // cross-user projection. Never blocks this resolve.
      void syncEdgeConfidence(
        endpointScopedSkill.domain,
        [],
        deferGraph.edges.map((edge) => edge.edge_id),
      ).catch(() => { /* backend unreachable; keep cached/local */ });
      deferGraph = applyProjectedEdgeConfidences(
        deferGraph,
        getCachedEdgeConfidenceProjection(endpointScopedSkill.domain),
      );
    }
    const reachableIds = computeReachableEndpoints(deferGraph, knownBindings);
    if (reachableIds.size > 0) {
      const reachableEndpointIds = new Set(
        [...reachableIds]
          .map((operationId) => deferGraph.operations.find((operation) => operation.operation_id === operationId)?.endpoint_id)
          .filter((endpointId): endpointId is string => !!endpointId),
      );
      epRanked = epRanked.filter((ranked) => reachableEndpointIds.has(ranked.endpoint.endpoint_id));
    }
    const workflowDag = toAgentWorkflowDagView(chunk, deferGraph, knownBindings, endpointScopedSkill.endpoints);
    // Re-order workflowDag.operations to match rankEndpoints — otherwise the
    // agent reads `available_operations` (workflowDag) and sees one ranking
    // while executeSkill internally uses rankEndpoints and runs a different
    // top-1. Symptom on x.com: shortlist always returned [HomeTimeline,
    // HomeTimeline, SearchTimeline] regardless of intent, because the chunk
    // builder used a much weaker scorer. Synchronize them here.
    const epRankedScoreByEndpointId = new Map(
      epRanked.map((r) => [r.endpoint.endpoint_id, r.score] as const),
    );
    let sortedOperations = [...workflowDag.operations].sort((a, b) => {
      const sa = epRankedScoreByEndpointId.get(a.endpoint_id) ?? -Infinity;
      const sb = epRankedScoreByEndpointId.get(b.endpoint_id) ?? -Infinity;
      return sb - sa;
    });
    // Keep available_operations membership consistent with available_endpoints.
    // The graph-reachability filter above winnowed epRanked, but workflowDag.operations
    // was built before that and still contains operations whose endpoints were dropped.
    // Observed on huggingface.co/models (2026-05-15): list intent shortlist had 3 ops
    // (2 GET DOM lists + 1 POST /api/event telemetry write) while available_endpoints
    // had only the 2 GETs. The write-on-read POST is exactly the noise we promise to
    // filter out at admission. Same membership in both views, every time.
    if (epRankedScoreByEndpointId.size > 0) {
      sortedOperations = filterDagOperationsByRankedEndpoints(sortedOperations, epRankedScoreByEndpointId.keys());
    }
    // --require-proof filter: drop unproven operations from the shortlist.
    // Filter only narrows; deferral path is unchanged.
    if (options?.require_proof) {
      sortedOperations = sortedOperations.filter((op) => op.proof_status === "proven");
    }
    workflowDag.operations = sortedOperations;
    if (workflowDag.suggested_next_operation_id !== undefined && sortedOperations.length > 0) {
      workflowDag.suggested_next_operation_id = sortedOperations[0].operation_id;
    } else if (options?.require_proof && sortedOperations.length === 0) {
      workflowDag.suggested_next_operation_id = undefined;
    }

    // A8-display fix — rewrite each operation's url_template to reflect what
    // execute will actually fetch when the caller's contextUrl differs from
    // the captured URL by exactly one entity-shaped path segment. Without
    // this, the agent looks at the resolve response and sees the captured
    // URL (e.g., github.com/trending) instead of their own (github.com/torvalds)
    // and may give up before trying to execute. The execute-time A8 logic in
    // src/execution/index.ts:executeEndpoint will rewrite again with the same
    // rules, so this is purely a UX-truth display fix — no behavioral change
    // beyond what would happen anyway.
    const __ctxUrl = context?.url;
    if (__ctxUrl) {
      const A8_SHARED = new Set([
        "api", "v1", "v2", "v3", "graphql", "rest", "rpc", "data", "json",
        "wiki", "user", "users", "post", "posts", "item", "items", "page",
        "pages", "search", "find", "list", "feed", "home", "hot", "top",
        "new", "best", "details", "detail", "info", "profile", "profiles",
        "collection", "collections", "product", "products", "p", "i", "s",
      ]);
      for (const op of workflowDag.operations) {
        const tmpl = op.url_template ?? "";
        if (!tmpl || /\{[^}]+\}/.test(tmpl)) continue; // skip parameterised
        try {
          const cap = new URL(tmpl);
          const ctx = new URL(__ctxUrl);
          if (cap.hostname !== ctx.hostname) continue;
          const cs = cap.pathname.split("/").filter(Boolean);
          const xs = ctx.pathname.split("/").filter(Boolean);
          if (cs.length !== xs.length || cs.length === 0) continue;
          // A8-display generalised: any number of differing segments are OK
          // as long as every diff pair is entity-shaped on both sides. Reddit
          // r/{sub}/comments/{id}/{slug} differs in 3 segments — the old
          // diffCount===1 gate left those URLs un-rewritten in the shortlist.
          let diffCount = 0;
          const diffIndices: number[] = [];
          for (let i = 0; i < cs.length; i++) {
            if (cs[i].toLowerCase() === xs[i].toLowerCase()) continue;
            diffCount += 1;
            diffIndices.push(i);
          }
          if (diffCount === 0) continue;
          const allEntityShaped = diffIndices.every((i) => {
            const a = cs[i].toLowerCase();
            const b = xs[i].toLowerCase();
            const aOk = !A8_SHARED.has(a) && a.length >= 3 && !/^\d+$/.test(a);
            const bOk = !A8_SHARED.has(b) && b.length >= 3 && !/^\d+$/.test(b);
            return aOk && bOk;
          });
          if (!allEntityShaped) continue;
          op.url_template = `${cap.protocol}//${cap.hostname}${cap.port ? `:${cap.port}` : ""}${ctx.pathname}${cap.search}${cap.hash}`;
        } catch { /* skip */ }
      }
    }
    const dagOperationByEndpointId = new Map(
      workflowDag.operations.map((operation) => [operation.endpoint_id, operation] as const),
    );
    const deferTrace: ExecutionTrace = {
      trace_id: nanoid(),
      skill_id: endpointScopedSkill.skill_id,
      endpoint_id: "",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: true,
    };
    writeDebugTrace("resolve", {
      ...decisionTrace,
      outcome: "deferral",
      source,
      skill_id: endpointScopedSkill.skill_id,
      available_endpoints: epRanked.slice(0, 10).map((r) => {
        const descriptionMeta = getEndpointDescriptionMetadata(r.endpoint);
        return {
          endpoint_id: r.endpoint.endpoint_id,
          source_skill_id: endpointScopedSkill.skill_id,
          score: Math.round(r.score * 10) / 10,
          description: descriptionMeta.display,
          description_source: descriptionMeta.source,
          description_needs_review: descriptionMeta.needs_review,
          ...(descriptionMeta.warning ? { description_warning: descriptionMeta.warning } : {}),
          url: r.endpoint.url_template,
        };
      }),
      extra: extraFields ?? null,
    });
    const deferStepIndex = recordRoutingCandidates(endpointScopedSkill, epRanked, source);
    recordRoutingStep("defer", endpointScopedSkill, deferTrace, null, {
      stepIndex: deferStepIndex,
      candidateCount: epRanked.length,
      userOverride: false,
      didStepUnlockNextStep: false,
      requiredRecovery: false,
    });
    // === H6: Resolve loop short-circuit ===
    // When epRanked is empty for a same-host resolve, return a hard handoff stub
    // so agents don't keep re-resolving the same host expecting different results.
    // C5b: also handoff when only negative-score endpoints remain — surfacing a
    // wrong-shape endpoint to the agent (e.g., /trending when they asked for a
    // user profile) is worse than honestly saying "no match, browse to capture".
    // The picker is the calling LLM; if every option scored < 0 we have nothing
    // to actually pick from, so we'd rather give an actionable next_step.
    const isSameHostResolve = !!context?.url && !!endpointScopedSkill.domain;
    // C5b: extend handoff to registrable-domain match (youtube.com vs music.youtube.com,
    // google.com vs news.google.com). When the cached skill is a sibling subdomain of
    // the user's contextUrl, an empty/all-negative shortlist still means "no real match
    // for THIS task" — better to handoff than surface the wrong endpoint.
    const hostMatches = isSameHostResolve && (
      new URL(context.url).hostname === endpointScopedSkill.domain ||
      getRegistrableDomain(new URL(context.url).hostname) === getRegistrableDomain(endpointScopedSkill.domain)
    );
    const allNegative = epRanked.length > 0 && epRanked.every((r) => r.score < 0);
    if ((epRanked.length === 0 || allNegative) && hostMatches) {
      // V1.5 (Lewis 2026-05-21 "fix it all up and benchmax til we hit 100%"):
      // instead of returning a `resolve_hard_handoff` envelope that forces
      // the agent to make a SECOND call (`unbrowse fetch`) to get the data,
      // inject the structural page_fetch endpoint as a real selectable
      // candidate. The agent's normal execute call against page_fetch
      // returns the rendered HTML, then the dom_extraction path on execute
      // returns the structured data inline. Same UX as a regular resolve.
      // Substrate-faithful: page_fetch is a STRUCTURAL primitive (one per
      // captured skill, no per-host arms), not a registry. It's the
      // "invariant floor" the rest of the bedrock already builds on.
      //
      // The agent still sees the original ranker shortlist in
      // available_endpoints + agent_warning, plus a diagnostic note that
      // the page_fetch fallback is the recommended pick when none of the
      // ranker candidates look intent-relevant. The agent judges.
      const sourceCandidates = epRanked.length > 0
        ? epRanked.map((r) => ({ ep: r.endpoint as Record<string, unknown>, score: r.score as number }))
        : (endpointScopedSkill.endpoints || []).map((ep) => ({ ep: ep as unknown as Record<string, unknown>, score: NaN }));
      const fallbackShortlist = sourceCandidates.slice(0, 5).map(({ ep, score }) => ({
        endpoint_id: ep.endpoint_id,
        source_skill_id: endpointScopedSkill.skill_id,
        method: ep.method,
        url_template: ep.url_template,
        description: ep.description ?? (ep as Record<string, unknown>).description_out,
        score: Number.isFinite(score) ? score : null,
        agent_warning: epRanked.length === 0
          ? "ranker filtered ALL candidates — corpus is shown raw; agent must judge whether any satisfies intent"
          : "ranker scored ≤0; agent must judge whether this satisfies the intent",
      }));

      const pageFetchUrl = context?.url ?? `https://${endpointScopedSkill.domain}`;
      const pageFetchEp = buildPageFetchEndpoint(pageFetchUrl, queryIntent);
      const pageFetchShortlistEntry = {
        endpoint_id: pageFetchEp.endpoint_id,
        source_skill_id: endpointScopedSkill.skill_id,
        method: pageFetchEp.method,
        url_template: pageFetchEp.url_template,
        description: pageFetchEp.description,
        score: 1, // positive so the agent sees it as recommended over neg-scored siblings
        agent_warning: "page_fetch fallback (substrate's structural floor): fetches the rendered page + extracts inline. Pick this when none of the ranker candidates look intent-relevant.",
      };
      // page_fetch FIRST so picker.first() returns it. Ranker siblings follow.
      const shortlistWithPageFetch = [pageFetchShortlistEntry, ...fallbackShortlist];
      return {
        result: {
          message: `No cached API for "${queryIntent}" on ${endpointScopedSkill.domain}; offering page_fetch fallback + ranker shortlist. Pick endpoint_id and call execute.`,
          skill_id: endpointScopedSkill.skill_id,
          available_operations: shortlistWithPageFetch,
          available_endpoints: shortlistWithPageFetch,
          shortlist_for_judgment: shortlistWithPageFetch,
          agent_facing_shortlist: shortlistWithPageFetch,
          // Keep diagnostic context for agents that want to know why
          handoff_context: {
            ranker_returned: epRanked.length,
            all_negative: allNegative,
            domain: endpointScopedSkill.domain,
            note: "page_fetch fallback added so execute can return page content inline instead of forcing a second `unbrowse fetch` call.",
          },
          judgment_question: `Ranker handed off all ${endpointScopedSkill.endpoints.length} endpoints as low-confidence for intent "${queryIntent}". page_fetch is the recommended structural fallback (always-callable, returns rendered HTML + auto-extracts). Pick it OR inspect the ranker shortlist if any candidate's url_template suggests intent-relevance.`,
        },
        trace: deferTrace,
        source: "deferral" as any,
        skill: undefined as any,
        timing: finalize("deferral" as any, null, "deferral", undefined as any, deferTrace),
      };
    }

    return {
      result: {
        message: `Found ${epRanked.length} endpoint(s). Pick one and call POST /v1/skills/${endpointScopedSkill.skill_id}/execute with params.endpoint_id.`,
        // Bug 4: empty-resolve must NOT be silent. When the deferred shortlist
        // is empty (capture produced a skill but no endpoint survived ranking),
        // emit an explicit error_code so the agent can distinguish
        // "succeeded with zero ops" from "captured fine, ranker ate everything".
        ...(epRanked.length === 0 ? { error_code: "no_endpoint_extracted" } : {}),
        skill_id: endpointScopedSkill.skill_id,
        available_operations: workflowDag.operations,
        workflow_dag: workflowDag,
        missing_bindings: chunk.missing_bindings,
        available_endpoints: epRanked.slice(0, 10).map((r) => {
          const descriptionMeta = getEndpointDescriptionMetadata(r.endpoint);
          return {
            endpoint_id: r.endpoint.endpoint_id,
            // Each shortlisted endpoint carries the skill_id of the skill
            // it was ranked from. Execute attribution: pre-fix the
            // collector took `skill = top-level skill.skill_id` and
            // `endpoint = available_endpoints[0].endpoint_id`, but those
            // can disagree when resolve's shortlist contains endpoints
            // merged in from cached publishes (gate probe 003 crates.io
            // 2026-05-19: top-level skill V-ugzSxDfgDKHR0TD_ufE had one
            // endpoint, available_endpoints[0]=3bqbHNiOc3pUKKy3ezdAG was
            // not in it; execute returned endpoint_not_found). Callers
            // that want correct attribution use this field as the skill
            // param; falling back to top-level skill_id is legal when
            // the shortlist endpoint genuinely belongs to that skill.
            source_skill_id: endpointScopedSkill.skill_id,
            method: r.endpoint.method,
            description: descriptionMeta.display,
            description_source: descriptionMeta.source,
            description_needs_review: descriptionMeta.needs_review,
            ...(descriptionMeta.warning ? { description_warning: descriptionMeta.warning } : {}),
            url:
              r.endpoint.url_template.length > 120
                ? r.endpoint.url_template.slice(0, 120) + "..."
                : r.endpoint.url_template,
            score: Math.round(r.score * 10) / 10,
            schema_summary: r.endpoint.response_schema
              ? summarizeSchema(r.endpoint.response_schema)
              : null,
            input_params: (() => {
              const _gql = decomposeGraphqlEndpoint(r.endpoint);
              if (_gql.isGraphql && _gql.agentParams.length > 0) {
                // Surface flat agent-friendly params instead of the opaque {variables, features} slots.
                // Agents pass `q` / `rawQuery` / etc; the executor reconstructs the GraphQL JSON.
                return _gql.agentParams.map((ap) => {
                  const aliases = (ap as { aliases?: string[] }).aliases ?? [];
                  return {
                    key: aliases.length > 0 ? aliases[0] : ap.key,
                    type: ap.semantic_type,
                    required: ap.required,
                    example: ap.example,
                    graphql_variables_path: ap.variables_path,
                    ...(aliases.length > 0 ? { aliases: [ap.key, ...aliases.slice(1)] } : {}),
                  };
                });
              }
              // Connect/gRPC: surface flat message-field holes (mirrors GraphQL).
              // Agents pass `tweetId`/`userId`; the executor reconstructs the
              // Connect JSON message via buildGrpcRequestBody. Path = fixed structure.
              const _grpc = decomposeGrpcEndpoint(r.endpoint);
              if (_grpc.isGrpc && _grpc.agentParams.length > 0) {
                return _grpc.agentParams.map((ap) => ({
                  key: ap.key,
                  type: ap.semantic_type,
                  required: ap.required,
                  example: ap.example,
                  grpc_message_path: ap.message_path,
                }));
              }
              // JSON-RPC 2.0: surface params fields as flat holes (method = fixed structure).
              const _rpc = decomposeJsonRpcEndpoint(r.endpoint);
              if (_rpc.isJsonRpc && _rpc.agentParams.length > 0) {
                return _rpc.agentParams.map((ap) => ({
                  key: ap.key,
                  type: ap.semantic_type,
                  required: ap.required,
                  example: ap.example,
                  jsonrpc_params_path: ap.params_path,
                }));
              }
              // form-data / urlencoded: surface form fields as flat holes.
              const _form = decomposeFormEndpoint(r.endpoint);
              if (_form.isForm && _form.agentParams.length > 0) {
                return _form.agentParams.map((ap) => ({
                  key: ap.key,
                  type: ap.semantic_type,
                  required: ap.required,
                  example: ap.example,
                  form_field_path: ap.field_path,
                }));
              }
              // SOAP / XML: surface leaf-element values as flat holes (envelope = fixed structure).
              const _xml = decomposeXmlEndpoint(r.endpoint);
              if (_xml.isXml && _xml.agentParams.length > 0) {
                return _xml.agentParams.map((ap) => ({
                  key: ap.key,
                  type: ap.semantic_type,
                  required: ap.required,
                  example: ap.example,
                  xml_path: ap.xml_path,
                }));
              }
              return r.endpoint.semantic?.requires?.map((b) => ({
                key: b.key,
                type: b.type ?? b.semantic_type,
                required: b.required ?? false,
                example: b.example_value,
              })) ?? [];
            })(),
            description_in: r.endpoint.semantic?.description_in,
            example_fields: r.endpoint.semantic?.example_fields?.slice(0, 12),
            sample_values: extractSampleValues(r.endpoint.semantic?.example_response_compact),
            dom_extraction: !!r.endpoint.dom_extraction,
            trigger_url: r.endpoint.trigger_url,
            needs_params: r.endpoint.semantic?.requires?.some((b) => b.required) ?? false,
            prefetch_get_operations: dagOperationByEndpointId.get(r.endpoint.endpoint_id)?.prefetch_get_operations ?? [],
            // Confidence: 0.0-1.0 derived from score for F2 (confidence scoring)
            confidence: Math.min(1, Math.max(0, Math.round(r.score / 1000) * 10) / 10),
          };
        }),
        ...extraFields,
        // Harness #2: Diagnostic context for agents
        diagnostic: {
          confidence: epRanked.length > 0
            ? Math.min(1, Math.max(0, Math.round(epRanked[0].score / 10000) / 10))
            : 0,
          top_reasoning: epRanked.length > 0
            ? `Best match: ${epRanked[0].endpoint.description ?? epRanked[0].endpoint.url_template} (score: ${epRanked[0].score})`
            : "No endpoints matched this intent",
          known_issues: epRanked.length === 0 ? [`${source}: no endpoints found for intent "${queryIntent}"`] : [],
          endpoint_count: epRanked.length,
          cache_source: source,
        },
      },
      trace: deferTrace,
      source,
      skill: endpointScopedSkill,
      timing: finalize(source, null, endpointScopedSkill.skill_id, endpointScopedSkill, deferTrace),
    };
  }

  /** Generate fallback interaction suggestions for diagnostic context. */
  function getFallbackInteractions(pageUrl?: string): string[] {
    if (!pageUrl) return ["Try specifying a domain in context, or check if the service has an active skill in the marketplace."];
    try {
      const hostname = new URL(pageUrl).hostname;
      return [
        `Try navigating to https://${hostname} first to discover the API: unbrowse go https://${hostname}`,
        "Then run snap --filter interactive to discover endpoints on the live page.",
      ];
    } catch {
      return ["Rephrase the intent with more specific domain or URL context."];
    }
  }

  function buildNoCachedMatch(reason = "No cached endpoint matched this intent yet."): OrchestratorResult {
    const missTrace: ExecutionTrace = {
      trace_id: nanoid(),
      skill_id: "",
      endpoint_id: "",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: false,
      error: "no_cached_match",
    };
    writeDebugTrace("resolve", {
      ...decisionTrace,
      outcome: "no-cached-match",
      source: "marketplace",
      requested_domain: requestedDomain ?? null,
      context_url: context?.url ?? null,
      intent: queryIntent,
    });
    return {
      result: {
        status: "no_cached_match",
        message: reason,
        intent: queryIntent,
        domain: requestedDomain ?? null,
        url: context?.url ?? null,
        // Harness #2 + A6: Diagnostic context + actionable error
        diagnostic: {
          confidence: 0,
          top_reasoning: reason,
          known_issues: ["no_cached_match", "intent not covered by any skill in marketplace"],
          endpoint_count: 0,
          cache_source: "no_cache",
        },
        suggested_next_action: requestedDomain
          ? `Try capturing this domain first: unbrowse go https://${requestedDomain} then snap/click/fill to discover the API.`
          : "Capture the target URL with `unbrowse go <url>` to discover available APIs.",
      },
      trace: missTrace,
      source: "marketplace",
      skill: undefined as any,
      timing: finalize("marketplace", null, undefined, undefined, missTrace),
    };
  }

  function missingTemplateParams(
    endpoint: SkillManifest["endpoints"][number],
    boundParams: Record<string, unknown>,
  ): string[] {
    const urlTemplate = endpoint.url_template;
    const required = [...urlTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    return required.filter((name) => {
      const value = boundParams[name];
      return value == null || value === "";
    });
  }

  const UNSAFE_ACTION_BLOCK_THRESHOLD = 0.6;

  function computeUnsafeActionScore(endpoint: SkillManifest["endpoints"][number]): number {
    let score = 0;
    if (endpoint.idempotency === "unsafe") score += 0.4;
    if (endpoint.method === "POST" || endpoint.method === "PUT" || endpoint.method === "DELETE") score += 0.2;
    const inferredFromBundle = /inferred from js bundle/i.test(endpoint.description ?? "");
    if (inferredFromBundle) score += 0.2; // guessed from bundle = risky
    if (!endpoint.response_schema) score += 0.1;
    if (endpoint.verification_status === "failed") score += 0.1;
    if (endpoint.reliability_score < 0.3) score += 0.1;
    // Reduce score for strong evidence
    if (endpoint.trigger_url) score -= 0.1;
    if (endpoint.verification_status === "verified") score -= 0.15;
    return Math.max(0, Math.min(1, score));
  }


  function canAutoExecuteEndpoint(endpoint: SkillManifest["endpoints"][number]): boolean {
    const endpointParams = resolveEndpointTemplateBindings(endpoint, resolvedParams, context?.url);
    const missing = missingTemplateParams(endpoint, endpointParams);
    // For params that inferDefaultParam can't resolve synchronously, check if LLM
    // inference is plausible (i.e. we have an intent string and unbound params).
    // The actual LLM call happens at execution time, not here.
    const unresolvedBySync = missing.filter((name) => inferDefaultParam(name, queryIntent) === undefined);
    if (unresolvedBySync.length > 0) {
      // If we have an intent, assume the LLM can likely resolve remaining params
      // (search terms, locations, dates, etc.) — don't block execution.
      if (!queryIntent || queryIntent.trim().length === 0) return false;
      // Safety: don't auto-execute if there are too many unresolved params (likely wrong endpoint)
      if (unresolvedBySync.length > 4) return false;
    }
    if (endpoint.dom_extraction) return true;
    if (endpoint.method !== "GET" && endpoint.idempotency !== "safe") {
      // Block high-risk non-safe endpoints unless caller has confirmed
      const unsafeScore = computeUnsafeActionScore(endpoint);
      if (unsafeScore >= UNSAFE_ACTION_BLOCK_THRESHOLD && !options?.confirm_unsafe) {
        console.log(
          `[auto-exec] blocked unsafe endpoint ${endpoint.endpoint_id} (unsafe_score=${unsafeScore.toFixed(2)})`,
        );
        return false;
      }
    }
    return endpoint.method === "GET" || endpoint.idempotency === "safe";
  }

  const resolvedParams: Record<string, unknown> = (() => {
    const merged: Record<string, unknown> = { ...params };
    if (context?.url) {
      try {
        const u = new URL(context.url);
        for (const [k, v] of u.searchParams.entries()) {
          if (merged[k] == null || merged[k] === "") merged[k] = v;
        }
      } catch {
        /* ignore */
      }
    }
    return merged;
  })();

  // --- Prior trace retrieval (lightweight RAG signal) ---
  // Retrieve prior execution traces for this domain+intent to boost endpoints that worked before.
  const requestedDomainForTraces = context?.domain ?? (context?.url ? (() => { try { return new URL(context.url!).hostname; } catch { return null; } })() : null);
  let priorSuccessEndpoints: Set<string> | undefined;
  if (requestedDomainForTraces && queryIntent) {
    try {
      const priorTraces = findTracesByIntent(requestedDomainForTraces, queryIntent, 3);
      if (priorTraces.length > 0) {
        priorSuccessEndpoints = new Set(
          priorTraces.filter(t => t.success && t.selected_endpoint_id)
            .map(t => t.selected_endpoint_id!),
        );
        (decisionTrace as Record<string, unknown>).prior_traces = priorTraces.length;
        (decisionTrace as Record<string, unknown>).prior_success_endpoints = [...priorSuccessEndpoints];
      }
    } catch {
      // Trace retrieval must never block the resolve path
    }
  }

  const routingSessionId = nanoid();
  const routingCollector = createRoutingTelemetryCollector({
    sessionId: routingSessionId,
    startedAt: new Date(t0).toISOString(),
    intent,
    traceVersion: TRACE_VERSION,
    anonymizedAgentId: getAgentId() ? hashValue(getAgentId()!) : undefined,
    runType: context?.url || forceCapture ? "long_running" : "single_shot",
    contextBuckets: buildRoutingContextBuckets(
      intent,
      projection,
      options,
      !!priorSuccessEndpoints && priorSuccessEndpoints.size > 0,
    ),
    normalizedDomains: [
      requestedDomainForTraces ?? context?.domain ?? (context?.url ? new URL(context.url).hostname : undefined),
    ].filter((value): value is string => !!value),
  });
  let routingApiCalls = 0;
  let routingRetryCount = 0;
  let routingRequiredRecovery = false;
  let routingCompleted = false;

  function currentKnownBindings(): Record<string, unknown> {
    return knownBindingsFromInputs(resolvedParams, context?.url);
  }

  function recordRoutingCandidates(
    skill: SkillManifest,
    ranked: RankedCandidate[],
    source: import("../types/index.js").OrchestrationTiming["source"],
    options?: {
      selectedEndpointId?: string;
      rejectionReasons?: Record<string, string | undefined>;
      stepIndex?: number;
    },
  ): number {
    routingCollector.addDomain(skill.domain);
    const known = currentKnownBindings();
    const reachableEndpointIds = computeReachableEndpoints(
      ensureSkillOperationGraph(skill),
      known,
    );
    const chunk = getSkillChunk(skill, {
      intent: queryIntent,
      known_bindings: known,
      max_operations: 8,
    });
    return routingCollector.recordCandidates({
      stepIndex: options?.stepIndex,
      source: source === "dom-fallback" ? "live-capture" : source === "first-pass" ? "browser-action" : source,
      stateHashBefore: hashRoutingState(known),
      candidateCount: ranked.length,
      reachableOperationCount: reachableEndpointIds.size || undefined,
      availableBindingCount: Object.keys(known).length,
      missingBindingCount: chunk.missing_bindings.length,
      selectedEndpointId: options?.selectedEndpointId,
      selectedOperationId:
        skill.operation_graph?.operations.find(
          (operation) => operation.endpoint_id === options?.selectedEndpointId,
        )?.operation_id,
      candidates: buildRoutingCandidateSnapshots(skill, ranked, {
        reachableEndpointIds: reachableEndpointIds.size > 0 ? reachableEndpointIds : undefined,
        selectedEndpointId: options?.selectedEndpointId,
        rejectionReasons: options?.rejectionReasons,
      }),
    });
  }

  function recordRoutingStep(
    source: import("../types/index.js").OrchestrationTiming["source"] | "defer",
    skill: SkillManifest | undefined,
    trace: ExecutionTrace,
    result: unknown,
    options?: {
      stepIndex?: number;
      selectedEndpointId?: string;
      candidateCount?: number;
      retryCount?: number;
      userOverride?: boolean;
      didStepUnlockNextStep?: boolean;
      requiredRecovery?: boolean;
    },
  ): number {
    const known = currentKnownBindings();
    const selectedEndpointId = options?.selectedEndpointId ?? trace.endpoint_id ?? undefined;
    const derived = deriveRoutingStepArtifacts({
      result,
      skill,
      selectedEndpointId,
      source: source === "defer" ? "marketplace" : source,
      bindingsBefore: known,
      bindingsAfter: {
        ...known,
        _selected_endpoint_id: selectedEndpointId ?? "",
        _response_hash: result == null ? "" : JSON.stringify(result).length.toString(),
      },
    });
    const stepIndex = routingCollector.recordStep({
      stepIndex: options?.stepIndex,
      source,
      stateHashBefore: derived.stateHashBefore,
      stateHashAfter: derived.stateHashAfter,
      selectedSkillId: skill?.skill_id,
      selectedEndpointId,
      selectedOperationId: derived.selectedOperationId,
      reachableOperationCount: trace.reachable_operation_count,
      availableBindingCount: Object.keys(known).length,
      missingBindingCount: 0,
      candidateCount: options?.candidateCount ?? trace.candidate_count ?? (selectedEndpointId ? 1 : 0),
      executionLatencyMs: trace.completed_at && trace.started_at
        ? Math.max(0, Date.parse(trace.completed_at) - Date.parse(trace.started_at))
        : undefined,
      statusCode: trace.status_code,
      success: source === "defer" ? undefined : trace.success,
      failureReason: trace.error,
      schemaFingerprint: derived.schemaFingerprint,
      responseHash: derived.responseHash,
      crossDomainTransition: false,
      retryCount: options?.retryCount ?? 0,
      userOverride: options?.userOverride ?? agentChoseEndpoint,
      didStepUnlockNextStep: options?.didStepUnlockNextStep ?? !!derived.responseHash,
      requiredRecovery: options?.requiredRecovery ?? !trace.success,
    });
    trace.session_id = routingSessionId;
    trace.step_index = stepIndex;
    trace.state_hash = derived.stateHashAfter;
    trace.candidate_count = options?.candidateCount ?? trace.candidate_count;
    trace.selected_operation_id = derived.selectedOperationId;
    trace.api_call_count = source === "defer" ? 0 : Math.max(trace.api_call_count ?? 0, selectedEndpointId ? 1 : 0);
    if (source !== "defer" && selectedEndpointId) routingApiCalls += 1;
    routingRetryCount += options?.retryCount ?? 0;
    routingRequiredRecovery ||= options?.requiredRecovery ?? !trace.success;
    return stepIndex;
  }
  /**
   * Try to auto-select and execute the best endpoint when the agent hasn't chosen one.
   * Uses BM25 ranking (boosted by LLM descriptions). Auto-executes when:
   * - Top endpoint has a clear score gap over #2 (>= 20% relative or absolute >= 15)
   * - Or skill has only 1 usable endpoint
   * Returns null if not confident enough (caller should fall back to deferral).
   */
  async function tryAutoExecute(
    skill: SkillManifest,
    source: "marketplace" | "live-capture",
  ): Promise<OrchestratorResult | null> {
    let epRanked = rankEndpoints(skill.endpoints, queryIntent, skill.domain, context?.url, resolvedParams);
    const originalRanked = epRanked;
    const chunk = getSkillChunk(skill, {
      intent: queryIntent,
      known_bindings: knownBindingsFromInputs(resolvedParams, context?.url),
      max_operations: 8,
    });
    const preferredAutoexecIds = new Set(
      epRanked.slice(0, Math.min(5, epRanked.length)).map((ranked) => ranked.endpoint.endpoint_id),
    );
    const graphEndpointIds = new Set(
      chunk.available_operation_ids.length > 0
        ? [
            ...chunk.available_operation_ids
              .map((operationId) => skill.operation_graph?.operations.find((operation) => operation.operation_id === operationId)?.endpoint_id)
              .filter((endpointId): endpointId is string => !!endpointId),
            ...preferredAutoexecIds,
          ]
        : [...chunk.operations.map((operation) => operation.endpoint_id), ...preferredAutoexecIds],
    );
    if (graphEndpointIds.size > 0) {
      epRanked = epRanked.filter((ranked) => graphEndpointIds.has(ranked.endpoint.endpoint_id));
      const hasObservedAfterFilter = epRanked.some(
        (ranked) => !/inferred from js bundle/i.test(ranked.endpoint.description ?? ""),
      );
      const observedBeforeFilter = originalRanked.filter(
        (ranked) => !/inferred from js bundle/i.test(ranked.endpoint.description ?? ""),
      );
      if (!hasObservedAfterFilter && observedBeforeFilter.length > 0) {
        epRanked = dedupeObservedOverBundle([...observedBeforeFilter, ...epRanked]);
      }
    }

    // --- Hard reachability filter (A_reachable from the Machine Intent paper) ---
    // Unreachable endpoints are removed, not just penalized. Only applied when the
    // graph has at least one reachable entry point to avoid degenerate cases.
    const reachableIds = computeReachableEndpoints(
      ensureSkillOperationGraph(skill),
      knownBindingsFromInputs(resolvedParams, context?.url),
    );
    if (reachableIds.size > 0) {
      epRanked = epRanked.filter((r) => reachableIds.has(r.endpoint.endpoint_id));
    }
    // --- end reachability filter ---
    if (epRanked.length === 0) return null;
    decisionTrace.search_candidates = epRanked.slice(0, 10).map((ranked) => ({
      endpoint_id: ranked.endpoint.endpoint_id,
      score: Math.round(ranked.score * 10) / 10,
      description: ranked.endpoint.description,
      url: ranked.endpoint.url_template,
      dom_extraction: !!ranked.endpoint.dom_extraction,
      unsafe_action_score: Math.round(computeUnsafeActionScore(ranked.endpoint) * 100) / 100,
    }));

    // When BM25 scores are tied, use schema field overlap with intent as tiebreaker.
    // "get subreddit posts" → intent tokens ["subreddit","posts","get"]
    // Endpoint with schema {title, author, score, num_comments} > {token, expires}
    if (epRanked.length >= 2 && queryIntent) {
      const intentTokens = new Set(
        queryIntent
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2),
      );
      epRanked = epRanked.map((r) => {
        let schemaBonus = 0;
        const schema = r.endpoint.response_schema;
        if (schema) {
          const schemaStr = JSON.stringify(schema).toLowerCase();
          for (const tok of intentTokens) {
            if (schemaStr.includes(tok)) schemaBonus += 5;
          }
          // Rich schemas (many fields) are more likely data endpoints
          const propCount = schema.properties ? Object.keys(schema.properties).length : 0;
          if (propCount >= 5) schemaBonus += 3;
        }
        // Penalize noise endpoints (recaptcha, token, csrf, tracking)
        const url = r.endpoint.url_template.toLowerCase();
        if (
          /recaptcha|captcha|csrf|token$|consent|badge|drawer|header-action|logging|telemetry/i.test(
            url,
          )
        ) {
          schemaBonus -= 20;
        }
        return { ...r, score: r.score + schemaBonus };
      });
      epRanked.sort((a, b) => b.score - a.score);
    }
    epRanked = dedupeObservedOverBundle(epRanked);

    const hasInternalApiCandidate = epRanked.some(
      (r) => !r.endpoint.dom_extraction && r.endpoint.method !== "WS",
    );
    const hasObservedApiCandidate = epRanked.some(
      (r) =>
        !r.endpoint.dom_extraction &&
        r.endpoint.method !== "WS" &&
        !/inferred from js bundle/i.test(r.endpoint.description ?? ""),
    );
    epRanked = epRanked.map((r) => {
      let readinessBonus = 0;
      const inferredFromBundle = /inferred from js bundle/i.test(r.endpoint.description ?? "");
      let isDocumentRoute = false;
      if (!r.endpoint.dom_extraction && context?.url) {
        try {
          const endpointUrl = new URL(r.endpoint.url_template);
          const contextPage = new URL(context.url);
          isDocumentRoute =
            endpointUrl.origin === contextPage.origin &&
            endpointUrl.pathname === contextPage.pathname &&
            !/\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(endpointUrl.pathname);
        } catch {
          /* ignore */
        }
      }
      const endpointBindings = resolveEndpointTemplateBindings(
        r.endpoint,
        resolvedParams,
        context?.url,
      );
      const missing = missingTemplateParams(r.endpoint, endpointBindings);
      if (missing.length === 0) readinessBonus += 40;
      else {
        const syncSatisfiable = missing.filter((name) => inferDefaultParam(name, queryIntent) !== undefined);
        const remaining = missing.length - syncSatisfiable.length;
        // Sync-resolvable params get full bonus; remaining params get partial credit
        // if we have an intent (LLM can likely resolve them at execution time)
        if (remaining === 0) {
          readinessBonus += 8;
        } else if (queryIntent && remaining <= 4) {
          // Likely LLM-resolvable — small penalty instead of catastrophic one
          readinessBonus += 4 - (remaining * 5);
        } else {
          readinessBonus -= missing.length * 25;
        }
      }
      if (r.endpoint.method === "GET" || r.endpoint.idempotency === "safe") readinessBonus += 15;
      if (r.endpoint.response_schema || r.endpoint.dom_extraction) readinessBonus += 10;
      if (!r.endpoint.dom_extraction && r.endpoint.method !== "WS") readinessBonus += 20;
      if (inferredFromBundle) readinessBonus -= 20;
      if (hasObservedApiCandidate && inferredFromBundle) readinessBonus -= 45;
      if (hasInternalApiCandidate && r.endpoint.dom_extraction) readinessBonus -= 35;
      if (hasInternalApiCandidate && isDocumentRoute) readinessBonus -= 80;
      if (isSearchLikeIntent(queryIntent, context?.url)) {
        const isCapturedPageArtifact = /captured page artifact/i.test(r.endpoint.description ?? "");
        if (endpointHasSearchBindings(r.endpoint)) readinessBonus += 70;
        if (endpointHasSearchBindings(r.endpoint) && r.endpoint.trigger_url) readinessBonus += 20;
        if (isCapturedPageArtifact) readinessBonus -= 55;
      }
      if (r.endpoint.trigger_url && context?.url) {
        try {
          if (new URL(r.endpoint.trigger_url).pathname === new URL(context.url).pathname)
            readinessBonus += 5;
        } catch {
          /* ignore */
        }
      }
      return { ...r, score: r.score + readinessBonus };
    });
    if (isSearchLikeIntent(queryIntent, context?.url)) {
      const hasStructuredSearchApi = epRanked.some((r) =>
        !r.endpoint.dom_extraction &&
        r.endpoint.response_schema &&
        endpointHasSearchBindings(r.endpoint)
      );
      if (hasStructuredSearchApi) {
        epRanked = epRanked.map((r) =>
          isPageFetchEndpoint(r.endpoint)
            ? { ...r, score: Math.min(r.score, 60) }
            : r
        );
      }
    }
    epRanked.sort((a, b) => b.score - a.score);
    epRanked = prioritizeIntentMatchedApis(epRanked, queryIntent, context?.url);

    // --- DAG advisory boosts (discover-choose-act) ---
    // Backend-first advisory call: tries the EmergentDB graph for cross-session
    // intelligence, falls back to local planner if backend is unavailable.
    // Hoisted to the outer scope so the execute loop can WALK the prerequisite
    // chain (run prerequisites, thread their yields) — not just rank-boost.
    let dagPlan: Awaited<ReturnType<typeof fetchDagAdvisoryPlan>> | null = null;
    if (epRanked.length > 1 && skill.domain) {
      const bindings = Object.keys(knownBindingsFromInputs(resolvedParams, context?.url));
      dagPlan = await fetchDagAdvisoryPlan(
        skill,
        epRanked[0].endpoint.endpoint_id,
        bindings,
      );
      if (dagPlan) {
        epRanked = applyDagAdvisoryBoosts(epRanked, dagPlan);
        (decisionTrace as Record<string, unknown>).dag_advisory = {
          chain_ready: dagPlan.chain_ready,
          predicted_next: dagPlan.predicted_next,
          auth_dependencies: dagPlan.auth_dependencies,
        };
      }
    }
    // --- end DAG advisory ---

    // --- Auth prerequisite gate ---
    // When the top candidate targets an auth-gated endpoint, resolve auth
    // via the runtime before attempting execution.
    if (epRanked.length > 0) {
      const topEndpoint = epRanked[0].endpoint;
      const authDeps = deriveAuthDependencies(skill, topEndpoint.endpoint_id);
      if (authDeps.length > 0) {
        const authResults = await resolveAuthPrerequisites(authDeps);
        const allAuthed = authResults.every((r) => r.authenticated);
        (decisionTrace as Record<string, unknown>).auth_prerequisites = {
          dependencies: authDeps.map((d) => ({ domain: d.domain, strategy: d.strategy })),
          resolved: allAuthed,
        };
        if (!allAuthed) {
          // Try autonomous login before giving up
          for (const dep of authDeps) {
            const loggedIn = await authRuntime.loginIfNeeded(dep.domain, dep.login_url);
            if (loggedIn) {
              console.log(`[auth] autonomous login succeeded for ${dep.domain}`);
              (decisionTrace as Record<string, unknown>).auth_prerequisites = {
                ...(decisionTrace as Record<string, unknown>).auth_prerequisites as object,
                resolved: true,
                method: "autonomous",
              };
            } else {
              console.log(`[auth] auth prerequisite unresolved for ${dep.domain} — continuing with best effort`);
            }
          }
        }
      }
    }
    // --- end auth prerequisite gate ---

    // Try top candidates in order until one succeeds. If all fail, fall through to deferral.
    const ready = epRanked.filter((r) => canAutoExecuteEndpoint(r.endpoint));
    const tryList =
      ready.length > 0
        ? [...ready, ...epRanked.filter((r) => !canAutoExecuteEndpoint(r.endpoint))]
        : epRanked;
    const MAX_TRIES = Math.min(tryList.length, 5);
    const deterministicStructuredSearchLeader =
      /\b(search|find|lookup|browse|discover)\b/i.test(queryIntent) &&
      !!epRanked[0] &&
      endpointHasSearchBindings(epRanked[0].endpoint) &&
      (!!epRanked[0].endpoint.dom_extraction || !!epRanked[0].endpoint.response_schema);
    const agentOrder =
      !agentChoseEndpoint && tryList.length > 1 && !deterministicStructuredSearchLeader
        ? await agentSelectEndpoint(queryIntent, skill, tryList.slice(0, MAX_TRIES), context?.url)
        : null;
    const orderedTryList = agentOrder
      ? [
          ...agentOrder
            .map((endpointId) => tryList.find((r) => r.endpoint.endpoint_id === endpointId))
            .filter((r): r is RankedCandidate => !!r),
          ...tryList.filter((r) => !agentOrder.includes(r.endpoint.endpoint_id)),
        ]
      : tryList;
    const te0 = Date.now();
    for (let i = 0; i < MAX_TRIES; i++) {
      const candidate = orderedTryList[i];
      timing.candidates_tried = i + 1;
      console.log(
        `[auto-exec] trying #${i + 1}: ${candidate.endpoint.endpoint_id} score=${candidate.score.toFixed(1)}`,
      );
      try {
        const endpointParams = mergeContextTemplateParams(
          resolvedParams,
          candidate.endpoint.url_template,
          context?.url,
        );
        const templateDefaults: Record<string, string | number | boolean> = {
          ...(candidate.endpoint.path_params ?? {}),
          ...(candidate.endpoint.body_params ?? {}),
        };
        const searchOverrides = inferSearchParamOverrides(candidate.endpoint, intent, params);
        const inferredOptionalParams: Record<string, string | number | boolean> = {};
        const inferredType = inferDefaultParam("type", queryIntent);
        if (
          inferredType !== undefined &&
          endpointParams.type == null &&
          /\/(search|lookup|find)\b/i.test(candidate.endpoint.url_template)
        ) {
          inferredOptionalParams.type = inferredType;
        }
        // Sync inference for simple params (pagination, type, etc.)
        const syncInferred = Object.fromEntries(
          [...candidate.endpoint.url_template.matchAll(/\{([^}]+)\}/g)]
            .map((m) => m[1])
            .filter((name) => endpointParams[name] == null || endpointParams[name] === "")
            .map((name) => [name, inferDefaultParam(name, queryIntent)] as const)
            .filter(
              (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
            ),
        );
        // LLM inference for remaining unbound params (search queries, locations, dates, etc.)
        const allBound = {
          ...templateDefaults,
          ...endpointParams,
          ...syncInferred,
          ...searchOverrides,
          ...inferredOptionalParams,
        };
        const stillUnbound = [...candidate.endpoint.url_template.matchAll(/\{([^}]+)\}/g)]
          .map((m) => m[1])
          .filter((name) => allBound[name] == null || allBound[name] === "");
        // --- runtime DAG-recompute: walk prerequisites for unbound bindings ---
        // If a prerequisite endpoint YIELDS an unbound param, run it FIRST and thread its real
        // value — dependency-ordered execution, not an LLM guess. Only fires when the DAG knows a
        // prerequisite provides the binding; otherwise the LLM-inference path is unchanged.
        let chainBound: Record<string, string | number | boolean> = {};
        let prereqOrder = dagPlan?.prerequisite_order ?? [];
        // Lever 4 — replay: if a composite was persisted for (domain, target) from a prior satisfied
        // resolve, use its recorded step order so the chain runs in the known-good sequence even when
        // the live DAG advisory misses — skipping prerequisite re-discovery. Guard: every recorded
        // step must still exist in the skill AND be auto-executable (never silently re-run an
        // irreversible step; a stale/missing constituent falls back to the full recompute path).
        let replayedCompositeId: string | undefined;
        if (stillUnbound.length > 0) {
          const replayDomain =
            skill.domain ??
            (() => {
              try {
                return new URL(candidate.endpoint.url_template).hostname;
              } catch {
                return "";
              }
            })();
          // Lever 6 (always-on): a composite attached to the resolved skill (published by whoever
          // first walked it) wins — a foreign agent replays it with no local cache and no gate.
          // Fall back to the local-disk composite cache (gated on UNBROWSE_LOCAL_CACHES).
          const persisted =
            findCompositeInSkill(skill, candidate.endpoint.endpoint_id) ??
            // Pass the CURRENT endpoints so a constituent definition change cascade-invalidates the
            // cached composite (Merkle content-id mismatch → re-walk) instead of serving it stale.
            readComposite(replayDomain, candidate.endpoint.endpoint_id, skill.endpoints);
          const decision = planPrereqOrder(prereqOrder, persisted, (id) => {
            const ep = skill.endpoints.find((e) => e.endpoint_id === id);
            // Composite invalidation: a recorded constituent that no longer exists, was disabled
            // (route went stale/bad), or is no longer auto-executable (e.g. became an irreversible
            // op) makes the composite stale → fall back to the full recompute path, which
            // re-discovers a working order. (plan lever 4 guard: invalidate on a stale constituent)
            return ep != null && ep.verification_status !== "disabled" && canAutoExecuteEndpoint(ep);
          });
          prereqOrder = decision.prereqOrder;
          replayedCompositeId = decision.replayedCompositeId;
          if (replayedCompositeId) {
            console.log(`[chain] composite replay → ${candidate.endpoint.endpoint_id} (${replayedCompositeId})`);
          }
        }
        if (stillUnbound.length > 0 && prereqOrder.length > 0) {
          const chainSteps: Array<{ endpoint_id: string; ok: boolean; yielded: string[] }> = [];
          chainBound = await walkPrerequisiteChain(
            skill,
            stillUnbound,
            prereqOrder,
            { ...templateDefaults, ...endpointParams, ...syncInferred, ...searchOverrides },
            queryIntent,
            projection,
            { ...options, intent: queryIntent, contextUrl: context?.url },
            chainSteps,
            candidate.endpoint.endpoint_id, // the consumer (target) — for edge-disambiguated hole binding
          );
          if (chainSteps.length > 0) {
            // Emit the walked chain as a first-class COMPOSITE — the contract sub-DAG this
            // multi-step resolution satisfied: ordered prerequisite contracts (steps), the
            // binding edges threaded between them and the target, and the target endpoint.
            // This is the artifact a future lever persists + replays as one unit
            // (see internal/contract-ledger-architecture.md, levers 3–4).
            const compositeEdges = buildCompositeEdges(
              candidate.endpoint.endpoint_id,
              chainSteps,
              Object.keys(chainBound),
            );
            const compositeDomain =
              skill.domain ??
              (() => {
                try {
                  return new URL(candidate.endpoint.url_template).hostname;
                } catch {
                  return "";
                }
              })();
            const compositeIntentSig = (queryIntent ?? "").trim().toLowerCase();
            const compositeId = compositeAddress(
              compositeDomain,
              candidate.endpoint.endpoint_id,
              chainSteps,
              compositeEdges,
            );
            const composite = {
              composite_id: compositeId,
              target: candidate.endpoint.endpoint_id,
              steps: chainSteps,
              edges: compositeEdges,
              // lever 4: replay when this resolve ran a persisted composite's recorded order,
              // walk when it discovered the order live this run.
              mode: replayedCompositeId === compositeId ? "composite_replay" : "composite_walk",
            };
            (decisionTrace as Record<string, unknown>).prerequisite_chain = chainSteps;
            (decisionTrace as Record<string, unknown>).composite = composite;
            // Lever 3 — persist the composite as a content-addressed descriptor so a later resolve
            // for the same intent can replay the DAG instead of re-walking it. Guard: only when
            // every step succeeded AND the target is auto-executable — never persist a composite
            // whose target is an irreversible op (pay/book/submit), and never one with a failed step.
            if (chainSteps.every((s) => s.ok) && canAutoExecuteEndpoint(candidate.endpoint)) {
              const descriptor: PersistedComposite = {
                composite_id: compositeId,
                intent_signature: compositeIntentSig,
                domain: compositeDomain,
                target: composite.target,
                steps: chainSteps,
                edges: compositeEdges,
                created_at: new Date().toISOString(),
              };
              // Lever 6: attach to the skill so the composite travels with it — into the local
              // cache now, and into the backend route graph on the next publish (the publish
              // spreads the manifest; the backend stores it as a raw JSON blob, so it round-trips
              // with no schema change). A foreign agent then replays it always-on.
              const composedNewlyAttached = attachCompositeToSkill(skill, descriptor);
              // When a NEW composite lands on a real (backend) skill, propagate it to the graph via
              // a passive republish (fire-and-forget; in-flight-deduped + checkpoint-gated downstream,
              // so a re-walked DAG never spams publishes). This is what makes lever 6 always-on for
              // composites discovered during replay of an already-published skill.
              if (composedNewlyAttached && skill.skill_id) {
                void queuePassiveSkillPublish(skill).catch(() => {});
              }
              // Lever 3: also persist the local-disk mirror (gated on UNBROWSE_LOCAL_CACHES).
              // Stamp the Merkle content_id from the current endpoints so a later readComposite can
              // detect a constituent change and cascade-invalidate.
              const persistedPath = writeComposite(descriptor, skill.endpoints);
              if (persistedPath) {
                (decisionTrace as Record<string, unknown>).composite_persisted = compositeId;
              }
            }
            console.log(
              `[chain] composite → ${composite.target} via ` +
                composite.edges.map((e) => `${e.from}.${e.binding}`).join(" + ") || "(no edges)",
            );
          }
        }
        const chainResolvedKeys = new Set(Object.keys(chainBound));
        const llmUnbound = stillUnbound.filter((n) => !chainResolvedKeys.has(n));
        let llmInferred: Record<string, string> = {};
        if (llmUnbound.length > 0 && queryIntent) {
          llmInferred = await inferParamsFromIntent(
            candidate.endpoint.url_template,
            queryIntent,
            llmUnbound,
            candidate.endpoint.description,
          );
        }
        const execOut = await executeSkill(
          skill,
          {
            ...templateDefaults,
            ...endpointParams,
            ...syncInferred,
            ...searchOverrides,
            ...llmInferred,
            ...chainBound, // chain-resolved real values are authoritative over LLM guesses
            ...inferredOptionalParams,
            endpoint_id: candidate.endpoint.endpoint_id,
            ...(queryIntent !== intent ? { intent: queryIntent } : {}),
          },
          projection,
          { ...options, intent: queryIntent, contextUrl: context?.url },
        );
        timing.execute_ms = Date.now() - te0;
        if (execOut.trace.success) {
          const localAssessment = assessLocalExecutionResult(
            candidate.endpoint,
            execOut.result,
            queryIntent,
            execOut.trace,
          );
          if (localAssessment.verdict === "fail") {
            (decisionTrace.autoexec_attempts as unknown[]).push({
              endpoint_id: candidate.endpoint.endpoint_id,
              score: Math.round(candidate.score * 10) / 10,
              trace_success: true,
              judge: "fail",
              status_code: execOut.trace.status_code ?? null,
              local_reason: localAssessment.reason,
            });
            console.log(
              `[auto-exec] #${i + 1} local fail: ${candidate.endpoint.endpoint_id} (${localAssessment.reason})`,
            );
            continue;
          }
          const isCapturedPageArtifact = /captured page artifact/i.test(
            candidate.endpoint.description ?? "",
          );
          if (candidate.endpoint.dom_extraction && isCapturedPageArtifact && localAssessment.verdict !== "pass") {
            (decisionTrace.autoexec_attempts as unknown[]).push({
              endpoint_id: candidate.endpoint.endpoint_id,
              score: Math.round(candidate.score * 10) / 10,
              trace_success: true,
              judge: "fail",
              status_code: execOut.trace.status_code ?? null,
              local_reason: `artifact_${localAssessment.reason}`,
            });
            console.log(
              `[auto-exec] #${i + 1} local fail: ${candidate.endpoint.endpoint_id} (artifact_${localAssessment.reason})`,
            );
            continue;
          }
          // For DOM extraction endpoints, trust the local assessment more — the LLM judge
          // often fails on DOM-extracted data because the schema (heading_1, heading_2, etc.)
          // looks unfamiliar. If the extraction succeeded and wasn't locally rejected, pass it.
          const trustDomExtraction =
            candidate.endpoint.dom_extraction &&
            !isCapturedPageArtifact &&
            localAssessment.verdict !== "fail" &&
            candidate.score >= 0;
          const judged =
            localAssessment.verdict === "pass" || trustDomExtraction
              ? "pass"
              : agentJudgeExecution(intent, candidate.endpoint, execOut.result);
          (decisionTrace.autoexec_attempts as unknown[]).push({
            endpoint_id: candidate.endpoint.endpoint_id,
            score: Math.round(candidate.score * 10) / 10,
            trace_success: true,
            judge: judged,
            status_code: execOut.trace.status_code ?? null,
            local_reason: localAssessment.reason,
          });
          if (judged !== "pass") {
            console.log(
              `[auto-exec] #${i + 1} rejected: ${candidate.endpoint.endpoint_id} (${judged})`,
            );
            recordDagNegative(skill, candidate.endpoint.endpoint_id);
            continue;
          }
          cacheResolvedSkill(cacheKey, skill, candidate.endpoint.endpoint_id);
          recordDagSessionAction(skill, candidate.endpoint.endpoint_id, true);
          writeDebugTrace("resolve", {
            ...decisionTrace,
            outcome: "autoexec_success",
            source,
            skill_id: skill.skill_id,
            selected_endpoint_id: candidate.endpoint.endpoint_id,
          });
          const rejectionReasons = Object.fromEntries(
            (decisionTrace.autoexec_attempts as Array<{ endpoint_id: string; judge?: string; local_reason?: string; error?: string }>)
              .map((attempt) => [
                attempt.endpoint_id,
                attempt.endpoint_id === candidate.endpoint.endpoint_id
                  ? undefined
                  : attempt.local_reason ?? attempt.judge ?? attempt.error ?? "rejected",
              ]),
          );
          const autoexecStepIndex = recordRoutingCandidates(skill, epRanked, source, {
            selectedEndpointId: candidate.endpoint.endpoint_id,
            rejectionReasons,
          });
          recordRoutingStep(source, skill, execOut.trace, execOut.result, {
            stepIndex: autoexecStepIndex,
            selectedEndpointId: candidate.endpoint.endpoint_id,
            candidateCount: epRanked.length,
            retryCount: i,
            userOverride: false,
            requiredRecovery: i > 0,
          });
          promoteResultSnapshot(
            cacheKey,
            skill,
            candidate.endpoint.endpoint_id,
            execOut.result,
            execOut.trace,
          );
          // --- Store successful execution trace for future RAG retrieval ---
          try {
            const endpointSeq = (decisionTrace.autoexec_attempts as { endpoint_id: string }[])
              .map(a => a.endpoint_id);
            storeExecutionTrace({
              trace_id: execOut.trace.trace_id ?? nanoid(),
              domain: skill.domain,
              intent: queryIntent,
              endpoint_sequence: endpointSeq,
              selected_endpoint_id: candidate.endpoint.endpoint_id,
              params: resolvedParams,
              success: true,
              timestamp: new Date().toISOString(),
              duration_ms: timing.execute_ms,
              context_url: context?.url,
            });
          } catch {
            // Trace storage must never block the execution path
          }
          // Prefetch related endpoints via parent_child edges
          let prefetched: import("../capture/prefetch.js").PrefetchResult[] = [];
          try {
            const execGraph = ensureSkillOperationGraph(skill);
            const resolvedOp = execGraph.operations.find(op => op.endpoint_id === candidate.endpoint.endpoint_id);
            if (resolvedOp) {
              const prefetchTargets = getPrefetchTargets(execGraph, resolvedOp.operation_id, resolvedParams);
              if (prefetchTargets.length > 0) {
                console.log(`[prefetch] ${prefetchTargets.length} target(s) for ${candidate.endpoint.endpoint_id}`);
                prefetched = await executePrefetch(skill, prefetchTargets, resolvedParams);
                console.log(`[prefetch] ${prefetched.filter(r => r.success).length}/${prefetched.length} succeeded`);
              }
            }
          } catch (prefetchErr) {
            console.log(`[prefetch] error: ${(prefetchErr as Error).message}`);
          }
          // --- Payment gate: only for marketplace-sourced paid skills ---
          const dynamicPrice = source === "marketplace"
            ? (skill.base_price_usd ?? await (await import("../payments/index.js")).fetchDynamicPrice(skill.skill_id))
            : null;
          const effectivePrice = typeof dynamicPrice === "string" ? parseFloat(dynamicPrice) : (dynamicPrice ?? 0);
          if (source === "marketplace" && effectivePrice > 0) {
            try {
              const walletCheck = checkWalletConfigured();
              const wallet = getLocalWalletContext();
              const paymentResult = await checkPaymentRequirement(
                skill.skill_id,
                candidate.endpoint.endpoint_id,
                {
                  price_usd: String(effectivePrice),
                  wallet_configured: walletCheck.configured,
                },
              );
              // Show credit balance when paid via credits
              if (paymentResult.status === "paid" && paymentResult.method === "credits" && paymentResult.balance_remaining_uc !== undefined) {
                const balUsd = (paymentResult.balance_remaining_uc / 1_000_000).toFixed(4);
                console.log(`[credits] $${balUsd} remaining. ${paymentResult.message ?? ""}`);
                if (paymentResult.balance_remaining_uc < 200_000) {
                  console.log(`[credits] Running low — run \`npx lobstercash setup\` to add a wallet.`);
                }
              }

              if (paymentResult.status !== "free" && paymentResult.status !== "paid") {
                // Apply indexing fallback for unpaid users — they can still capture and contribute
                const { resolveUnpaidAccess } = await import("../payments/index.js");
                const fallback = resolveUnpaidAccess(paymentResult);
                if (fallback.status === "indexing_fallback") {
                  console.log(`[payment] ${skill.skill_id}: unpaid, falling back to indexing mode`);
                  // Allow execution but tag result as indexing-mode
                } else {
                  return {
                    result: {
                      error: "payment_required",
                      price_usd: effectivePrice,
                      payment_status: paymentResult.status,
                      message: paymentResult.message,
                      next_step: paymentResult.next_step,
                      wallet_provider: wallet.wallet_provider ?? "lobster.cash",
                      wallet_address: wallet.wallet_address,
                      indexing_fallback_available: true,
                    },
                    trace: execOut.trace,
                    source,
                    skill,
                    timing: finalize(source, null, skill.skill_id, skill, execOut.trace),
                  };
                }
              }
            } catch (payErr) {
              console.warn(`[payment] check failed, proceeding without payment gate: ${(payErr as Error).message}`);
            }
          }
          // --- end payment gate ---
          return {
            result: prefetched.length > 0 ? {
              ...(typeof execOut.result === "object" && execOut.result !== null ? execOut.result as Record<string, unknown> : { data: execOut.result }),
              prefetched: prefetched.filter(r => r.success).map(r => ({
                endpoint_id: r.endpoint_id,
                action_kind: r.action_kind,
                resource_kind: r.resource_kind,
                data: r.data,
              })),
            } : execOut.result,
            trace: execOut.trace,
            source,
            skill,
            timing: finalize(source, execOut.result, skill.skill_id, skill, execOut.trace),
          };
        }
        (decisionTrace.autoexec_attempts as unknown[]).push({
          endpoint_id: candidate.endpoint.endpoint_id,
          score: Math.round(candidate.score * 10) / 10,
          trace_success: false,
          judge: "skip",
          status_code: execOut.trace.status_code ?? null,
          error: execOut.trace.error ?? null,
        });
        console.log(`[auto-exec] #${i + 1} failed: status=${execOut.trace.status_code}`);
      } catch (err) {
        (decisionTrace.autoexec_attempts as unknown[]).push({
          endpoint_id: candidate.endpoint.endpoint_id,
          score: Math.round(candidate.score * 10) / 10,
          trace_success: false,
          judge: "skip",
          error: (err as Error).message,
        });
        console.log(`[auto-exec] #${i + 1} error: ${(err as Error).message}`);
      }
    }
    timing.execute_ms = Date.now() - te0;
    writeDebugTrace("resolve", {
      ...decisionTrace,
      outcome: "autoexec_failed_all",
      source,
      skill_id: skill.skill_id,
    });
    const rejectionReasons = Object.fromEntries(
      (decisionTrace.autoexec_attempts as Array<{ endpoint_id: string; judge?: string; local_reason?: string; error?: string }>)
        .map((attempt) => [
          attempt.endpoint_id,
          attempt.local_reason ?? attempt.judge ?? attempt.error ?? "failed",
        ]),
    );
    const failedTrace: ExecutionTrace = {
      trace_id: nanoid(),
      skill_id: skill.skill_id,
      endpoint_id: "",
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      success: false,
      error: "autoexec_failed_all",
    };
    const failedStepIndex = recordRoutingCandidates(skill, epRanked, source, {
      rejectionReasons,
    });
    recordRoutingStep(source, skill, failedTrace, null, {
      stepIndex: failedStepIndex,
      candidateCount: epRanked.length,
      retryCount: (decisionTrace.autoexec_attempts as unknown[]).length,
      userOverride: false,
      didStepUnlockNextStep: false,
      requiredRecovery: true,
    });
    // --- Store failed execution trace for future RAG retrieval ---
    try {
      const endpointSeq = (decisionTrace.autoexec_attempts as { endpoint_id: string }[])
        .map(a => a.endpoint_id);
      storeExecutionTrace({
        trace_id: nanoid(),
        domain: skill.domain,
        intent: queryIntent,
        endpoint_sequence: endpointSeq,
        params: resolvedParams,
        success: false,
        timestamp: new Date().toISOString(),
        duration_ms: timing.execute_ms,
        context_url: context?.url,
      });
    } catch {
      // Trace storage must never block the execution path
    }
    return null; // All candidates failed, fall through to deferral
  }


  // ---------------------------------------------------------------------------
  // Phase 8.1 — Per-call latency budget + parallel race.
  //
  // Fires recipe || marketplace || probe in parallel under a wall-clock budget.
  //  - recipe winner   → return successful execute result
  //  - marketplace win → return deferral with the cached skill
  //  - probe-only win  → no skill yet, return no_match with probe evidence
  //  - deadline (none) → return no_match with `next_step: unbrowse capture ...`
  //
  // Skipped when:
  //  - no contextUrl (no URL to probe / find a domain skill from)
  //  - force_capture (caller explicitly wants browser capture)
  //  - agentChoseEndpoint (caller already picked an endpoint_id)
  //
  // When skipped, the existing serial flow runs unchanged. When active, the
  // race is the resolve path — no live-capture/browser fallback fires from this
  // function. (Plan 08-02 extracts the browser-capture verb entirely.)
  // ---------------------------------------------------------------------------
  const budgetMs = Math.max(50, Math.floor(options?.budget_ms ?? 8000));
  if (context?.url && !forceCapture && !agentChoseEndpoint) {
    const raceContextUrl = context.url;

    // Pre-budget-race auth gate (Day-6 W1). When the intent contains
    // a personal pronoun, the host is in the known-auth-gated set,
    // AND the local browser cookie store has no fresh cookie for it,
    // short-circuit to auth_required BEFORE the race fires. Without
    // this, the probe-only winner triggers an Exa synthesis that
    // ships GitHub Docs (or the equivalent) masquerading as the
    // user's own data — D15 fake-green violation.
    //
    // Structural primitive: the host set lives as a const array in
    // pre-resolve-gate.ts; the check is `.includes()` against that
    // array. Audit grep `host === "<lit>"` MUST stay at zero hits.
    const preGate = decidePreResolveAuthGate(queryIntent, raceContextUrl);
    if (preGate.gate === "auth_required") {
      const gateTrace: ExecutionTrace = {
        trace_id: nanoid(),
        skill_id: "",
        endpoint_id: "",
        started_at: new Date(t0).toISOString(),
        completed_at: new Date().toISOString(),
        success: false,
        error: "auth_required",
      };
      decisionTrace.pre_resolve_auth_gate = {
        host: preGate.host,
        cookie_source: preGate.cookie_source,
        reason: preGate.reason,
      };
      console.log(`[pre-resolve-gate] short-circuit auth_required for ${preGate.host} (${preGate.reason})`);
      return {
        result: {
          status: "auth_required",
          auth: "required",
          auth_required: true,
          auth_hint: `Sign in to ${preGate.host} via a browser tab so local cookies are fresh, then retry.`,
          intent: queryIntent,
          url: raceContextUrl,
          domain: preGate.host,
          next_step: "unbrowse_auth_capture",
          suggested_commands: [
            `unbrowse auth-capture --url ${JSON.stringify(`https://${preGate.host}`)}`,
          ],
          gate_reason: preGate.reason,
          decision_trace: decisionTrace,
        },
        trace: gateTrace,
        source: "marketplace",
        skill: undefined as any,
        timing: finalize("marketplace", null, undefined, undefined, gateTrace),
      };
    }

    const localSnapshot = (() => {
      try {
        const dom = new URL(raceContextUrl).hostname;
        return findBestLocalDomainSnapshot(dom, queryIntent, raceContextUrl) ?? null;
      } catch { return null; }
    })();
    const knownSkillId = localSnapshot?.skill_id
      ?? domainSkillCache.get(getDomainReuseKey(raceContextUrl) ?? "")?.skillId
      ?? null;

    // Defense-in-depth: wrap the race in an outer deadline. If runResolveRace
    // ever fails to return (downstream bug, hung racer cleanup), this Promise
    // race guarantees the caller still gets a no_match within budget+small
    // slack instead of an indefinite hang.
    const raceOutcome = await Promise.race([
      runResolveRace({
        contextUrl: raceContextUrl,
        intent: queryIntent,
        params,
        budgetMs,
        findLocalSkill: () => localSnapshot,
        knownSkillId,
        clientScope,
      }),
      new Promise<{ winner: null; tried: []; ms: number }>((resolve) =>
        setTimeout(() => resolve({ winner: null, tried: [], ms: budgetMs + 250 }), budgetMs + 250),
      ),
    ]);
    decisionTrace.budget_race = {
      budget_ms: budgetMs,
      total_ms: raceOutcome.ms,
      tried: raceOutcome.tried.map((t) => ({
        name: t.name,
        status: t.status,
        ms: t.ms,
        ...(t.reason ? { reason: t.reason } : {}),
      })),
      winner: raceOutcome.winner ? raceOutcome.winner.kind : null,
    };

    if (raceOutcome.winner) {
      const w = raceOutcome.winner;
      if (w.kind === "recipe") {
        const recipeTrace: ExecutionTrace = {
          trace_id: w.trace_id,
          skill_id: w.skill.skill_id,
          endpoint_id: w.endpoint.endpoint_id,
          started_at: new Date(t0).toISOString(),
          completed_at: new Date().toISOString(),
          success: w.status >= 200 && w.status < 400,
          status_code: w.status,
        };
        return {
          result: {
            status: "ok",
            source: "recipe-replay",
            data: w.data,
            decision_trace: decisionTrace,
            ms: w.ms,
          },
          trace: recipeTrace,
          source: "marketplace",
          skill: w.skill,
          timing: finalize("marketplace", w.data, w.skill.skill_id, w.skill, recipeTrace),
        };
      }
      if (w.kind === "marketplace") {
        return buildDeferral(w.skill, "marketplace", { decision_trace: decisionTrace });
      }
      if (w.kind === "local-skill") {
        // Locally-cached skill — same UX as marketplace winner but instant,
        // no network roundtrip. The agent gets a ranked shortlist of
        // operations from a prior capture of this domain. This is the path
        // that turns the second-call-to-same-domain into a sub-millisecond
        // PASS instead of a budget-deadline no_match.
        return buildDeferral(w.skill, "marketplace", { decision_trace: decisionTrace });
      }
      // probe-only winner: structurally fetchable but no skill known.
      // Before returning no_match, ask Exa what the open web has on this intent.
      //
      // Two shapes share one round-trip:
      //  - exa_answer: the single richest highlight (>=150 chars) for Q&A intents.
      //  - exa_candidates: ALL exa URLs as agent-actionable seeds (each with
      //    `unbrowse_go` + `unbrowse_fetch` next_step hints). The agent picks
      //    one to capture/fetch, which then flows through the indexing
      //    pipeline → marketplace publish → next caller hits a real skill.
      //    This is the link-discovery → flywheel kickstarter.
      // Direct-fetch-over-exa (contracts c3f05a50 / 3b3e67d1 / a4bfd532 /
      // 6bb821ff; 1 Thess 5:21 — prove all things, hold fast the good):
      // when the probe's own content-type says the URL is a JSON API, the
      // URL IS the data. A direct fetch of its body always beats Exa
      // highlights ABOUT the topic. This block had REGRESSED — the budget
      // race made the fast Exa shortcut win on speed even though the slower
      // direct fetch is the correct answer for obvious APIs. The direct-fetch
      // block at the post-race serial path (~L4560) was unreachable here
      // because this Exa branch returns early. Fix the priority generically
      // (content-type signal, no per-domain heuristic), not the timing.
      if (w.kind === "probe" && probeLooksLikeDirectJsonApi(w)) {
        const directJson = await tryDirectJsonFetch(raceContextUrl);
        if (directJson) {
          const trace: ExecutionTrace = {
            trace_id: nanoid(),
            skill_id: "direct-fetch",
            endpoint_id: "direct-fetch",
            started_at: new Date(t0).toISOString(),
            completed_at: new Date().toISOString(),
            success: true,
          };
          console.log(`[direct-fetch] ${raceContextUrl} probe-winner JSON-API fast path — direct fetch over exa (ct=${directJson.content_type})`);
          return {
            result: directJson.data,
            trace,
            source: "direct-fetch" as const,
            skill: undefined as any,
            timing: finalize("direct-fetch", directJson.data, "direct-fetch", undefined as any, trace),
          };
        }
        // direct fetch failed/was non-JSON despite the JSON content-type
        // probe — fall through to Exa as the genuine fallback.
        console.log(`[direct-fetch] ${raceContextUrl} probe said JSON but direct fetch yielded no usable JSON — falling through to exa`);
      }
      // HTML direct-document fast-path — companion to the JSON fast-path above.
      // The caller gave an exact content URL (raceContextUrl) and the probe says
      // it returned a usable HTML document. The page itself is the ground truth,
      // so a direct-document fetch beats returning Exa "links about the topic".
      // This also removes the non-determinism where the same intent+url returns
      // direct-document on one call and exa candidates on the next, depending on
      // who won the budget race. Thin SPA shells are rejected inside
      // fetchDirectDocument (buildDirectDocumentResult.rejected) and fall through
      // to Exa / the serial XHR ladder exactly as before — generic, content-type
      // signal only, no per-domain heuristic.
      if (w.kind === "probe" && probeLooksLikeFetchableHtmlDocument(w)) {
        const directDoc = await fetchDirectDocument(raceContextUrl);
        if (directDoc && !directDoc.rejected) {
          const trace: ExecutionTrace = {
            trace_id: nanoid(),
            skill_id: "direct-document",
            endpoint_id: "direct-document",
            started_at: new Date(t0).toISOString(),
            completed_at: new Date().toISOString(),
            success: true,
          };
          console.log(`[direct-document] ${raceContextUrl} probe-winner HTML fast path — direct document over exa (ct=${w.content_type})`);
          return {
            result: directDoc,
            trace,
            source: "direct-document" as const,
            skill: undefined as any,
            timing: finalize("direct-document", directDoc, "direct-document", undefined as any, trace),
          };
        }
        if (directDoc?.rejected && directDoc.reason === "interstitial_detected" && /\b(auth|authenticate|authenticated|login|logged in|sign in|signin|account|session|mail|inbox|console|dashboard|api key|credentials?)\b/i.test(queryIntent)) {
          const trace: ExecutionTrace = {
            trace_id: nanoid(),
            skill_id: "direct-document",
            endpoint_id: "auth-handoff",
            started_at: new Date(t0).toISOString(),
            completed_at: new Date().toISOString(),
            success: true,
          };
          console.log(`[direct-document] ${raceContextUrl} auth-shaped interstitial — returning auth handoff before exa/browser fallback`);
          return {
            result: {
              status: "needs_input",
              url: raceContextUrl,
              rejected: true,
              extraction: { source: "direct-document", rejected: true },
              diagnostic: { reason: directDoc.reason, evidence: (directDoc as any).evidence },
            },
            trace,
            source: "direct-document" as const,
            skill: undefined as any,
            timing: finalize("direct-document", null, "direct-document", undefined as any, trace),
          };
        }
        // Probe said HTML but the document was rejected/thin (likely an SPA
        // shell) — fall through to Exa / the serial ladder as the genuine fallback.
        console.log(`[direct-document] ${raceContextUrl} probe said HTML but direct-document rejected — falling through to exa`);
      }
      const raceProbeDomain = (() => {
        try { return new URL(raceContextUrl).hostname; } catch { return undefined; }
      })();
      const exaBudgetMs = Math.max(1000, budgetMs - raceOutcome.ms);
      type ExaHit = { url: string; title?: string; score: number; highlights?: string[] };
      let exaHits: ExaHit[] = [];
      // Honest provenance: the backend's provider chain reports which engine
      // ("exa" | "ddg") actually produced the hits; thread it to the agent.
      let webProvider: string | undefined;
      try {
        const exaSearch = await Promise.race<
          | { exa_results?: ExaHit[]; web_search_provider?: string }
          | null
        >([
          (options?.exaSearchOverride ?? searchIntentResolve)(
            searchQueryIntent,
            raceProbeDomain,
            MARKETPLACE_DOMAIN_SEARCH_K,
            MARKETPLACE_GLOBAL_SEARCH_K,
          ),
          new Promise((res) => setTimeout(() => res(null), exaBudgetMs)),
        ]);
        exaHits = exaSearch?.exa_results ?? [];
        webProvider = exaSearch?.web_search_provider;
      } catch {
        // Web-search fallback is best-effort. X402 / network errors fall through.
      }
      // $0 routing (distribution mode): when the backend returned no web hits — no Exa key,
      // or the x402 toll wasn't paid — fall back to a KEYLESS DuckDuckGo search client-side so
      // grounding stays FREE (no vendor cost, no toll). This is what lets `unbrowse search/resolve`
      // (and anything grounding through them, e.g. the aiko endpoint) return real web results at
      // zero cost. Disable with UNBROWSE_DDG_FALLBACK=0 (e.g. to force the paid Exa path).
      if (exaHits.length === 0 && process.env.UNBROWSE_DDG_FALLBACK !== "0") {
        try {
          // Anchor the web query on the TARGET DOMAIN. Without this, a generic intent
          // ("find the main data/listing endpoint and return its records") web-searches the
          // bare phrase and returns the SAME generic API-design articles for every unrelated
          // site (bmo.com, a bank, and onstove.com, a game, both got medium.com/rest-api-design)
          // — fabricated, site-irrelevant coverage. Prefixing the domain makes each site's query
          // distinct and site-relevant (or empty → honest fall-through to capture).
          const webQuery = raceProbeDomain ? `${raceProbeDomain} ${queryIntent}` : queryIntent;
          const ddg = await ddgSearch(webQuery, 5, proxiedWebFetch, Math.min(6000, Math.max(1000, exaBudgetMs)));
          if (ddg.length > 0) {
            exaHits = ddg;
            webProvider = "ddg";
          }
        } catch {
          // DDG is best-effort; on any error fall through to the serial/capture path.
        }
      }
      // Quality-gate exa hits (bench-honesty fix, contract:82b55200): zero-score
      // candidates whose highlights don't contain intent tokens are useless to
      // the caller and were masking 16/26 dimensional-bench probes as fake-green.
      // CLAUDE.md action-verification rubric: response_token_hit_rate < 0.34 for
      // get_data/list_or_search intents → MANUAL_REVIEW → not a winning result.
      // When quality fails on all three signals (max_score, hit_rate, rich_highlights),
      // discard the exa hits so the resolver falls through to the post-race serial
      // path (direct-document at L4530+, XHR-prioritised live capture).
      if (exaHits.length > 0) {
        const intentTokens = (queryIntent || "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
        const stop = new Set(["get","the","for","from","with","and","any","all","new","top","top1","top10"]);
        const intentTokenSet = new Set(intentTokens.filter((t) => !stop.has(t)));
        const bestHitRate = (() => {
          if (intentTokenSet.size === 0) return 1; // can't judge, don't drop
          let best = 0;
          for (const h of exaHits) {
            const text = ((h.highlights ?? []).join(" ") + " " + (h.title ?? "") + " " + (h.url ?? "")).toLowerCase();
            const hits = [...intentTokenSet].filter((t) => text.includes(t)).length;
            const rate = hits / intentTokenSet.size;
            if (rate > best) best = rate;
          }
          return best;
        })();
        const maxScore = exaHits.reduce((m, h) => Math.max(m, h.score ?? 0), 0);
        const hasRichHit = exaHits.some((r) => (r.highlights ?? []).join(" ").length >= 150);
        // UNBROWSE_EXA_RAW=1 returns raw exa candidates and lets the CALLER judge
        // relevance instead of pre-filtering with the quality gate. The gate
        // discards low-score hits — but BrowseComp's answer entities are obscure
        // (low exa score by nature), so the gate threw away the very candidates a
        // deep-research agent needed, starving it to DDG junk (WAVE-19). When the
        // caller is a judging agent, raw recall beats a precision pre-filter.
        const exaRaw = process.env.UNBROWSE_EXA_RAW === "1";
        const exaPassesQualityGate = exaRaw || maxScore > 0 || bestHitRate >= 0.34 || hasRichHit;
        if (!exaPassesQualityGate) {
          console.log(`[exa] probe-fallback discarded — quality gate failed (max_score=${maxScore}, hit_rate=${bestHitRate.toFixed(2)}, rich=${hasRichHit}); falling through to serial path`);
          exaHits = [];
        } else if (exaRaw && !(maxScore > 0 || bestHitRate >= 0.34 || hasRichHit)) {
          console.log(`[exa] raw-candidate mode (UNBROWSE_EXA_RAW=1): keeping ${exaHits.length} low-score hits for the agent to judge`);
        }
      }
      if (exaHits.length > 0) {
        const richHit = exaHits.find((r) => (r.highlights ?? []).join(" ").length >= 150) ?? null;
        const candidates = exaHits.map((hit) => ({
          url: hit.url,
          title: hit.title,
          score: hit.score,
          highlights_excerpt: (hit.highlights ?? []).join(" ").slice(0, 240),
          next_step: {
            go: `unbrowse go --url ${JSON.stringify(hit.url)}`,
            fetch: `unbrowse fetch --url ${JSON.stringify(hit.url)}`,
          },
        }));
        console.log(`[exa] probe-fallback: ${exaHits.length} candidate(s)${richHit ? `, rich=${richHit.url}` : ""}`);
        const exaTrace: ExecutionTrace = {
          trace_id: nanoid(),
          skill_id: "exa-web-search",
          endpoint_id: richHit ? "highlights" : "candidates",
          started_at: new Date(t0).toISOString(),
          completed_at: new Date().toISOString(),
          success: true,
          status_code: 200,
        };
        const exaSkillDomain = richHit
          ? (() => { try { return new URL(richHit.url).hostname; } catch { return richHit.url; } })()
          : "exa-web-search";
        const exaSkill = {
          skill_id: "exa-web-search",
          domain: exaSkillDomain,
        } as unknown as SkillManifest;
        return {
          result: {
            ...(richHit
              ? {
                  data: richHit.highlights,
                  source_url: richHit.url,
                  source_title: richHit.title,
                  exa_answer: true,
                }
              : { exa_answer: false }),
            exa_candidates: candidates,
            ...(webProvider && { web_search_provider: webProvider }),
            probe_evidence: { status: w.status, content_type: w.content_type, byte_length: w.byte_length, ...(w.method_used ? { method_used: w.method_used } : {}) },
            // Day-6 W1: the synthesized `exa-web-search` skill is preview-only.
            // It is NOT round-trippable via `unbrowse execute --skill exa-web-search`
            // (the skill isn't persisted in the marketplace, and `execute` will
            // return "Skill not found"). The agent MUST follow next_step.fetch
            // for the actual contents, or next_step.capture_current to index
            // properly so the next caller hits a real persisted skill.
            synthetic_skill: true,
            exec_unsupported: true,
            next_step: "use unbrowse fetch for synthetic Exa results",
            next_step_detail: {
              hint: "exa-web-search is a preview-only synthesized skill, NOT round-trippable via execute. Pick a URL from exa_candidates, then `unbrowse fetch` for the raw contents, or `unbrowse go` to capture+index so the next caller hits a real persisted skill.",
              capture_current: `unbrowse capture --url ${JSON.stringify(raceContextUrl)} --intent ${JSON.stringify(intent)}`,
            },
            suggested_commands: candidates.slice(0, 3).map((c) => `unbrowse fetch --url ${JSON.stringify(c.url)}`),
            decision_trace: decisionTrace,
          },
          trace: exaTrace,
          source: "exa" as const,
          skill: exaSkill,
          timing: finalize("exa", null, "exa-web-search", undefined, exaTrace),
        };
      }
      // Exa had nothing either. Previously fell to direct-document here, but
      // that bypassed the XHR-shaped layers below (route-result-cache,
      // route-cache, domain-cache, marketplace searchIntentResolve,
      // captured-domain-cache, live-capture). Per Lewis's "prioritise XHR
      // over direct-document" instruction, fall through to the post-race
      // serial path. direct-document still fires there at the L4530 site,
      // but only AFTER the XHR layers have had their turn.
      // Falls through to L3891+ below.
    }
    // Race produced no XHR winner (probe-only or deadline-no-winner). Fall
    // through to the serial post-race path so the full XHR cache /
    // marketplace / live-capture ladder runs before direct-document is
    // considered as the page-content fallback.
  }
  const requestedDomain = context?.domain ?? (context?.url ? new URL(context.url).hostname : null);
  const requestedDomainCacheKey = getDomainReuseKey(context?.url ?? requestedDomain);
  const resolveCacheKey = buildResolveCacheKey(requestedDomain, intent, context?.url);
  const cacheKey = scopedCacheKey(clientScope, resolveCacheKey);

  if (!forceCapture && !agentChoseEndpoint) {
    const cachedResult = routeResultCache.get(cacheKey);
    if (cachedResult) {
      if (!shouldReuseRouteResultSnapshot(cachedResult, queryIntent, context?.url)) {
        routeResultCache.delete(cacheKey);
      } else {
        timing.cache_hit = true;
        writeDebugTrace("resolve", {
          ...decisionTrace,
          outcome: "route_result_cache_hit",
          source: "route-cache",
          skill_id: cachedResult.skill.skill_id,
          selected_endpoint_id: cachedResult.endpointId ?? cachedResult.trace.endpoint_id,
        });
        const routeCacheStepIndex = recordRoutingCandidates(
          cachedResult.skill,
          [{
            endpoint: cachedResult.skill.endpoints.find(
              (endpoint) => endpoint.endpoint_id === (cachedResult.endpointId ?? cachedResult.trace.endpoint_id),
            ) ?? cachedResult.skill.endpoints[0],
            score: 1,
          }],
          "route-cache",
          { selectedEndpointId: cachedResult.endpointId ?? cachedResult.trace.endpoint_id },
        );
        recordRoutingStep("route-cache", cachedResult.skill, cachedResult.trace, cachedResult.result, {
          stepIndex: routeCacheStepIndex,
          selectedEndpointId: cachedResult.endpointId ?? cachedResult.trace.endpoint_id,
          candidateCount: 1,
          userOverride: false,
          requiredRecovery: false,
        });
        return buildCachedResultResponse(
          cachedResult,
          "marketplace",
          finalize(
            "route-cache",
            cachedResult.result,
            cachedResult.skill.skill_id,
            cachedResult.skill,
            cachedResult.trace,
          ),
        );
      }
    }
  }

  // Route-cache fast path: exact intent+url match from prior resolve
  if (!forceCapture && !agentChoseEndpoint) {
    const routeCacheCandidates: RouteCacheCandidate[] = [];
    for (const scopedKey of scopedResolveCacheKeys(clientScope, resolveCacheKey)) {
      const cached = skillRouteCache.get(scopedKey);
      if (!cached) continue;
      if (Date.now() - cached.ts >= ROUTE_CACHE_TTL) {
        skillRouteCache.delete(scopedKey);
        persistRouteCache();
        continue;
      }
      const skill =
        readSkillSnapshot(cached.localSkillPath) ??
        await getSkillWithTimeout(cached.skillId, clientScope);
      if (!skill || !isCachedSkillRelevantForIntent(skill, queryIntent, context?.url)) {
        skillRouteCache.delete(scopedKey);
        persistRouteCache();
        continue;
      }
      routeCacheCandidates.push({
        scopedKey,
        scope: scopedKey.slice(0, scopedKey.indexOf(":")),
        entry: cached,
        skill,
      });
    }
    const bestCached = chooseBestRouteCacheCandidate(routeCacheCandidates, queryIntent, context?.url);
    if (bestCached) {
      if (bestCached.scopedKey !== cacheKey) {
        promoteLearnedSkill(
          clientScope,
          resolveCacheKey,
          bestCached.skill,
          bestCached.entry.endpointId,
          context?.url,
        );
      }
      const deferred = await buildDeferralWithAutoExec(bestCached.skill, "marketplace");
      if (shouldFallbackToLiveCaptureAfterAutoexecFailure(deferred.autoexecFailedAll, context?.url)) {
        console.log("[route-cache] stale cached skill; retrying via live capture");
        invalidateResolveCacheEntries(
          [cacheKey, bestCached.scopedKey],
          requestedDomainCacheKey ? [requestedDomainCacheKey] : [],
        );
      } else {
        timing.cache_hit = true;
        deferred.orchestratorResult.timing.cache_hit = true;
        return deferred.orchestratorResult;
      }
    }
  }

  // Domain-level cache: different intent, same domain → reuse skill with new params
  if (!forceCapture && !agentChoseEndpoint && requestedDomain) {
    const domainKey = getDomainReuseKey(context?.url ?? requestedDomain);
    let domainCached = domainKey ? domainSkillCache.get(domainKey) : null;
    // Brand-equivalent fallback: airbnb.com → airbnb.com.sg (geo-redirect)
    if (!domainCached && domainKey) {
      for (const [k, v] of domainSkillCache) {
        if (isSameBrandDomain(k, domainKey)) {
          domainCached = v;
          break;
        }
      }
    }
    if (domainCached && Date.now() - domainCached.ts < 7 * 24 * 60 * 60_000) {
      const skill = readSkillSnapshot(domainCached.localSkillPath) ?? await getSkill(domainCached.skillId, clientScope);
      // Fresh local captures (< 60s) skip strict relevance check — they're the freshest
      // data we have and shouldn't lose to stale marketplace results. The enrichment
      // pipeline hasn't run yet so response_schema/descriptions may be missing.
      const isFreshLocalCapture = skill && (Date.now() - domainCached.ts < 1_800_000); // 30min — trust recent local captures

      // === Staleness check (A2+E1 fix) ===
      // Skip low-scoring skills that are older than 3 days — they likely need re-capture.
      const skillAgeHours = (Date.now() - domainCached.ts) / (1000 * 60 * 60);
      const skillScore = (skill as { score?: number } | undefined)?.score;
      const isStaleLowScore = skillAgeHours > 72 && (skillScore === undefined || skillScore < 40);
      if (isStaleLowScore) {
        console.log(
          `[domain-cache] skipping stale low-score skill ${skill?.skill_id.slice(0, 15)} (score=${skillScore}, age=${Math.round(skillAgeHours)}h)`,
        );
        domainSkillCache.delete(domainKey);
      } else if (skill && (isFreshLocalCapture || isCachedSkillRelevantForIntent(skill, queryIntent, context?.url))) {
        console.log(`[domain-cache] hit for ${domainKey} → skill ${skill.skill_id.slice(0, 15)} (fresh=${isFreshLocalCapture})`);
        const result = await buildDeferralWithAutoExec(skill, "marketplace");
        // Fresh local captures: don't fall back to live capture on auto-exec failure.
        // The skill is local and recent — just return the endpoints for the agent to pick.
        if (!isFreshLocalCapture && shouldFallbackToLiveCaptureAfterAutoexecFailure(result.autoexecFailedAll, context?.url)) {
          console.log(`[domain-cache] stale skill for ${domainKey}; retrying via live capture`);
          invalidateResolveCacheEntries([cacheKey], [domainKey]);
        } else {
          timing.cache_hit = true;
          result.orchestratorResult.timing.cache_hit = true;
          return result.orchestratorResult;
        }
      } else if (skill) {
        const ranked = rankEndpoints(skill.endpoints, queryIntent, skill.domain, context?.url, params);
        const top = ranked[0];
        console.log(
          `[domain-cache] skip strict check for ${domainKey}, attempting fallback: no strictly relevant endpoint for "${queryIntent}"` +
            (top ? ` (${top.endpoint.endpoint_id} score=${top.score.toFixed(1)})` : ""),
        );
        // Fallback: domain-skill-cache was explicitly populated for this domain.
        // Even if the strict relevance check fails (e.g. ccTLD endpoint mismatch or
        // unmatched search binding params), attempt to use the skill before falling
        // through to live capture. buildDeferralWithAutoExec will filter endpoints
        // by isResolveUsableEndpointForIntent so only viable endpoints are returned.
        if (skill.endpoints.some((ep) => isResolveUsableEndpointForIntent(ep, queryIntent, context?.url))) {
          const fallbackResult = await buildDeferralWithAutoExec(skill, "marketplace");
          if (shouldFallbackToLiveCaptureAfterAutoexecFailure(fallbackResult.autoexecFailedAll, context?.url)) {
            console.log(`[domain-cache] fallback stale for ${domainKey}; retrying via live capture`);
            invalidateResolveCacheEntries([cacheKey], [domainKey]);
          } else {
            timing.cache_hit = true;
            fallbackResult.orchestratorResult.timing.cache_hit = true;
            return fallbackResult.orchestratorResult;
          }
        }
      }
    }

    const localDomainSkill = findBestLocalDomainSnapshot(requestedDomain, queryIntent, context?.url);
    if (localDomainSkill) {
      console.log(`[local-snapshot] hit for ${requestedDomain} → skill ${localDomainSkill.skill_id.slice(0, 15)}`);
      const result = await buildDeferralWithAutoExec(localDomainSkill, "marketplace");
      if (shouldFallbackToLiveCaptureAfterAutoexecFailure(result.autoexecFailedAll, context?.url)) {
        console.log(`[local-snapshot] stale skill for ${requestedDomain}; retrying via live capture`);
      } else {
        timing.cache_hit = true;
        result.orchestratorResult.timing.cache_hit = true;
        promoteLearnedSkill(clientScope, cacheKey, localDomainSkill, result.orchestratorResult.trace.endpoint_id, context?.url);
        return result.orchestratorResult;
      }
    }
  }

  // --- Agent explicitly chose an endpoint — execute directly via any cache/skill path ---
  if (!forceCapture && agentChoseEndpoint) {
    // Route cache
    const routeCacheCandidates: RouteCacheCandidate[] = [];
    for (const scopedKey of scopedResolveCacheKeys(clientScope, resolveCacheKey)) {
      const cached = skillRouteCache.get(scopedKey);
      if (!cached) continue;
      if (Date.now() - cached.ts >= ROUTE_CACHE_TTL) {
        skillRouteCache.delete(scopedKey);
        persistRouteCache();
        continue;
      }
      const skill =
        readSkillSnapshot(cached.localSkillPath) ??
        await getSkillWithTimeout(cached.skillId, clientScope);
      if (!skill) continue;
      routeCacheCandidates.push({
        scopedKey,
        scope: scopedKey.slice(0, scopedKey.indexOf(":")),
        entry: cached,
        skill,
      });
    }
    const cached = chooseBestRouteCacheCandidate(routeCacheCandidates, queryIntent, context?.url);
    if (cached) {
      if (cached.scopedKey !== cacheKey) {
        promoteLearnedSkill(
          clientScope,
          resolveCacheKey,
          cached.skill,
          cached.entry.endpointId,
          context?.url,
        );
      }
      const skill = cached.skill;
      if (skill) {
        const selectedEndpoint = skill.endpoints.find(
          (endpoint) => endpoint.endpoint_id === (params.endpoint_id ?? cached.entry.endpointId),
        );
        if (selectedEndpoint && !isResolveUsableEndpointForIntent(selectedEndpoint, queryIntent, context?.url)) {
          skillRouteCache.delete(cached.scopedKey);
          persistRouteCache();
        } else {
        const te0 = Date.now();
        try {
          const execOut = await executeSkill(
            skill,
            { ...params, endpoint_id: params.endpoint_id ?? cached.entry.endpointId, ...(queryIntent !== intent ? { intent: queryIntent } : {}) },
            projection,
            { ...options, intent: queryIntent, contextUrl: context?.url },
          );
          timing.execute_ms = Date.now() - te0;
          if (execOut.trace.success && isAcceptableIntentResult(execOut.result, queryIntent)) {
              timing.cache_hit = true;
            const routeCacheExecStep = recordRoutingCandidates(
              skill,
              [{
                endpoint: skill.endpoints.find(
                  (endpoint) => endpoint.endpoint_id === (params.endpoint_id ?? cached.entry.endpointId ?? execOut.trace.endpoint_id),
                ) ?? skill.endpoints[0],
                score: 1,
              }],
              "route-cache",
              {
                selectedEndpointId: params.endpoint_id ?? cached.entry.endpointId ?? execOut.trace.endpoint_id,
              },
            );
            recordRoutingStep("route-cache", skill, execOut.trace, execOut.result, {
              stepIndex: routeCacheExecStep,
              selectedEndpointId: params.endpoint_id ?? cached.entry.endpointId ?? execOut.trace.endpoint_id,
              candidateCount: 1,
              userOverride: !!params.endpoint_id,
              requiredRecovery: false,
            });
            promoteResultSnapshot(
              cacheKey,
              skill,
              params.endpoint_id ?? cached.entry.endpointId,
              execOut.result,
              execOut.trace,
            );
            return {
              result: execOut.result,
              trace: execOut.trace,
              source: "marketplace",
              skill,
              timing: finalize("route-cache", execOut.result, cached.entry.skillId, skill, execOut.trace),
            };
          }
        } catch {
          timing.execute_ms = Date.now() - te0;
        }
        }
      }
      skillRouteCache.delete(cached.scopedKey);
    }
  }

  if (!forceCapture && !agentChoseEndpoint && requestedDomain) {
    const localSnapshot = findBestLocalDomainSnapshot(requestedDomain, queryIntent, context?.url);
    if (localSnapshot) {
      console.log(`[local-snapshot:default] hit for ${requestedDomain} → skill ${localSnapshot.skill_id.slice(0, 15)}`);
      const deferred = await buildDeferralWithAutoExec(localSnapshot, "marketplace");
      if (shouldFallbackToLiveCaptureAfterAutoexecFailure(deferred.autoexecFailedAll, context?.url)) {
        console.log(`[local-snapshot:default] stale skill for ${requestedDomain}; retrying via live capture`);
      } else {
        timing.cache_hit = true;
        deferred.orchestratorResult.timing.cache_hit = true;
        promoteLearnedSkill(
          clientScope,
          cacheKey,
          localSnapshot,
          deferred.orchestratorResult.trace.endpoint_id,
          context?.url,
        );
        return deferred.orchestratorResult;
      }
    }
  }

  const shouldBypassBrowserFirstPass = shouldBypassLiveCaptureQueue(context?.url);


  // --- Marketplace search with hard timeout ---
  // When a URL is available, the direct-fetch / direct-document / capture fast-paths are the PRIMARY
  // strategy and the marketplace is a secondary lookup — so cap it tight (800ms). Measured: the
  // remote backend /skills/search dominates cold-resolve latency (~7s when capped at 2500ms; the
  // endpoint itself takes ~2.7s and usually 404s for a specific site URL the marketplace doesn't
  // hold). 800ms still catches a fast (cached) backend hit; a slower one falls to the fast-paths
  // that cover URL-present resolves anyway. Tune with UNBROWSE_RESOLVE_SEARCH_TIMEOUT_MS (a bench that
  // wants the full backend search can raise it). No-URL intents keep the wider 10s (no fast-path).
  const MARKETPLACE_TIMEOUT_MS = Number(
    process.env.UNBROWSE_RESOLVE_SEARCH_TIMEOUT_MS ?? (context?.url ? "800" : "10000"),
  );

  if (!forceCapture && !options?.local_skills_only) {
    // 1. Search marketplace — single remote call, capped by timeout when URL available
    const ts0 = Date.now();
    type SearchResult = { id: number; score: number; metadata: Record<string, unknown> };
    let searchResponse: {
      domain_results: SearchResult[];
      global_results: SearchResult[];
      skipped_global: boolean;
      actual_cost_uc?: number;
    };
    try {
      searchResponse = await Promise.race([
        searchIntentResolve(
          searchQueryIntent,
          requestedDomain ?? undefined,
          MARKETPLACE_DOMAIN_SEARCH_K,
          MARKETPLACE_GLOBAL_SEARCH_K,
        ),
        new Promise<{ domain_results: SearchResult[]; global_results: SearchResult[]; skipped_global: boolean; actual_cost_uc?: number }>((resolve) =>
          setTimeout(() => {
            console.log(`[marketplace] timeout after ${MARKETPLACE_TIMEOUT_MS}ms — returning cache miss`);
            resolve({ domain_results: [], global_results: [], skipped_global: true });
          }, MARKETPLACE_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      if (isX402Error(err)) {
        const localCanonicalSkill =
          context?.url && !isSearchLikeIntent(queryIntent, context.url)
            ? buildLocalCanonicalReplaySkill(queryIntent, context.url)
            : undefined;
        if (localCanonicalSkill) {
          const deferred = await buildDeferralWithAutoExec(localCanonicalSkill, "marketplace", {
            local_canonical_replay: true,
            payment_bypass: "canonical-detail-page",
          });
          return deferred.orchestratorResult;
        }
        const trace: ExecutionTrace = {
          trace_id: nanoid(),
          skill_id: "marketplace-search",
          endpoint_id: "search",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: false,
          status_code: 402,
          error: "payment_required",
        };
        return {
          result: {
            error: "payment_required",
            payment_status: "payment_required",
            wallet_provider: getLocalWalletContext().wallet_provider ?? "lobster.cash",
            wallet_address: getLocalWalletContext().wallet_address,
            message: "Marketplace search requires payment before shared graph results are returned.",
            next_step: "Pay the Tier 3 search fee, or re-run with force capture for free local discovery.",
            indexing_fallback_available: true,
            tier: "tier3",
            terms: err.terms,
          },
          trace,
          source: "marketplace",
          skill: undefined as any,
          timing: finalize("marketplace", null, undefined, undefined, trace),
        };
      }
      searchResponse = {
        domain_results: [] as SearchResult[],
        global_results: [] as SearchResult[],
        skipped_global: false,
      };
    }
    if (typeof searchResponse.actual_cost_uc === "number" && searchResponse.actual_cost_uc > 0) {
      timing.paid_search_uc = searchResponse.actual_cost_uc;
    }
    const { domain_results: domainResults, global_results: globalResults, exa_results: exaResultsRaw, web_search_provider: serialWebProviderRaw } = searchResponse as typeof searchResponse & { exa_results?: Array<{ url: string; title?: string; score: number; highlights?: string[] }>; web_search_provider?: string };
    // $0 routing: exaResults/serialWebProvider are mutable so the keyless DDG fallback below
    // can supply free web hits when the backend returned none (no Exa key / no x402 toll paid).
    let exaResults = exaResultsRaw;
    let serialWebProvider = serialWebProviderRaw;
    timing.search_ms = Date.now() - ts0;
    console.log(`[marketplace] search: ${domainResults.length} domain + ${globalResults.length} global results (${timing.search_ms}ms)`);

    // Merge: domain results first (higher precision), then global (broader recall)
    // Dedup by skill_id+endpoint_id — search now returns per-endpoint vectors
    const seen = new Set<string>();
    const candidates: typeof domainResults = [];
    for (const c of [...domainResults, ...globalResults]) {
      const sid = extractSkillId(c.metadata);
      const eid = extractEndpointId(c.metadata);
      const key = eid ? `${sid}:${eid}` : sid;
      if (sid && key && !seen.has(key)) {
        seen.add(key);
        candidates.push(c);
      }
    }

    // Fetch all unique skills in parallel — don't waste time on serial 404s
    type RankedCandidate = {
      candidate: (typeof candidates)[0];
      skill: SkillManifest;
      composite: number;
      endpointId?: string;
    };
    const tg0 = Date.now();
    const uniqueSkillIds = selectSkillIdsToHydrate(candidates, requestedDomain, MARKETPLACE_HYDRATE_LIMIT);
    const skillMap = new Map<string, SkillManifest>();
    await Promise.all(
      uniqueSkillIds.map(async (skillId) => {
        const skill = await getSkillWithTimeout(skillId, clientScope);
        if (skill) skillMap.set(skillId, skill);
      }),
    );
    timing.get_skill_ms = Date.now() - tg0;
    timing.candidates_found = skillMap.size;

    const ranked: RankedCandidate[] = [];
    // When a target domain is specified, only accept skills from that domain.
    const targetRegDomain = requestedDomain ? getRegistrableDomain(requestedDomain) : null;
    for (const c of candidates) {
      const skillId = extractSkillId(c.metadata)!;
      const skill = skillMap.get(skillId);
      if (!skill) continue;
      if (skill.lifecycle !== "active") continue;
      if (!hasUsableEndpoints(skill)) continue;
      if (!isCachedSkillRelevantForIntent(skill, queryIntent, context?.url)) continue;
      if (!marketplaceSkillMatchesContext(skill, queryIntent, context?.url)) continue;
      if (targetRegDomain && getRegistrableDomain(skill.domain) !== targetRegDomain) continue;
      let endpointId = extractEndpointId(c.metadata) ?? undefined;
      // Validate vecdb endpoint still exists on the skill — stale vectors may reference old IDs
      if (endpointId && !skill.endpoints.some((ep) => ep.endpoint_id === endpointId)) {
        // Try URL-based recovery: vecdb metadata often has the URL template
        const vecUrl = c.metadata?.url_template as string | undefined;
        const urlMatch = vecUrl ? skill.endpoints.find((ep) => ep.url_template === vecUrl) : undefined;
        if (urlMatch) {
          console.log(`[marketplace] vecdb endpoint ${endpointId} stale → recovered via URL match: ${urlMatch.endpoint_id}`);
          endpointId = urlMatch.endpoint_id;
        } else {
          console.log(`[marketplace] vecdb endpoint ${endpointId} not found on skill ${skillId} — dropping to skill-level match`);
          endpointId = undefined;
        }
      }
      ranked.push({
        candidate: c,
        skill,
        composite: computeCompositeScore(c.score, skill),
        endpointId,
      });
    }
    ranked.sort((a, b) => b.composite - a.composite);

    // If marketplace found viable skills, defer to the agent unless they already chose an endpoint.
    const viable = ranked.filter((c) => c.composite >= CONFIDENCE_THRESHOLD).slice(0, 3);
    timing.candidates_tried = viable.length;
    console.log(`[marketplace] viable=${viable.length}/${ranked.length} candidates (threshold=${CONFIDENCE_THRESHOLD}), top=${viable[0]?.composite?.toFixed(1) ?? "n/a"} skill=${viable[0]?.skill?.skill_id?.slice(0,10) ?? "n/a"}`);
    if (viable.length > 0) {
      if (agentChoseEndpoint) {
        // Agent already picked an endpoint — race top candidates to execute it
        const te0 = Date.now();
        try {
          const winner = await Promise.any(
            viable.map((candidate, i) =>
              Promise.race([
                executeSkill(candidate.skill, params, projection, {
                  ...options,
                  intent: queryIntent,
                  contextUrl: context?.url,
                })
                  .then((execOut) => {
                    if (!execOut.trace.success) {
                      console.log(
                        `[race] candidate ${i} (${candidate.skill.skill_id}) failed: status=${execOut.trace.status_code}`,
                      );
                      throw new Error("execution failed");
                    }
                    return { ...execOut, candidate };
                  })
                  .catch((err) => {
                    console.log(
                      `[race] candidate ${i} (${candidate.skill.skill_id}) error: ${(err as Error).message}`,
                    );
                    throw err;
                  }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("timeout")), 30_000),
                ),
              ]),
            ),
          );
          timing.execute_ms = Date.now() - te0;
          cacheResolvedSkill(
            cacheKey,
            winner.candidate.skill,
            winner.trace.endpoint_id,
          );
          const raceStepIndex = recordRoutingCandidates(
            winner.candidate.skill,
            viable.map((entry) => ({
              endpoint:
                entry.skill.endpoints.find(
                  (endpoint) => endpoint.endpoint_id === (entry.endpointId ?? params.endpoint_id ?? winner.trace.endpoint_id),
                ) ?? entry.skill.endpoints[0],
              score: entry.composite,
            })),
            "marketplace",
            { selectedEndpointId: winner.trace.endpoint_id },
          );
          recordRoutingStep("marketplace", winner.candidate.skill, winner.trace, winner.result, {
            stepIndex: raceStepIndex,
            selectedEndpointId: winner.trace.endpoint_id,
            candidateCount: viable.length,
            userOverride: true,
            requiredRecovery: false,
          });
          promoteResultSnapshot(
            cacheKey,
            winner.candidate.skill,
            winner.trace.endpoint_id,
            winner.result,
            winner.trace,
          );
          return {
            result: winner.result,
            trace: winner.trace,
            source: "marketplace" as const,
            skill: winner.candidate.skill,
            timing: finalize(
              "marketplace",
              winner.result,
              winner.candidate.skill.skill_id,
              winner.candidate.skill,
              winner.trace,
            ),
          };
        } catch (err) {
          console.log(
            `[race] all candidates failed after ${Date.now() - te0}ms: ${(err as Error).message}`,
          );
          timing.execute_ms = Date.now() - te0;
        }
      } else {
        const best = viable[0];
        // Endpoint-level search hits are only hints. Resolve returns them; execute happens only
        // after the agent explicitly chooses an endpoint.
        if (best.endpointId) {
          console.log(
            `[search] endpoint-level hit hint: ${best.endpointId} score=${best.candidate.score.toFixed(3)}`,
          );
        }
        const deferred = await buildDeferralWithAutoExec(best.skill, "marketplace");
        if (!shouldFallbackToLiveCaptureAfterAutoexecFailure(deferred.autoexecFailedAll, context?.url)) {
          return deferred.orchestratorResult;
        }
        console.log("[marketplace] stale top skill; retrying via live capture");
      }
    }

    // 1.4 Direct JSON fetch — try the caller's URL directly BEFORE the Exa
    // highlights shortcut below. The URL the caller gave IS the ground truth:
    // if it returns JSON (or a usable HTML document) that always beats web-
    // search highlights ABOUT the topic. This block used to run AFTER the Exa
    // early-return, so plain JSON APIs (open.er-api.com, api.open-meteo.com,
    // *.geojson feeds) were answered with Exa highlights and never had their
    // real response fetched. Content-type is checked on the response; no URL
    // pattern heuristic gates it.
    if (context?.url) {
      const ctxUrl = context.url;
      // Shared curl-impersonate rescue for the direct-fetch path. bun's native
      // fetch can stall (TLS/HTTP hang — usgs.gov) OR be hard-refused with a
      // bot-block status (reddit .json returns 403 to native fetch even with a
      // Chrome UA, but 200 to curl-impersonate's full JA4 spoof). In both cases
      // curl-impersonate (direct, no proxy) recovers the data; without it the
      // PRIMARY run/resolve path fell through to the slow browser ladder and
      // timed out with cli_timeout. Returns a JSON (direct-fetch) or document
      // (direct-document) result, or null to fall through unchanged.
      const curlRescueDirect = async (): Promise<OrchestratorResult | null> => {
        try {
          // Seed the local browser-profile cookies for this host so cookie-gated
          // sites (reddit, logged-in pages) return their real content instead of a
          // block page — the same reason the `fetch` command seeds cookies.
          let rescueCookies: Array<{ name: string; value: string }> = [];
          try {
            const host = new URL(ctxUrl).hostname;
            const { extractBrowserCookies } = await import("../auth/browser-cookies.js");
            rescueCookies = extractBrowserCookies(host).cookies.map((c) => ({ name: c.name, value: c.value }));
          } catch { /* no cookies available — proceed cookieless */ }
          // Ladder: impersonate-DIRECT first (no proxy tax on healthy hosts),
          // then escalate to impersonate-via-PROXY on failure. forceDirect:true
          // alone left IP-throttled hosts (gnu.org) timing out — the rescue
          // impersonated the fingerprint but never changed egress IP, so the
          // throttle still bit. Direct-first-then-proxy recovers them without
          // taxing the rest (resolveEgressProxy reads ~/.identity/iproyal-creds).
          let cffi = await tryCurlImpersonateFetch({ url: ctxUrl, timeoutMs: 12_000, forceDirect: true, cookies: rescueCookies });
          // Escalate to the residential proxy ONLY when real iproyal creds are
          // configured (pass the explicit URL, not the x402-gated default) so a
          // user without creds never eats a long hang on an unreachable proxy.
          const rescueProxy = resolveProxyUrl();
          if (rescueProxy && (!cffi || !cffi.html || cffi.status < 200 || cffi.status >= 400)) {
            const viaProxy = await tryCurlImpersonateFetch({ url: ctxUrl, timeoutMs: 45_000, proxy: rescueProxy, cookies: rescueCookies });
            if (viaProxy?.html && viaProxy.status >= 200 && viaProxy.status < 400) cffi = viaProxy;
          }
          if (cffi?.html && cffi.status >= 200 && cffi.status < 400) {
            const trimmed = cffi.html.trimStart();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
              try {
                const parsed = JSON.parse(cffi.html);
                if (parsed !== null && typeof parsed === "object") {
                  const trace: ExecutionTrace = {
                    trace_id: nanoid(), skill_id: "direct-fetch", endpoint_id: "direct-fetch",
                    started_at: new Date().toISOString(), completed_at: new Date().toISOString(), success: true,
                  };
                  console.log(`[direct-fetch] ${ctxUrl} curl-impersonate rescue (native fetch blocked/stalled): ${cffi.bytes}B`);
                  return { result: parsed, trace, source: "direct-fetch" as any, skill: undefined as any, timing: finalize("direct-fetch", parsed, "direct-fetch", undefined as any, trace) };
                }
              } catch { /* not JSON — try document below */ }
            }
            const rescuedDoc = buildBloombergDirectDocumentResult(ctxUrl, cffi.html, "text/html", intent);
            if (!rescuedDoc.rejected) {
              const trace: ExecutionTrace = {
                trace_id: nanoid(), skill_id: "direct-document", endpoint_id: "direct-document",
                started_at: new Date().toISOString(), completed_at: new Date().toISOString(), success: true,
              };
              console.log(`[direct-document] ${ctxUrl} curl-impersonate rescue (native fetch blocked/stalled): ${cffi.bytes}B`);
              return { result: rescuedDoc, trace, source: "direct-document" as any, skill: undefined as any, timing: finalize("direct-document", rescuedDoc, "direct-document", undefined as any, trace) };
            }
          }
        } catch (rescueErr) {
          console.log(`[direct-fetch] curl-impersonate rescue failed: ${rescueErr instanceof Error ? rescueErr.message : String(rescueErr)}`);
        }
        return null;
      };
      try {
        const directRes = await fetch(context.url, {
          headers: { "Accept": "application/json, text/html;q=0.5", "User-Agent": "unbrowse/1.0" },
          signal: AbortSignal.timeout(15000),  // 15s — slow APIs like NASA cold-start need headroom
          redirect: "follow",
        });
        const ct = directRes.headers.get("content-type") ?? "";
        const ctSaysJson = ct.includes("application/json") || ct.includes("+json") || ct.includes("text/json");
        if (directRes.ok) {
          let data: unknown = undefined;
          if (ctSaysJson) {
            data = await directRes.json();
          } else {
            // Body-sniff fallback: some APIs (adviceslip, numbersapi, etc.) return
            // valid JSON with text/html or text/plain content-type headers. Read
            // the body and try to parse — if it parses AND looks like structured
            // data (object or array), treat as a direct JSON endpoint anyway.
            // Cap at 2MB to avoid pulling a real HTML page into memory.
            const bodyText = await directRes.text();
            if (bodyText.length < 2_000_000) {
              const trimmed = bodyText.trimStart();
              if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try {
                  const parsed = JSON.parse(bodyText);
                  if (parsed !== null && typeof parsed === "object") {
                    data = parsed;
                    console.log(`[direct-fetch] ${context.url} body-sniff hit: ct="${ct}" but body parses as JSON`);
                  }
                } catch {
                  // Not JSON, fall through to browser capture
                }
              }
            }
            const directDocument = buildBloombergDirectDocumentResult(context.url, bodyText, ct, intent);
            if (!directDocument.rejected) {
              const trace: ExecutionTrace = {
                trace_id: nanoid(),
                skill_id: "direct-document",
                endpoint_id: "direct-document",
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                success: true,
              };
              const t = finalize("direct-document", directDocument, "direct-document", undefined as any, trace);
              console.log(`[direct-document] ${context.url} returned HTML directly — skipping browser`);
              return {
                result: directDocument,
                trace,
                source: "direct-document",
                skill: undefined as any,
                timing: t,
              };
            } else {
              // Surface rejection in logs so bench-local diagnostic fields can be
              // read at .bench-local/*.out and the agent can judge in-thread
              // whether the fallthrough to the browser ladder was warranted.
              // Generic: covers all rejection reasons (intent_mismatch /
              // interstitial_detected / challenge_html / too_small / not_html).
              const evidenceJson = (directDocument as any).evidence ? ` evidence=${JSON.stringify((directDocument as any).evidence)}` : "";
              console.log(`[direct-document] ${context.url} REJECTED reason=${directDocument.reason}${evidenceJson}; handing off to browser ladder`);
              // UX shortcut: when direct-document already detected the interstitial
              // (CF / Akamai / sign-in wall), skip the 30s+ browser ladder and try
              // curl_cffi via residential proxy IMMEDIATELY. Same primitive the
              // no_progress_bail rescue uses, just lifted earlier so the agent
              // doesn't wait for the browser to time out. Saves 25-30s wall-clock
              // per CF-blocked probe when curl_cffi is the answer (TLS-fingerprint
              // class). When curl_cffi also fails (JS-challenge class), the
              // existing browser ladder still runs as the final fallback.
              if (directDocument.reason === "interstitial_detected" && /\b(auth|authenticate|authenticated|login|logged in|sign in|signin|account|session|mail|inbox|console|dashboard|api key|credentials?)\b/i.test(queryIntent)) {
                const trace: ExecutionTrace = {
                  trace_id: nanoid(),
                  skill_id: "direct-document",
                  endpoint_id: "auth-handoff",
                  started_at: new Date().toISOString(),
                  completed_at: new Date().toISOString(),
                  success: true,
                };
                const result = {
                  status: "needs_input",
                  url: context.url,
                  rejected: true,
                  extraction: { source: "direct-document", rejected: true },
                  diagnostic: { reason: directDocument.reason, evidence: (directDocument as any).evidence },
                };
                const t = finalize("direct-document", result, "direct-document", undefined as any, trace);
                console.log(`[direct-document] ${context.url} auth-shaped interstitial — returning auth handoff before curl/browser fallback`);
                return { result, trace, source: "direct-document" as any, skill: undefined as any, timing: t };
              }
              if (directDocument.reason === "interstitial_detected") {
                try {
                  // tryCurlImpersonateFetch hoisted to module-top static import.
                  // resolveEgressProxy applies the residential-proxy-default
                  // policy (covenant sha256:65714387c8c9f6...): direct-egress
                  // opt-out > UNBROWSE_PROXY_URL > IPROYAL_* > ProxyKingdom default.
                  const proxy = resolveEgressProxy();
                  const cffi = await tryCurlImpersonateFetch({ url: context.url, proxy, timeoutMs: 25_000 });
                  if (cffi?.html && cffi.html.length > 1024 && cffi.status >= 200 && cffi.status < 400) {
                    const cffiArtifact = buildPageArtifactCapture(context.url, intent, cffi.html, false);
                    if (cffiArtifact.endpoint && cffiArtifact.result) {
                      console.log(`[direct-document] ${context.url} interstitial bypassed via curl_cffi: ${cffi.html.length} bytes proxy=${cffi.proxy_used} — skipping browser ladder`);
                      const trace: ExecutionTrace = {
                        trace_id: nanoid(),
                        skill_id: "direct-document-cffi",
                        endpoint_id: "direct-document-cffi",
                        started_at: new Date().toISOString(),
                        completed_at: new Date().toISOString(),
                        success: true,
                      };
                      const t = finalize("direct-document", cffiArtifact.result as Record<string, unknown>, "direct-document", undefined as any, trace);
                      return { result: cffiArtifact.result as Record<string, unknown>, trace, source: "direct-document" as any, skill: undefined as any, timing: t };
                    }
                    console.log(`[direct-document] curl_cffi returned ${cffi.html.length} bytes but extraction quality insufficient (JS-challenge body still interstitial) — falling through to browser ladder`);
                  } else if (cffi) {
                    console.log(`[direct-document] curl_cffi status=${cffi.status} bytes=${cffi.html.length} — proxy reachable but content not viable, falling through to browser ladder`);
                  }
                } catch (cffiErr) {
                  console.log(`[direct-document] curl_cffi interstitial-bypass error: ${cffiErr instanceof Error ? cffiErr.message : String(cffiErr)}`);
                }
              }
            }
          }
          if (data !== undefined) {
            const trace: ExecutionTrace = {
              trace_id: nanoid(),
              skill_id: "direct-fetch",
              endpoint_id: "direct-fetch",
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              success: true,
            };
            const t = finalize("direct-fetch", data, "direct-fetch", undefined as any, trace);
            console.log(`[direct-fetch] ${context.url} returned JSON directly — skipping browser`);
            return {
              result: data,
              trace,
              source: "direct-fetch" as any,
              skill: undefined as any,
              timing: t,
            };
          }
        } else if (directRes.status === 403 || directRes.status === 429 || directRes.status === 503) {
          // Bot-block status: native fetch reached the server but was refused
          // (TLS-fingerprint / UA block). curl-impersonate (Chrome JA4) commonly
          // passes where native bun fetch is blocked. Rescue here instead of
          // falling to the slow browser ladder (which timed out cli_timeout on
          // reddit .json — 403 to native, 200 to curl).
          console.log(`[direct-fetch] ${context.url} native fetch bot-blocked (${directRes.status}) — trying curl-impersonate`);
          const rescued = await curlRescueDirect();
          if (rescued) return rescued;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[direct-fetch] ${context.url} skipped: ${msg.slice(0, 100)}`);
        // Native fetch stalled/threw (TLS/HTTP hang — usgs.gov). Try the shared
        // curl-impersonate rescue before falling to the browser ladder.
        const rescued = await curlRescueDirect();
        if (rescued) return rescued;
      }
    }
    // 1.5 GraphQL endpoint detection — a GraphQL server answers GET with 204 /
    // empty / a playground (nothing to extract) but responds to a POST. Probe
    // with a minimal introspection query; if it answers in GraphQL shape,
    // surface the endpoint + its root query fields so the caller's LLM can
    // build a query and POST it (the two-tool-call contract). This replaces
    // browser-scraping a playground, which fails low_quality_dom_extraction.
    // Generic: the POST probe IS the signal — not a /graphql URL heuristic
    // (countries.trevorblades.com serves GraphQL at "/").
    if (context?.url) {
      try {
        const gqlProbe = await fetch(context.url, {
          method: "POST",
          headers: { "content-type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ query: "{__typename}" }),
          signal: AbortSignal.timeout(12000),
          redirect: "follow",
        });
        const gqlCt = gqlProbe.headers.get("content-type") ?? "";
        if (gqlProbe.ok && gqlCt.includes("json")) {
          const probeJson = (await gqlProbe.json().catch(() => null)) as { data?: { __typename?: unknown } } | null;
          if (probeJson && probeJson.data && typeof probeJson.data.__typename === "string") {
            // Confirmed GraphQL. Introspect the root Query type for evidence.
            let rootFields: Array<{ name: string; description: string | null }> = [];
            try {
              const introspectRes = await fetch(context.url, {
                method: "POST",
                headers: { "content-type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ query: "{__schema{queryType{fields{name description}}}}" }),
                signal: AbortSignal.timeout(12000),
                redirect: "follow",
              });
              if (introspectRes.ok) {
                const schemaJson = (await introspectRes.json().catch(() => null)) as
                  | { data?: { __schema?: { queryType?: { fields?: Array<{ name?: unknown; description?: unknown }> } } } }
                  | null;
                const fields = schemaJson?.data?.__schema?.queryType?.fields;
                if (Array.isArray(fields)) {
                  rootFields = fields
                    .map((f) => ({
                      name: typeof f?.name === "string" ? f.name : "",
                      description: typeof f?.description === "string" ? f.description : null,
                    }))
                    .filter((f) => f.name);
                }
              }
            } catch {
              // Introspection is best-effort — the endpoint is still usable.
            }
            const trace: ExecutionTrace = {
              trace_id: nanoid(),
              skill_id: "graphql-endpoint",
              endpoint_id: "graphql-query",
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              success: true,
              status_code: 200,
            };
            const gqlResult = {
              status: "graphql_endpoint",
              graphql_endpoint: context.url,
              method: "POST",
              message:
                "This is a GraphQL endpoint. POST a JSON body {\"query\":\"...\"} containing a GraphQL query that selects the fields you need.",
              root_query_fields: rootFields,
              next_step:
                rootFields.length > 0
                  ? `Build a GraphQL query over one of these root fields and POST it: ${rootFields.map((f) => f.name).slice(0, 24).join(", ")}`
                  : "Build a GraphQL query and POST it to graphql_endpoint.",
            };
            const t = finalize("direct-fetch", gqlResult, "graphql-endpoint", undefined as any, trace);
            console.log(`[graphql] ${context.url} confirmed GraphQL — ${rootFields.length} root query field(s) introspected`);
            return {
              result: gqlResult,
              trace,
              source: "direct-fetch" as any,
              skill: undefined as any,
              timing: t,
            };
          }
        }
      } catch {
        // Not a GraphQL endpoint (or unreachable) — fall through to the ladder.
      }
    }
    // 1.6 Connect/gRPC unary endpoint detection — a Connect/gRPC service answers
    // GET/HEAD with 405 (method not allowed) and has no HTML to extract, so the
    // browser ladder just times out on it. The unary path shape is
    // /<dotted.package>.<Service>/<Method>; the Connect protocol accepts a JSON
    // POST. Probe with an empty JSON body: a Connect endpoint returns either a
    // result message or a Connect error envelope ({code,message}) — both confirm
    // it. Surface it as a POST target (two-call contract) instead of capturing.
    if (context?.url) {
      try {
        const rpcUrl = new URL(context.url);
        const isRpcPath = /\/[A-Za-z_][\w.]*\.[A-Za-z_]\w*\/[A-Za-z_]\w*\/?$/.test(rpcUrl.pathname);
        if (isRpcPath) {
          // Cold-live execution: if the agent supplied request-message fields (params beyond
          // the reserved routing keys), POST them as the Connect message body — a real call,
          // not just a {} probe. No fields supplied → {} probe → detect-only (unchanged).
          const __rpcReserved = new Set(["url", "intent", "endpoint_id", "domain", "task", "query", "method", "no_execute"]);
          const __rpcMsg: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(params)) {
            if (!__rpcReserved.has(k) && v != null) __rpcMsg[k] = v;
          }
          const __rpcHasFields = Object.keys(__rpcMsg).length > 0;
          const rpcProbe = await fetch(context.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "connect-protocol-version": "1",
              Accept: "application/json",
            },
            body: __rpcHasFields ? JSON.stringify(__rpcMsg) : "{}",
            signal: AbortSignal.timeout(12000),
            redirect: "follow",
          });
          const rpcCt = rpcProbe.headers.get("content-type") ?? "";
          if (rpcCt.includes("json")) {
            const rpcJson = (await rpcProbe.json().catch(() => null)) as Record<string, unknown> | null;
            // ok → the method ran on {} defaults; or a Connect error envelope
            // {code,message} → the endpoint is real, the body just needs fields.
            const looksConnect =
              rpcJson != null && (rpcProbe.ok || (typeof rpcJson.code === "string" && "message" in rpcJson));
            if (looksConnect) {
              // COLD-LIVE EXECUTION: the agent supplied message fields AND the call returned a
              // real result (200, not a Connect error envelope) → return the DATA, not guidance.
              const __rpcIsError = rpcJson != null && typeof rpcJson.code === "string" && "message" in rpcJson;
              if (__rpcHasFields && rpcProbe.ok && !__rpcIsError) {
                const xtrace: ExecutionTrace = {
                  trace_id: nanoid(), skill_id: "grpc-endpoint", endpoint_id: "grpc-unary",
                  started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
                  success: true, status_code: rpcProbe.status,
                };
                const execResult = {
                  status: "executed",
                  grpc_endpoint: context.url,
                  method: "POST",
                  protocol: "connect/grpc-web (JSON over POST)",
                  request: __rpcMsg,
                  result: rpcJson,
                };
                const xt = finalize("direct-fetch", execResult, "grpc-unary", undefined as any, xtrace);
                console.log(`[grpc] ${context.url} cold-live executed (${Object.keys(__rpcMsg).length} field(s))`);
                return { result: execResult, trace: xtrace, source: "direct-fetch" as any, skill: undefined as any, timing: xt };
              }
              const trace: ExecutionTrace = {
                trace_id: nanoid(),
                skill_id: "grpc-endpoint",
                endpoint_id: "grpc-unary",
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                success: true,
                status_code: rpcProbe.status,
              };
              const grpcResult = {
                status: "grpc_endpoint",
                grpc_endpoint: context.url,
                method: "POST",
                protocol: "connect/grpc-web (JSON over POST)",
                message:
                  "This is a Connect/gRPC unary endpoint. POST a JSON body with the request message fields (Connect protocol over application/json; send header connect-protocol-version: 1).",
                probe_response: rpcJson,
                next_step:
                  "POST a JSON request message to grpc_endpoint with content-type application/json and connect-protocol-version: 1.",
              };
              const t = finalize("direct-fetch", grpcResult, "grpc-endpoint", undefined as any, trace);
              console.log(`[grpc] ${context.url} confirmed Connect/gRPC unary endpoint`);
              return {
                result: grpcResult,
                trace,
                source: "direct-fetch" as any,
                skill: undefined as any,
                timing: t,
              };
            }
          }
        }
      } catch {
        // Not a Connect/gRPC endpoint (or unreachable) — fall through to the ladder.
      }
    }
    // $0 routing (distribution mode): no viable marketplace skill AND the backend returned no
    // web hits (no Exa key / no x402 toll) → fall back to a KEYLESS DuckDuckGo search so the
    // pure-intent path still grounds, for free. This is what makes `unbrowse search/resolve`
    // (and the aiko endpoint grounding through them) return real web results at zero cost instead
    // of "No matching skill found". Disable with UNBROWSE_DDG_FALLBACK=0 to force the paid path.
    if (viable.length === 0 && !exaResults?.length && process.env.UNBROWSE_DDG_FALLBACK !== "0") {
      try {
        // Domain-anchored web query (see the race-path DDG fallback above): a bare generic
        // intent returns the same site-irrelevant articles for every domain. Prefix the target
        // domain so each site's fallback is distinct and on-topic, or empty (honest miss).
        const webQuery = requestedDomain ? `${requestedDomain} ${queryIntent}` : queryIntent;
        const ddg = await ddgSearch(webQuery, 5, proxiedWebFetch);
        if (ddg.length > 0) {
          exaResults = ddg;
          serialWebProvider = "ddg";
          console.log(`[ddg] $0 fallback: ${ddg.length} keyless web result(s) for "${webQuery}"`);
        }
      } catch (err) {
        console.log(`[ddg] $0 fallback failed: ${(err as Error).message}`);
      }
    }
    // Exa web search: when marketplace has no viable skills and Exa returned rich highlights,
    // synthesize an answer directly from the web excerpts — no browser needed.
    if (viable.length === 0 && exaResults?.length) {
      const richHit = exaResults.find((r) => (r.highlights ?? []).join(" ").length >= 150);
      if (richHit) {
        console.log(`[exa] returning highlights answer from ${richHit.url} (${(richHit.highlights ?? []).join(" ").length} chars) + ${exaResults.length} ranked candidate(s)`);
        const exaTrace: ExecutionTrace = {
          trace_id: nanoid(),
          skill_id: "exa-web-search",
          endpoint_id: "highlights",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: true,
          status_code: 200,
        };
        // Multi-source parity (the post-race exa path used to surface ONLY the
        // single richHit; the probe-fallback path at ~L3994 already surfaces the
        // full ranked list). A research agent solving a multi-clue question needs
        // EVERY ranked source to cross-reference, not one synthesized answer —
        // this is the apples-to-apples shape a neural-search bench feeds its agent.
        const candidates = exaResults.map((hit) => ({
          url: hit.url,
          title: hit.title,
          score: hit.score,
          highlights_excerpt: (hit.highlights ?? []).join(" ").slice(0, 240),
          next_step: {
            go: `unbrowse go --url ${JSON.stringify(hit.url)}`,
            fetch: `unbrowse fetch --url ${JSON.stringify(hit.url)}`,
          },
        }));
        return {
          result: {
            data: richHit.highlights,
            source_url: richHit.url,
            source_title: richHit.title,
            exa_answer: true,
            exa_candidates: candidates,
            ...(serialWebProvider && { web_search_provider: serialWebProvider }),
            // Day-6 W1: same round-trippability hint as the probe-fallback
            // path. exa-web-search is preview-only; execute will fail with
            // "Skill not found". Agents should call unbrowse_fetch on
            // source_url for the actual contents.
            synthetic_skill: true,
            exec_unsupported: true,
            next_step: "use unbrowse fetch for synthetic Exa results",
            suggested_commands: candidates.slice(0, 3).map((c) => `unbrowse fetch --url ${JSON.stringify(c.url)}`),
          },
          trace: exaTrace,
          source: "exa" as const,
          skill: { skill_id: "exa-web-search", domain: (() => { try { return new URL(richHit.url).hostname; } catch { return richHit.url; } })() } as unknown as SkillManifest,
          timing: finalize("exa", null, "exa-web-search", undefined, exaTrace),
        };
      }
    }
  } // end !forceCapture

  if (process.env.UNBROWSE_LOCAL_ONLY === "1" && !forceCapture) {
    return buildNoCachedMatch();
  }

  // 2. No URL at all — nothing to capture
  if (!context?.url) {
    throw new Error(
      "No matching skill found. Pass context.url to trigger live capture and discovery.",
    );
  }

  const captureDomain = new URL(context.url).hostname;

  // Check recently-captured cache: avoids re-capturing when EmergentDB hasn't indexed yet
  const domainHit = !forceCapture ? capturedDomainCache.get(cacheKey) : undefined;
  if (domainHit && Date.now() < domainHit.expires) {
    if (!isCachedSkillRelevantForIntent(domainHit.skill, queryIntent, context?.url)) {
      capturedDomainCache.delete(cacheKey);
    } else {
      if (agentChoseEndpoint) {
        const selectedEndpoint = domainHit.skill.endpoints.find(
          (endpoint) => endpoint.endpoint_id === (params.endpoint_id ?? domainHit.endpointId),
        );
        if (selectedEndpoint && !isResolveUsableEndpointForIntent(selectedEndpoint, queryIntent, context?.url)) {
          invalidateResolveCacheEntries([cacheKey], requestedDomainCacheKey ? [requestedDomainCacheKey] : []);
        } else {
        const execOut = await executeSkill(
          domainHit.skill,
          { ...params, endpoint_id: params.endpoint_id ?? domainHit.endpointId, ...(queryIntent !== intent ? { intent: queryIntent } : {}) },
          projection,
          { ...options, intent: queryIntent, contextUrl: context?.url },
        );
        if (execOut.trace.success && isAcceptableIntentResult(execOut.result, queryIntent)) {
          const cachedDomainStep = recordRoutingCandidates(
            domainHit.skill,
            [{
              endpoint:
                domainHit.skill.endpoints.find(
                  (endpoint) => endpoint.endpoint_id === (params.endpoint_id ?? domainHit.endpointId ?? execOut.trace.endpoint_id),
                ) ?? domainHit.skill.endpoints[0],
              score: 1,
            }],
            "marketplace",
            { selectedEndpointId: params.endpoint_id ?? domainHit.endpointId ?? execOut.trace.endpoint_id },
          );
          recordRoutingStep("marketplace", domainHit.skill, execOut.trace, execOut.result, {
            stepIndex: cachedDomainStep,
            selectedEndpointId: params.endpoint_id ?? domainHit.endpointId ?? execOut.trace.endpoint_id,
            candidateCount: 1,
            userOverride: true,
            requiredRecovery: false,
          });
          promoteResultSnapshot(
            cacheKey,
            domainHit.skill,
            params.endpoint_id ?? domainHit.endpointId,
            execOut.result,
            execOut.trace,
          );
          return {
            result: execOut.result,
            trace: execOut.trace,
            source: "marketplace",
            skill: domainHit.skill,
            timing: finalize(
              "marketplace",
              execOut.result,
              domainHit.skill.skill_id,
              domainHit.skill,
              execOut.trace,
            ),
          };
        }
        invalidateResolveCacheEntries([cacheKey], requestedDomainCacheKey ? [requestedDomainCacheKey] : []);
        }
      }
      const deferred = await buildDeferralWithAutoExec(domainHit.skill, "marketplace");
      if (shouldFallbackToLiveCaptureAfterAutoexecFailure(deferred.autoexecFailedAll, context?.url)) {
        console.log("[captured-domain-cache] stale skill; retrying via live capture");
        invalidateResolveCacheEntries([cacheKey], requestedDomainCacheKey ? [requestedDomainCacheKey] : []);
      } else {
        timing.cache_hit = true;
        deferred.orchestratorResult.timing.cache_hit = true;
        return deferred.orchestratorResult;
      }
    }
  }

  // In-flight capture queue: wait for the same domain capture instead of failing.
  const bypassLiveCaptureQueue = shouldBypassBrowserFirstPass;
  const captureLockKey = scopedCacheKey(clientScope, captureDomain);
  let learned_skill: SkillManifest | undefined;
  let trace: import("../types/index.js").ExecutionTrace;
  let result: unknown;
  if (!bypassLiveCaptureQueue) {
    const existingCapture = captureInFlight.get(captureLockKey);
    if (existingCapture) {
      const waited = await withOpTimeout(
        "live_capture_wait",
        LIVE_CAPTURE_TIMEOUT_MS,
        existingCapture,
      );
      trace = waited.trace;
      result = waited.result;
      learned_skill = waited.learned_skill;
      const parityBaseline = waited.parity_baseline;
      timing.execute_ms = 0;
      if (!learned_skill && !trace.success) {
        recordRoutingStep("live-capture", undefined, trace, result, {
          candidateCount: 0,
          didStepUnlockNextStep: false,
          userOverride: false,
          requiredRecovery: true,
        });
        return {
          result,
          trace,
          source: "live-capture",
          skill: await getOrCreateBrowserCaptureSkill(),
          timing: finalize("live-capture", result, undefined, undefined, trace),
        };
      }
      if (learned_skill) {
        const captureResult = result as Record<string, unknown> | null;
        const authRecommended = captureResult?.auth_recommended === true;
        const deferred = await buildDeferralWithAutoExec(
          learned_skill,
          "live-capture",
          authRecommended
            ? {
                auth_recommended: true,
              auth_hint: captureResult!.auth_hint,
            }
            : undefined,
        );
        queuePassivePublishIfExecuted(learned_skill, deferred.orchestratorResult, parityBaseline);
        deferred.orchestratorResult.timing.cache_hit = true;
        return deferred.orchestratorResult;
      }
      return {
        result,
        trace,
        source: "live-capture",
        skill: await getOrCreateBrowserCaptureSkill(),
        timing: finalize("live-capture", result, undefined, undefined, trace),
      };
    }
  }

  let parityBaseline: unknown;
  let captureSkill: SkillManifest;
  const te0 = Date.now();
  try {
    if (bypassLiveCaptureQueue) {
      captureSkill = await getOrCreateBrowserCaptureSkill();
      const out = await withAbortableOpTimeout(
        "live_capture_execute",
        LIVE_CAPTURE_TIMEOUT_MS,
        (signal) =>
          executeSkill(captureSkill, { ...params, url: context.url, intent }, undefined, {
            ...options,
            intent,
            contextUrl: context?.url,
            signal,
          }),
      );
      trace = out.trace;
      result = out.result;
      learned_skill = out.learned_skill;
      parityBaseline = out.parity_baseline;
    } else {
      const capturePromise = withDomainCaptureLock(captureDomain, async () => {
        const captureSkill = await getOrCreateBrowserCaptureSkill();
        const out = await withAbortableOpTimeout(
          "live_capture_execute",
          LIVE_CAPTURE_TIMEOUT_MS,
          (signal) =>
            executeSkill(captureSkill, { ...params, url: context.url, intent }, undefined, {
              ...options,
              intent,
              contextUrl: context?.url,
              signal,
            }),
        );
        return {
          trace: out.trace,
          result: out.result,
          learned_skill: out.learned_skill,
          parity_baseline: out.parity_baseline,
        };
      });
      captureInFlight.set(captureLockKey, capturePromise);
      try {
        captureSkill = await getOrCreateBrowserCaptureSkill();
        const out = await capturePromise;
        trace = out.trace;
        result = out.result;
        learned_skill = out.learned_skill;
        parityBaseline = out.parity_baseline;
      } finally {
        captureInFlight.delete(captureLockKey);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Unable to connect|timed out|timeout/i.test(message)) {
      console.warn(`[capture] live capture unavailable (${message}) — falling back to browse session`);
      const browseSession = await openBrowseSessionHandoff(context.url);
      if (browseSession) return browseSession;
    }
    throw error;
  }
  timing.execute_ms = Date.now() - te0;

  // Recover from Kuri crash: if live-capture returned connection_failed or
  // capture_failed, force-restart Kuri and retry once. Kuri occasionally
  // SIGSEGVs on heavy SPAs (see unbrowse-ai/unbrowse#105) and subsequent
  // requests would inherit the dead broker state.
  const captureErrCheck = (result as Record<string, unknown> | null)?.error;
  if (captureErrCheck === "connection_failed" || captureErrCheck === "capture_failed") {
    console.warn(`[capture] ${captureErrCheck} detected — restarting Kuri and retrying once`);
    try {
      const kuri = await import("../kuri/client.js");
      await kuri.stop().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    } catch { /* best effort */ }
    try {
      const retryCaptureSkill = await getOrCreateBrowserCaptureSkill();
      const retryOut = await withAbortableOpTimeout(
        "live_capture_retry",
        LIVE_CAPTURE_TIMEOUT_MS,
        (signal) =>
          executeSkill(retryCaptureSkill, { ...params, url: context.url, intent }, undefined, {
            ...options,
            intent,
            contextUrl: context?.url,
            signal,
          }),
      );
      if (retryOut.trace.success || !(retryOut.result as Record<string, unknown>)?.error) {
        trace = retryOut.trace;
        result = retryOut.result;
        learned_skill = retryOut.learned_skill;
        console.log(`[capture] retry after Kuri restart succeeded`);
      }
    } catch (retryErr) {
      console.warn(`[capture] retry failed: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
    }
  }

  const captureResult = result as Record<string, unknown> | null;
  const authRecommended = captureResult?.auth_recommended === true;

  const directDomCaptureResult =
    trace.success &&
    trace.endpoint_id !== "browser-capture" &&
    !!result &&
    typeof result === "object" &&
    "_extraction" in (result as Record<string, unknown>);
  const learnedSkillUsable = learned_skill ? hasUsableEndpoints(learned_skill) : false;
  if (learned_skill && !learnedSkillUsable) {
    console.warn("[capture] dropping unusable learned skill with no replayable endpoints");
    if (!directDomCaptureResult) learned_skill = undefined;
  }

  if (learned_skill && learnedSkillUsable && !isCachedSkillRelevantForIntent(learned_skill, queryIntent, context?.url)) {
    const repairedSnapshot =
      requestedDomain
        ? findBestLocalDomainSnapshot(
            requestedDomain,
            queryIntent,
            context?.url,
            new Set([learned_skill.skill_id]),
          )
        : undefined;
    if (repairedSnapshot) {
      console.log(
        `[capture] reviving local snapshot ${repairedSnapshot.skill_id.slice(0, 15)} after irrelevant learned skill`,
      );
      const repaired = await buildDeferralWithAutoExec(repairedSnapshot, "marketplace");
      repaired.orchestratorResult.timing.cache_hit = true;
      return repaired.orchestratorResult;
    }
    const resolvedSkill = withContextReplayEndpoint(learned_skill, queryIntent, context?.url);
    const ranked = rankEndpoints(
      resolvedSkill.endpoints,
      queryIntent,
      resolvedSkill.domain,
      context?.url,
      params,
    );
    const rejectedTrace: ExecutionTrace = {
      ...trace,
      success: false,
      error: `No relevant endpoint discovered for "${queryIntent}"`,
    };
    console.warn(`[capture] dropping learned skill with no relevant endpoints for "${queryIntent}"`);
    // Diagnostic for the agent/bench triage: distinguish between
    // "captured lots of endpoints but none relevant" (scoring issue)
    // and "captured nothing at all" (likely browser-blocked upstream).
    const totalEndpoints = resolvedSkill.endpoints.length;
    const captureDiagnostic =
      totalEndpoints === 0
        ? "no_endpoints_extracted"
        : ranked.length === 0
        ? "all_endpoints_filtered_by_noise_rules"
        : "endpoints_scored_below_relevance_threshold";
    return {
      result: {
        error: `No relevant endpoint discovered for "${queryIntent}"`,
        discovered_endpoints: ranked.slice(0, 3).map((candidate) => ({
          endpoint_id: candidate.endpoint.endpoint_id,
          score: Math.round(candidate.score * 10) / 10,
          description: candidate.endpoint.description,
          url: candidate.endpoint.url_template,
        })),
        capture_diagnostic: captureDiagnostic,
        total_endpoints_captured: totalEndpoints,
        ...(authRecommended
          ? {
              auth_recommended: true,
              auth_hint: captureResult?.auth_hint,
            }
          : {}),
      },
      trace: rejectedTrace,
      source: "live-capture",
      skill: captureSkill!,
      timing: finalize("live-capture", result, undefined, undefined, rejectedTrace),
    };
  }

  // Stamp learned skill with real discovery cost so future cache hits use real baselines.
  if (learned_skill && learnedSkillUsable) {
    const captureResultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    learned_skill.discovery_cost = {
      capture_ms: timing.execute_ms,
      capture_tokens: DEFAULT_CAPTURE_TOKENS,
      response_bytes: captureResultStr.length,
      captured_at: new Date().toISOString(),
    };

    // Generate local heuristic descriptions so BM25 auto-exec works immediately.
    // Backend will overwrite with LLM descriptions, but this unblocks the first request.
    for (const ep of learned_skill.endpoints) {
      if (!ep.description) {
        ep.description = generateLocalDescription(ep);
      }
    }
  }

  function queuePassivePublishIfExecuted(
    skill: SkillManifest,
    orchestratorResult: OrchestratorResult,
    browserBaseline?: unknown,
  ): void {
    if (!orchestratorResult.trace.success || !orchestratorResult.trace.endpoint_id) return;
    const parity = browserBaseline === undefined
      ? undefined
      : Promise.resolve(agentJudgeParity(intent, browserBaseline, orchestratorResult.result));
    void queuePassiveSkillPublish(skill, { parity });
  }

  // Auth-gated or no data: escalate host-blocked 4xx to browse-session handoff,
  // otherwise pass through the trace error so the agent can see what failed.
  if (!learned_skill && !trace.success) {
    recordRoutingStep("live-capture", captureSkill, trace, result, {
      candidateCount: 0,
      didStepUnlockNextStep: false,
      userOverride: false,
      requiredRecovery: true,
    });
    // Bug 3: when the host responded with 402/403/429 from live-capture and the
    // failure is NOT a substrate-tagged auth_required (which has its own
    // user-facing flow), the cookies-injected browser session may still
    // succeed where libcurl was rate-limited / fee-gated / geo-blocked.
    // Escalate to browse_session_open instead of returning the raw error so
    // the calling agent gets an actionable next_step it can drive.
    const blockingStatus = typeof trace.status_code === "number" ? trace.status_code : undefined;
    const resultRecord = (result && typeof result === "object") ? (result as Record<string, unknown>) : null;
    const isAuthRequired =
      resultRecord?.error === "auth_required" || resultRecord?.auth_required === true;
    if (
      !isAuthRequired &&
      context?.url &&
      (blockingStatus === 402 || blockingStatus === 403 || blockingStatus === 429)
    ) {
      console.warn(
        `[capture] host_blocked_with_${blockingStatus} on ${captureDomain}: escalating to browse_session handoff`,
      );
      const handoff = await openBrowseSessionHandoff(context.url);
      if (handoff) {
        const handoffResult = handoff.result as Record<string, unknown>;
        handoffResult.reason = `host_blocked_with_${blockingStatus}`;
        handoffResult.status_code_observed = blockingStatus;
        return handoff;
      }
    }
    // vendor:cloudflare / vendor:datadome / vendor:perimeterx block detected:
    // libcurl-impersonate (Chrome131 JA4) may bypass the JS challenge that
    // Kuri's --headless=new triggered. executeBrowserCapture already attempts
    // this inside the capture pipeline (src/execution/index.ts L2017), but
    // that rescue also fails when Kuri returns an empty or CF-challenge-shaped
    // page. This second attempt runs at the orchestrator boundary so any vendor
    // block — regardless of capture-side error type — gets one libcurl shot
    // before the agent sees an ANTIBOT_BLOCK failure.
    // Only fires when: no learned_skill, trace failed, url present, not auth_required.
    if (!isAuthRequired && context?.url) {
      const capturedBlockSignals = (resultRecord?.captured_meta as Record<string, unknown> | undefined)?.browser_block_signals;
      const hasVendorBlockSignal =
        Array.isArray(capturedBlockSignals) &&
        capturedBlockSignals.some((s: unknown) => typeof s === "string" && s.startsWith("vendor:"));
      // resolveEgressProxy applies the residential-proxy-default policy
      // (covenant sha256:65714387c8c9f6...): UNBROWSE_DIRECT_EGRESS=1 → direct;
      // UNBROWSE_PROXY_URL → verbatim; IPROYAL_* → IProyal; else → ProxyKingdom.
      // Same composition used by the no_progress_bail rescue
      // (src/execution/index.ts:1749) and the direct-document curl_cffi
      // shortcut (line 4559 above).
      const antibotProxy = resolveEgressProxy();

      if (hasVendorBlockSignal) {
        try {
          // trySsrFastPathOnBlock hoisted to module-top static import
          const ssr = await trySsrFastPathOnBlock({
            url: context.url,
            timeoutMs: 15_000,
            proxy: antibotProxy,
          });
          if (ssr && ssr.html.length > 500) {
            const ssrArtifact = buildPageArtifactCapture(context.url, queryIntent, ssr.html, false);
            if (ssrArtifact.endpoint && ssrArtifact.result) {
              console.log(
                `[orchestrator] vendor_block_ssr_fastpath_success: ${ssr.html.length} bytes via libcurl-impersonate (signals: ${capturedBlockSignals.join(", ")})`,
              );
              const ssrTrace: import("../types/index.js").ExecutionTrace = {
                trace_id: nanoid(),
                skill_id: captureSkill!.skill_id,
                endpoint_id: ssrArtifact.endpoint.endpoint_id,
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                success: true,
              };

              recordRoutingStep("live-capture", captureSkill, ssrTrace, ssrArtifact.result, {
                candidateCount: 1,
                selectedEndpointId: ssrArtifact.endpoint.endpoint_id,
                didStepUnlockNextStep: true,
                userOverride: false,
                requiredRecovery: true,
              });
              return {
                result: artifactResultWithShortlist(ssrArtifact, captureSkill!.skill_id, context.url),
                trace: ssrTrace,
                source: "live-capture",
                skill: captureSkill!,
                timing: finalize("live-capture", ssrArtifact.result, captureSkill!.skill_id, captureSkill, ssrTrace),
              };
            }
            console.log(
              `[orchestrator] vendor_block_ssr_fastpath_null: libcurl returned ${ssr.html.length} bytes but DOM extraction yielded no usable artifact`,
            );
          } else {
            console.log(
              `[orchestrator] vendor_block_ssr_fastpath_null: libcurl returned ${ssr ? ssr.html.length : 0} bytes (below 500-byte floor or null)`,
            );
          }
        } catch (ssrErr) {
          console.log(
            `[orchestrator] vendor_block_ssr_fastpath_error: ${ssrErr instanceof Error ? ssrErr.message : String(ssrErr)}`,
          );
        }

        // Tertiary fallback: curl_cffi via Python helper. trySsrFastPathOnBlock
        // routes through Kuri's /v1/sandbox/replay — when Kuri is dead (cli
        // timeout / SIGKILL) or its sandbox doesn't impersonate the failing
        // vendor's JA4, this direct Python+curl_cffi path can still bypass
        // TLS-fingerprint-only vendor blocks (datadome, cloudflare TLS class,
        // captcha-200-but-empty). Same composition as the no_progress_bail
        // rescue chain at src/execution/index.ts:1732. Skips cleanly when
        // curl_cffi is not installed or returns an interstitial-shaped body.
        try {
          const cffi = await tryCurlImpersonateFetch({
            url: context.url,
            proxy: antibotProxy,
            timeoutMs: 25_000,
          });
          if (cffi?.html && cffi.html.length > 1024 && cffi.status >= 200 && cffi.status < 400) {
            const cffiArtifact = buildPageArtifactCapture(context.url, queryIntent, cffi.html, false);
            if (cffiArtifact.endpoint && cffiArtifact.result) {
              console.log(
                `[orchestrator] vendor_block_curl_cffi_success: ${cffi.html.length} bytes via curl_cffi proxy=${cffi.proxy_used} (signals: ${capturedBlockSignals.join(", ")})`,
              );
              const cffiTrace: import("../types/index.js").ExecutionTrace = {
                trace_id: nanoid(),
                skill_id: captureSkill!.skill_id,
                endpoint_id: cffiArtifact.endpoint.endpoint_id,
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                success: true,
                decision_trace: [{
                  step: "vendor_block_curl_cffi_success",
                  html_bytes: cffi.html.length,
                  status: cffi.status,
                  proxy_used: cffi.proxy_used,
                  vendor_signals: capturedBlockSignals,
                }],
              };
              recordRoutingStep("live-capture", captureSkill, cffiTrace, cffiArtifact.result, {
                candidateCount: 1,
                selectedEndpointId: cffiArtifact.endpoint.endpoint_id,
                didStepUnlockNextStep: true,
                userOverride: false,
                requiredRecovery: true,
              });
              return {
                result: artifactResultWithShortlist(cffiArtifact, captureSkill!.skill_id, context.url),
                trace: cffiTrace,
                source: "live-capture",
                skill: captureSkill!,
                timing: finalize("live-capture", cffiArtifact.result, captureSkill!.skill_id, captureSkill, cffiTrace),
              };
            }
            console.log(
              `[orchestrator] vendor_block_curl_cffi_null: curl_cffi returned ${cffi.html.length} bytes but DOM extraction yielded no usable artifact`,
            );
          } else if (cffi) {
            console.log(
              `[orchestrator] vendor_block_curl_cffi_null: status=${cffi.status} bytes=${cffi.bytes} proxy=${cffi.proxy_used} — proxy reachable but content not viable`,
            );
          } else {
            console.log(`[orchestrator] vendor_block_curl_cffi_null: helper unavailable or returned no result`);
          }
        } catch (cffiErr) {
          console.log(
            `[orchestrator] vendor_block_curl_cffi_error: ${cffiErr instanceof Error ? cffiErr.message : String(cffiErr)}`,
          );
        }
      } else {
        // NO-vendor-signal empty-capture rescue. When the browser failed
        // without producing any captured_meta (cli_timeout=124 / kuri SIGKILL
        // pre-capture / no_html_many_apis where getPageHtml returned empty),
        // there is no vendor:* signal to gate on but the page may still be
        // reachable via curl_cffi + residential proxy. Skips cleanly when
        // curl_cffi yields an interstitial-shaped body or the helper is
        // unavailable. Bounded by the 25s timeout so it cannot push total
        // wall-clock past the bench budget.
        try {
          let cffi = await tryCurlImpersonateFetch({
            url: context.url,
            proxy: antibotProxy,
            timeoutMs: 25_000,
          });
          const cffiViable = (r: typeof cffi) =>
            !!(r?.html && r.html.length > 1024 && r.status >= 200 && r.status < 400);
          // Proxy-flake resilience: the residential proxy can be slow / blocked / dead
          // on a page that IS reachable from our own egress (verified: npm, lobste.rs,
          // news.ycombinator.com all serve directly). When the proxied attempt isn't
          // viable, retry DIRECT so a flaky upstream proxy doesn't cost us the capture
          // of a directly-reachable no-API / SPA page. Cloudflare-gated pages (e.g.
          // stackoverflow "Just a moment...") stay non-viable on BOTH and fall through
          // honestly — this only rescues pages that are genuinely reachable.
          if (!cffiViable(cffi) && antibotProxy) {
            console.log("[orchestrator] empty_capture_curl_cffi: proxied attempt not viable — retrying forceDirect");
            const directCffi = await tryCurlImpersonateFetch({
              url: context.url,
              forceDirect: true,
              timeoutMs: 25_000,
            });
            if (cffiViable(directCffi)) cffi = directCffi;
          }
          if (cffi?.html && cffi.html.length > 1024 && cffi.status >= 200 && cffi.status < 400) {
            const cffiArtifact = buildPageArtifactCapture(context.url, queryIntent, cffi.html, false);
            if (cffiArtifact.endpoint && cffiArtifact.result) {
              console.log(
                `[orchestrator] empty_capture_curl_cffi_success: ${cffi.html.length} bytes via curl_cffi proxy=${cffi.proxy_used} (browser produced no captured_meta)`,
              );
              const cffiTrace: import("../types/index.js").ExecutionTrace = {
                trace_id: nanoid(),
                skill_id: captureSkill!.skill_id,
                endpoint_id: cffiArtifact.endpoint.endpoint_id,
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                success: true,
                decision_trace: [{
                  step: "empty_capture_curl_cffi_success",
                  html_bytes: cffi.html.length,
                  status: cffi.status,
                  proxy_used: cffi.proxy_used,
                }],
              };
              recordRoutingStep("live-capture", captureSkill, cffiTrace, cffiArtifact.result, {
                candidateCount: 1,
                selectedEndpointId: cffiArtifact.endpoint.endpoint_id,
                didStepUnlockNextStep: true,
                userOverride: false,
                requiredRecovery: true,
              });
              return {
                result: artifactResultWithShortlist(cffiArtifact, captureSkill!.skill_id, context.url),
                trace: cffiTrace,
                source: "live-capture",
                skill: captureSkill!,
                timing: finalize("live-capture", cffiArtifact.result, captureSkill!.skill_id, captureSkill, cffiTrace),
              };
            }
            console.log(
              `[orchestrator] empty_capture_curl_cffi_null: curl_cffi returned ${cffi.html.length} bytes but DOM extraction yielded no usable artifact`,
            );
          } else if (cffi) {
            console.log(
              `[orchestrator] empty_capture_curl_cffi_null: status=${cffi.status} bytes=${cffi.bytes} proxy=${cffi.proxy_used} — content not viable`,
            );
          } else {
            console.log(`[orchestrator] empty_capture_curl_cffi_null: helper unavailable or returned no result`);
          }
        } catch (cffiErr) {
          console.log(
            `[orchestrator] empty_capture_curl_cffi_error: ${cffiErr instanceof Error ? cffiErr.message : String(cffiErr)}`,
          );
        }
      }
    }

    // Final rescue rung: camoufox stealth Firefox. SSR-fastpath + curl_cffi have no JS
    // engine, so they cannot clear a Cloudflare "Just a moment…" JS challenge — camoufox
    // (fingerprint-spoofed Firefox + solve_cloudflare loop, yoinked from Scrapling's
    // StealthyFetcher) can, and does (verified: stackoverflow → real "Newest Questions"
    // DOM). Only reached after the cheaper rungs failed; returns null when the dev venv is
    // absent (shipped binary) or the page is still blocked, so it degrades cleanly.
    if (context?.url && !isAuthRequired) {
      try {
        // Direct first: camoufox's stealth fingerprint (not the IP) clears Cloudflare, and
        // the residential-proxy IP is often itself flagged (curl_cffi got 403 through it).
        // Direct is the verified-working path; fall back to proxied for geo/IP-gated sites.
        let camo = await tryCamoufoxFetch({ url: context.url, timeoutMs: 90_000, forceDirect: true });
        if (!(camo?.html && camo.html.length > 1024) && resolveEgressProxy()) {
          camo = await tryCamoufoxFetch({ url: context.url, timeoutMs: 90_000 });
        }
        if (camo?.html && camo.html.length > 1024) {
          const camoArtifact = buildPageArtifactCapture(context.url, queryIntent, camo.html, false);
          if (camoArtifact.endpoint && camoArtifact.result) {
            console.log(`[orchestrator] camoufox_success: ${camo.html.length} bytes (cleared JS challenge where curl_cffi/SSR failed)`);
            const camoTrace: import("../types/index.js").ExecutionTrace = {
              trace_id: nanoid(),
              skill_id: captureSkill!.skill_id,
              endpoint_id: camoArtifact.endpoint.endpoint_id,
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              success: true,
              decision_trace: [{ step: "camoufox_success", html_bytes: camo.html.length }],
            };
            recordRoutingStep("live-capture", captureSkill, camoTrace, camoArtifact.result, {
              candidateCount: 1,
              selectedEndpointId: camoArtifact.endpoint.endpoint_id,
              didStepUnlockNextStep: true,
              userOverride: false,
              requiredRecovery: true,
            });
            return {
              result: artifactResultWithShortlist(camoArtifact, captureSkill!.skill_id, context.url),
              trace: camoTrace,
              source: "live-capture",
              skill: captureSkill!,
              timing: finalize("live-capture", camoArtifact.result, captureSkill!.skill_id, captureSkill, camoTrace),
            };
          }
          console.log(`[orchestrator] camoufox_null: ${camo.html.length} bytes but DOM extraction yielded no usable artifact`);
        } else {
          console.log("[orchestrator] camoufox_null: helper unavailable / still blocked");
        }
      } catch (camoErr) {
        console.log(`[orchestrator] camoufox_error: ${camoErr instanceof Error ? camoErr.message : String(camoErr)}`);
      }
      // Paid x402 web-unblocker — the Cloudflare-class rescue that works on the SHIPPED binary
      // (camoufox above needs the dev-only venv → null on npm install, so this is the binary's
      // only JS-challenge rescue). Auto-engages when a payment method is configured
      // (x402PaymentAvailable) and walks the unblocker fallback chain; negative-cache-gated.
      // Reached only after SSR/curl_cffi/camoufox all failed on a blocked capture.
      try {
        const unlocked = await tryX402UnblockerFetch({ url: context.url, timeoutMs: 240_000 });
        if (unlocked?.html && unlocked.html.length > 1024 && !looksBlocked(unlocked.html, 1024)) {
          const unlockArtifact = buildPageArtifactCapture(context.url, queryIntent, unlocked.html, false);
          if (unlockArtifact.endpoint && unlockArtifact.result) {
            console.log(`[orchestrator] x402_unblocker_success: ${unlocked.html.length} bytes (cleared JS challenge via paid residential unblocker)`);
            const unlockTrace: import("../types/index.js").ExecutionTrace = {
              trace_id: nanoid(),
              skill_id: captureSkill!.skill_id,
              endpoint_id: unlockArtifact.endpoint.endpoint_id,
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              success: true,
              decision_trace: [{ step: "x402_unblocker_success", html_bytes: unlocked.html.length }],
            };
            recordRoutingStep("live-capture", captureSkill, unlockTrace, unlockArtifact.result, {
              candidateCount: 1,
              selectedEndpointId: unlockArtifact.endpoint.endpoint_id,
              didStepUnlockNextStep: true,
              userOverride: false,
              requiredRecovery: true,
            });
            return {
              result: artifactResultWithShortlist(unlockArtifact, captureSkill!.skill_id, context.url),
              trace: unlockTrace,
              source: "live-capture",
              skill: captureSkill!,
              timing: finalize("live-capture", unlockArtifact.result, captureSkill!.skill_id, captureSkill, unlockTrace),
            };
          }
          console.log(`[orchestrator] x402_unblocker_null: ${unlocked.html.length} bytes but DOM extraction yielded no usable artifact`);
        } else {
          console.log("[orchestrator] x402_unblocker_null: disabled / unavailable / still blocked");
        }
      } catch (unlockErr) {
        console.log(`[orchestrator] x402_unblocker_error: ${unlockErr instanceof Error ? unlockErr.message : String(unlockErr)}`);
      }
    }

    return {
      result,
      trace,
      source: "live-capture",
      skill: captureSkill!,
      timing: finalize("live-capture", result, undefined, undefined, trace),
    };
  }

  // DOM-extracted skill: data already extracted during capture, return directly
  const hasNonDomApiEndpoints = !!learned_skill?.endpoints?.some(
    (ep) => !ep.dom_extraction && ep.method !== "WS",
  );
  const hasBetterStructuredSearchEndpoint = learned_skill
    ? skillHasBetterStructuredSearchEndpoint(learned_skill, trace.endpoint_id, queryIntent, context?.url)
    : false;
  const isDirectDomResult = directDomCaptureResult;
  const directExtractionSource =
    isDirectDomResult && result && typeof result === "object"
      ? ((result as Record<string, unknown>)._extraction as Record<string, unknown> | undefined)?.source
      : undefined;
  if (
    isDirectDomResult &&
    (
      (directExtractionSource === "html-embedded" && !hasBetterStructuredSearchEndpoint) ||
      !hasNonDomApiEndpoints
    )
  ) {
    // The page was reached and DOM data was extracted (result._extraction). There IS a
    // usable endpoint — the DOM-extraction route the capture just exercised — but the
    // direct return path historically emitted only the data, with an EMPTY
    // available_endpoints, so `explain`/resolve reported zero coverage for SPA / SSR
    // no-XHR-API pages that genuinely have a callable route. Surface the captured
    // DOM-extraction endpoint(s) (or the page_fetch structural floor) as the shortlist
    // alongside the data, so the reported capability matches the real one.
    const mergeDomShortlist = (raw: unknown, skill: SkillManifest | undefined): unknown => {
      if (!raw || typeof raw !== "object") return raw;
      const rec = raw as Record<string, unknown>;
      const existing = rec.available_endpoints;
      if (Array.isArray(existing) && existing.length > 0) return raw;
      let shortlist = (skill?.endpoints ?? [])
        .filter((ep) => !!ep.dom_extraction || ep.method === "GET")
        .slice(0, 8)
        .map((ep) => ({
          endpoint_id: ep.endpoint_id,
          source_skill_id: skill!.skill_id,
          method: ep.method,
          url: ep.url_template,
          url_template: ep.url_template,
          description: ep.description ?? ep.semantic?.description_out,
          score: 1,
          ...(ep.dom_extraction ? { dom_extraction: ep.dom_extraction } : {}),
          trigger_url: ep.trigger_url ?? context?.url,
        }));
      if (shortlist.length === 0 && context?.url) {
        const pf = buildPageFetchEndpoint(context.url, queryIntent);
        shortlist = [{
          endpoint_id: pf.endpoint_id,
          source_skill_id: skill?.skill_id ?? captureSkill!.skill_id,
          method: pf.method,
          url: pf.url_template,
          url_template: pf.url_template,
          description: pf.description,
          score: 1,
          dom_extraction: pf.dom_extraction,
          trigger_url: context.url,
        }];
      }
      if (shortlist.length === 0) return raw;
      return {
        ...rec,
        available_endpoints: shortlist,
        available_operations: shortlist,
        shortlist_for_judgment: shortlist,
      };
    };
    if (learned_skill) {
      recordRoutingStep(
        directExtractionSource === "html-embedded" ? "live-capture" : "dom-fallback",
        learned_skill,
        trace,
        result,
        {
          candidateCount: trace.endpoint_id ? 1 : 0,
          selectedEndpointId: trace.endpoint_id,
          userOverride: false,
          requiredRecovery: !trace.success,
        },
      );
      const direct: OrchestratorResult = {
        result: mergeDomShortlist(result, learned_skill),
        trace,
        source: directExtractionSource === "html-embedded" ? "live-capture" : "dom-fallback",
        skill: learned_skill,
        timing: finalize(
          directExtractionSource === "html-embedded" ? "live-capture" : "dom-fallback",
          result,
          learned_skill.skill_id,
          learned_skill,
          trace,
        ),
      };
      queuePassivePublishIfExecuted(learned_skill, direct, parityBaseline);
      return direct;
    }
    recordRoutingStep("dom-fallback", captureSkill, trace, result, {
      candidateCount: trace.endpoint_id ? 1 : 0,
      selectedEndpointId: trace.endpoint_id,
      userOverride: false,
      requiredRecovery: !trace.success,
    });
    return {
      result: mergeDomShortlist(result, captureSkill),
      trace,
      source: "dom-fallback",
      skill: captureSkill!,
      timing: finalize("dom-fallback", result, undefined, undefined, trace),
    };
  }

  if (!learned_skill) {
    // Eval-based DOM extraction fallback: if capture loaded the page (trace.success)
    // but found no useful endpoints, try extracting content directly from the DOM.
    if (trace.success && context?.url) {
      try {
        console.log("[dom-fallback] capture found no endpoints — attempting eval-based DOM extraction");
        await kuri.start().catch(() => {});
        const evalTabId = await kuri.newTab(context.url).catch(() => "");
        if (evalTabId) {
          try {
            // Inject cookies for auth
            const evalDomain = new URL(context.url).hostname.replace(/^www\./, "");
            try {
              const { extractBrowserCookies } = await import("../auth/browser-cookies.js");
              const { cookies: evalCookies } = extractBrowserCookies(evalDomain);
              for (const cookie of evalCookies) await kuri.setCookie(evalTabId, cookie).catch(() => {});
            } catch { /* non-fatal */ }

            // Wait for page to load
            await kuri.waitForLoad(evalTabId, 10_000).catch(() => {});

            // Extract page content via eval
            const rawContent = await kuri.evaluate(evalTabId, "document.body.innerText.substring(0, 10000)");
            const extractedText = typeof rawContent === "string" ? rawContent : String(rawContent ?? "");

            // Only offer page_fetch on REAL content. An anti-bot interstitial (Cloudflare
            // "Just a moment…") also yields >200 chars of innerText — minting a page_fetch
            // endpoint for it would be FALSE coverage (execute would return the interstitial,
            // not data). When blocked, skip → fall through to the camoufox rescue below.
            if (extractedText.length > 200 && !looksBlocked(extractedText, 200)) {
              const rawTitle = await kuri.evaluate(evalTabId, "document.title").catch(() => "");
              const pageTitle = typeof rawTitle === "string" ? rawTitle : String(rawTitle ?? "");
              const rawUrl = await kuri.getCurrentUrl(evalTabId).catch(() => context.url!);
              // Validate URL starts with http (guard against [object Object])
              const pageUrl = typeof rawUrl === "string" && rawUrl.startsWith("http") ? rawUrl : context.url!;

              console.log(`[dom-fallback] extracted ${extractedText.length} chars from DOM (title: "${pageTitle.slice(0, 60)}")`);

              const evalTrace: ExecutionTrace = {
                trace_id: nanoid(),
                skill_id: "dom-extraction",
                endpoint_id: "eval-fallback",
                started_at: trace.started_at,
                completed_at: new Date().toISOString(),
                success: true,
              };
              // Structural floor (substrate-faithful): the page rendered and has
              // real content but no replayable API endpoint survived RE. Surface the
              // page_fetch DOM-extraction endpoint as a SELECTABLE shortlist entry —
              // the same `buildPageFetchEndpoint` primitive the cached-skill fallback
              // (resolve deferral) and the vendor-block artifact path already use.
              // Without this, resolve returned the extracted content as a bare blob
              // with an EMPTY available_endpoints, so `explain` showed no shortlist
              // (zero coverage) for server-rendered / SPA pages that genuinely HAVE a
              // usable capability. One structural endpoint per page, no per-host arms.
              const pageFetchEp = buildPageFetchEndpoint(pageUrl, queryIntent);
              const pageFetchShortlist = [{
                endpoint_id: pageFetchEp.endpoint_id,
                source_skill_id: captureSkill!.skill_id,
                method: pageFetchEp.method,
                url: pageFetchEp.url_template,
                url_template: pageFetchEp.url_template,
                description: pageFetchEp.description,
                score: 1, // positive: a genuinely-callable structural endpoint exists
                dom_extraction: pageFetchEp.dom_extraction,
                trigger_url: pageUrl,
                agent_warning:
                  "page_fetch fallback (structural floor): no replayable API endpoint on this page; " +
                  "execute fetches the rendered page + extracts the structured DOM content inline.",
              }];
              const evalResult = {
                status: "dom_extraction",
                message: "No API endpoints found; page content extracted from DOM and a page_fetch endpoint is offered.",
                content: extractedText,
                title: pageTitle,
                url: pageUrl,
                available_endpoints: pageFetchShortlist,
                available_operations: pageFetchShortlist,
                shortlist_for_judgment: pageFetchShortlist,
              };

              recordRoutingStep("dom-fallback", captureSkill, evalTrace, evalResult, {
                candidateCount: 1,
                selectedEndpointId: pageFetchEp.endpoint_id,
                userOverride: false,
                requiredRecovery: false,
              });

              await kuri.closeTab(evalTabId).catch(() => {});

              return {
                result: evalResult,
                trace: evalTrace,
                source: "dom-fallback",
                skill: captureSkill!,
                timing: finalize("dom-fallback", evalResult, undefined, undefined, evalTrace),
              };
            }
            console.log(`[dom-fallback] extracted content too short (${extractedText.length} chars) — skipping`);
            await kuri.closeTab(evalTabId).catch(() => {});
          } catch {
            await kuri.closeTab(evalTabId).catch(() => {});
          }
        }
      } catch (evalError) {
        console.warn("[dom-fallback] eval extraction failed:", evalError instanceof Error ? evalError.message : String(evalError));
      }
    }

    // Camoufox escalation (interstitial case): the cheap capture reached the page but it
    // was an anti-bot interstitial — and a Cloudflare "Just a moment…" page sets
    // trace.success=TRUE, so the !trace.success rescue ladder above was skipped. camoufox
    // (stealth Firefox + solve_cloudflare) clears the JS challenge where Kuri's Chrome and
    // curl_cffi cannot. Only fires when the captured page LOOKS BLOCKED / empty, so reachable
    // no-API pages (npm, lobste.rs — handled in the isDirectDomResult branch) are unaffected
    // and not slowed. Direct first (the stealth fingerprint, not the IP, clears CF; the proxy
    // IP is often itself flagged), proxy fallback for geo/IP-gated sites. null → degrade
    // honestly (NO page_fetch minted for an interstitial).
    if (context?.url) {
      const capturedText = (() => {
        if (typeof result === "string") return result;
        if (result && typeof result === "object") {
          const rec = result as Record<string, unknown>;
          const parts = [rec.content, rec.html, rec.body].filter((v) => typeof v === "string") as string[];
          return parts.length ? parts.join("\n") : JSON.stringify(rec);
        }
        return "";
      })();
      if (!trace.success || looksBlocked(capturedText, 512)) {
        try {
          let camo = await tryCamoufoxFetch({ url: context.url, timeoutMs: 90_000, forceDirect: true });
          if (!(camo?.html && camo.html.length > 1024) && resolveEgressProxy()) {
            camo = await tryCamoufoxFetch({ url: context.url, timeoutMs: 90_000 });
          }
          if (camo?.html && camo.html.length > 1024 && !looksBlocked(camo.html, 1024)) {
            const camoArtifact = buildPageArtifactCapture(context.url, queryIntent, camo.html, false);
            if (camoArtifact.endpoint && camoArtifact.result) {
              console.log(`[orchestrator] camoufox_success: ${camo.html.length} bytes (cleared interstitial in dom-fallback path)`);
              const camoTrace: ExecutionTrace = {
                trace_id: nanoid(),
                skill_id: captureSkill!.skill_id,
                endpoint_id: camoArtifact.endpoint.endpoint_id,
                started_at: trace.started_at,
                completed_at: new Date().toISOString(),
                success: true,
                decision_trace: [{ step: "camoufox_success", html_bytes: camo.html.length }],
              };
              recordRoutingStep("live-capture", captureSkill, camoTrace, camoArtifact.result, {
                candidateCount: 1,
                selectedEndpointId: camoArtifact.endpoint.endpoint_id,
                didStepUnlockNextStep: true,
                userOverride: false,
                requiredRecovery: true,
              });
              return {
                result: artifactResultWithShortlist(camoArtifact, captureSkill!.skill_id, context.url),
                trace: camoTrace,
                source: "live-capture",
                skill: captureSkill!,
                timing: finalize("live-capture", camoArtifact.result, captureSkill!.skill_id, captureSkill, camoTrace),
              };
            }
          } else {
            console.log("[orchestrator] camoufox_null (dom-fallback path): helper unavailable / still blocked");
          }
        } catch (camoErr) {
          console.log(`[orchestrator] camoufox_error (dom-fallback path): ${camoErr instanceof Error ? camoErr.message : String(camoErr)}`);
        }
        // Paid x402 web-unblocker — the Cloudflare-class rescue that works on the SHIPPED binary
        // (camoufox above needs the dev-only venv → null on npm install). Auto-engages when a
        // payment method is configured (x402PaymentAvailable); negative-cache-gated, fallback chain.
        try {
          const unlocked = await tryX402UnblockerFetch({ url: context.url, timeoutMs: 240_000 });
          if (unlocked?.html && unlocked.html.length > 1024 && !looksBlocked(unlocked.html, 1024)) {
            const unlockArtifact = buildPageArtifactCapture(context.url, queryIntent, unlocked.html, false);
            if (unlockArtifact.endpoint && unlockArtifact.result) {
              console.log(`[orchestrator] x402_unblocker_success: ${unlocked.html.length} bytes (cleared interstitial via paid residential unblocker)`);
              const unlockTrace: ExecutionTrace = {
                trace_id: nanoid(),
                skill_id: captureSkill!.skill_id,
                endpoint_id: unlockArtifact.endpoint.endpoint_id,
                started_at: trace.started_at,
                completed_at: new Date().toISOString(),
                success: true,
                decision_trace: [{ step: "x402_unblocker_success", html_bytes: unlocked.html.length }],
              };
              recordRoutingStep("live-capture", captureSkill, unlockTrace, unlockArtifact.result, {
                candidateCount: 1,
                selectedEndpointId: unlockArtifact.endpoint.endpoint_id,
                didStepUnlockNextStep: true,
                userOverride: false,
                requiredRecovery: true,
              });
              return {
                result: artifactResultWithShortlist(unlockArtifact, captureSkill!.skill_id, context.url),
                trace: unlockTrace,
                source: "live-capture",
                skill: captureSkill!,
                timing: finalize("live-capture", unlockArtifact.result, captureSkill!.skill_id, captureSkill, unlockTrace),
              };
            }
          } else {
            console.log("[orchestrator] x402_unblocker_null (dom-fallback path): disabled / unavailable / still blocked");
          }
        } catch (unlockErr) {
          console.log(`[orchestrator] x402_unblocker_error (dom-fallback path): ${unlockErr instanceof Error ? unlockErr.message : String(unlockErr)}`);
        }
      }
    }

    recordRoutingStep("live-capture", captureSkill, trace, result, {
      candidateCount: trace.endpoint_id ? 1 : 0,
      selectedEndpointId: trace.endpoint_id,
      userOverride: false,
      requiredRecovery: !trace.success,
    });
    // Bug 4: when live-capture returned with no learned_skill (capture had no
    // extractable endpoints, DOM fallback didn't fire or returned too little),
    // the raw `result` may be an empty object with no error tag. Stamp an
    // error_code so the agent can distinguish silent-empty from "success".
    const liveCaptureResult: unknown = (() => {
      if (trace.success && (result === null || result === undefined)) {
        return { error_code: "capture_returned_empty", message: "live-capture completed but produced no endpoints or page content" };
      }
      if (trace.success && typeof result === "object" && result !== null) {
        const rec = result as Record<string, unknown>;
        const hasOps = Array.isArray(rec.available_operations) && (rec.available_operations as unknown[]).length > 0;
        const hasErr = typeof rec.error === "string" || typeof rec.error_code === "string";
        const hasContent = typeof rec.content === "string" && (rec.content as string).length > 0;
        if (!hasOps && !hasErr && !hasContent) {
          return { ...rec, error_code: "capture_returned_empty" };
        }
      }
      return result;
    })();
    // Structural-floor catch-all: capture REACHED the page (trace.success) but
    // produced no replayable API endpoint AND the DOM-fallback above did not surface
    // a shortlist (eval extraction threw / returned too little). Rather than hand the
    // agent a bare `capture_returned_empty`, offer the page_fetch DOM-extraction
    // endpoint — genuinely callable (execute fetches the rendered page + extracts
    // inline), so resolve reports the real capability instead of zero coverage. Gated
    // on trace.success so a truly-failed/blocked capture still returns honestly empty.
    const liveCaptureWithFloor: unknown = (() => {
      if (!trace.success || !context?.url) return liveCaptureResult;
      const rec = (liveCaptureResult && typeof liveCaptureResult === "object")
        ? (liveCaptureResult as Record<string, unknown>) : {};
      const hasOps = Array.isArray(rec.available_operations) && (rec.available_operations as unknown[]).length > 0;
      const hasEndpoints = Array.isArray(rec.available_endpoints) && (rec.available_endpoints as unknown[]).length > 0;
      if (hasOps || hasEndpoints) return liveCaptureResult;
      // Reached only AFTER camoufox also failed to clear the page. If what we captured is an
      // anti-bot interstitial, do NOT mint a page_fetch endpoint for it — that would be false
      // coverage (execute would just return the interstitial). Return honestly empty instead.
      const capText = typeof rec.content === "string" ? rec.content
        : (typeof rec.html === "string" ? rec.html : JSON.stringify(rec));
      if (looksBlocked(capText, 512)) return liveCaptureResult;
      const pageFetchEp = buildPageFetchEndpoint(context.url, queryIntent);
      const pageFetchShortlist = [{
        endpoint_id: pageFetchEp.endpoint_id,
        source_skill_id: captureSkill!.skill_id,
        method: pageFetchEp.method,
        url: pageFetchEp.url_template,
        url_template: pageFetchEp.url_template,
        description: pageFetchEp.description,
        score: 1,
        dom_extraction: pageFetchEp.dom_extraction,
        trigger_url: context.url,
        agent_warning:
          "page_fetch fallback (structural floor): no replayable API endpoint on this page; " +
          "execute fetches the rendered page + extracts the structured DOM content inline.",
      }];
      const { error_code: _drop, ...keep } = rec;
      return {
        ...keep,
        status: "page_fetch_fallback",
        message: "No replayable API endpoint; offering page_fetch (fetch rendered page + extract inline).",
        available_endpoints: pageFetchShortlist,
        available_operations: pageFetchShortlist,
        shortlist_for_judgment: pageFetchShortlist,
      };
    })();
    return {
      result: liveCaptureWithFloor,
      trace,
      source: "live-capture",
      skill: captureSkill!,
      timing: finalize("live-capture", liveCaptureWithFloor, undefined, undefined, trace),
    };
  }

  // Agent explicitly chose an endpoint — execute directly.
  if (agentChoseEndpoint && learned_skill) {
    const te1 = Date.now();
    const execOut = await executeSkill(learned_skill, params, projection, {
      ...options,
      intent: queryIntent,
      contextUrl: context?.url,
    });
    timing.execute_ms += Date.now() - te1;
    if (execOut.trace.success) {
      promoteLearnedSkill(clientScope, cacheKey, learned_skill, execOut.trace.endpoint_id, context?.url);
      flushRouteCacheSync();
    }
    if (execOut.trace.success && isAcceptableIntentResult(execOut.result, queryIntent)) {
      queuePassivePublishIfExecuted(
        learned_skill,
        {
          result: execOut.result,
          trace: execOut.trace,
          source: "live-capture",
          skill: learned_skill,
          timing: finalize(
            "live-capture",
            execOut.result,
            learned_skill.skill_id,
            learned_skill,
            execOut.trace,
          ),
        },
        parityBaseline,
      );
    }
    if (execOut.trace.success && isAcceptableIntentResult(execOut.result, queryIntent)) {
      promoteResultSnapshot(
        cacheKey,
        learned_skill,
        execOut.trace.endpoint_id,
        execOut.result,
        execOut.trace,
      );
    }
    const chosenStepIndex = recordRoutingCandidates(
      learned_skill,
      [{
        endpoint:
          learned_skill.endpoints.find((endpoint) => endpoint.endpoint_id === execOut.trace.endpoint_id) ??
          learned_skill.endpoints[0],
        score: 1,
      }],
      "live-capture",
      { selectedEndpointId: execOut.trace.endpoint_id },
    );
    recordRoutingStep("live-capture", learned_skill, execOut.trace, execOut.result, {
      stepIndex: chosenStepIndex,
      selectedEndpointId: execOut.trace.endpoint_id,
      candidateCount: 1,
      userOverride: true,
      requiredRecovery: !execOut.trace.success,
    });
    return {
      result: execOut.result,
      trace: execOut.trace,
      source: "live-capture",
      skill: learned_skill,
      timing: finalize(
        "live-capture",
        execOut.result,
        learned_skill.skill_id,
        learned_skill,
        execOut.trace,
      ),
    };
  }
  const deferred = await buildDeferralWithAutoExec(
    learned_skill!,
    "live-capture",
    authRecommended
      ? {
          auth_recommended: true,
          auth_hint: captureResult!.auth_hint,
        }
      : undefined,
  );
  // Promote to route + domain cache so subsequent resolves hit cache instead of re-capturing
  promoteLearnedSkill(
    clientScope,
    cacheKey,
    learned_skill!,
    deferred.orchestratorResult.trace.endpoint_id || undefined,
    context?.url,
  );
  flushRouteCacheSync();
  queuePassivePublishIfExecuted(learned_skill, deferred.orchestratorResult, parityBaseline);
  upsertDagEdgesFromOperationGraph(learned_skill!);
  return deferred.orchestratorResult;
}

export async function getOrCreateBrowserCaptureSkill(): Promise<SkillManifest> {
  const existing = await getSkill(BROWSER_CAPTURE_SKILL_ID);
  if (existing) return existing;

  const now = new Date().toISOString();
  const skill: SkillManifest = {
    skill_id: BROWSER_CAPTURE_SKILL_ID,
    version: "1.0.0",
    schema_version: "1",
    name: "Browser Capture",
    intent_signature: "capture and learn API endpoints from a URL",
    domain: "agent",
    description:
      "Meta-skill: launches a headless browser, records HAR, reverse-engineers API endpoints, and publishes a new skill to the marketplace.",
    owner_type: "agent",
    execution_type: "browser-capture",
    endpoints: [],
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  };

  await publishSkill(skill).catch((err) =>
    console.error("[publish] browser-capture skill update failed:", (err as Error).message),
  );
  return skill;
}

/** Reject skills where no endpoint returns structured data or a replayable canonical document route. */
export function hasUsableEndpoints(skill: SkillManifest): boolean {
  if (!skill.endpoints || skill.endpoints.length === 0) return false;
  return skill.endpoints.some((ep) => {
    try {
      const u = new URL(ep.url_template);
      const onDomain = u.hostname === skill.domain || u.hostname.endsWith(`.${skill.domain}`) ||
        getRegistrableDomain(u.hostname) === getRegistrableDomain(skill.domain) ||
        isSameBrandDomain(u.hostname, skill.domain);
      if (!onDomain) return false;
      // Must have a response schema (JSON), DOM extraction, or be an API-style path.
      // API-style detection covers:
      //   /api/        — explicit api segment (beatsaver, many REST APIs)
      //   /youtubei/   — YouTube internal RPC API
      //   /graphql     — GraphQL endpoints
      //   /v1/ /v2/ … — versioned REST APIs (e.g. /v1/users, /v2/search)
      //   /i/api/      — X.com internal API prefix
      const isApiPath =
        /\/api\b/i.test(u.pathname) ||
        /\/youtubei\b/i.test(u.pathname) ||
        /\/graphql\b/i.test(u.pathname) ||
        /\/v\d+\b/i.test(u.pathname);
      return !!ep.response_schema || isApiPath || !!ep.dom_extraction;
    } catch {
      return false;
    }
  });
}

/** Generate a local heuristic description for an endpoint so BM25 can work immediately. */
export function generateLocalDescription(ep: import("../types/index.js").EndpointDescriptor): string {
  let id = "";
  try {
    const u = new URL(ep.url_template);
    // GraphQL: extract operation name from path (/graphql/HASH/OperationName)
    const graphqlMatch = u.pathname.match(/\/graphql\/\w+\/(\w+)/);
    if (graphqlMatch) id = graphqlMatch[1];
    // GraphQL: queryId param
    if (!id) {
      const qid = u.searchParams.get("queryId") ?? "";
      const qidMatch = qid.match(/^([a-zA-Z]+)\./);
      if (qidMatch) id = qidMatch[1];
    }
    // REST: last meaningful path segment (skip hashes, {params}, version prefixes)
    if (!id) {
      const segs = u.pathname
        .split("/")
        .filter((s) => s.length > 1 && !s.startsWith("{") && !/^v\d+$/.test(s) && !/^[a-zA-Z0-9_-]{20,}$/.test(s));
      id = segs[segs.length - 1] ?? u.pathname;
    }
  } catch {
    id = ep.url_template.slice(0, 60);
  }

  // Split camelCase to words
  const words = id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase()
    .replace(/^(voyager|api|graphql|dash)\s+/g, "")
    .replace(/\b(voyager|dash|graphql)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Schema keys for context
  const keys: string[] = [];
  if (ep.response_schema?.properties) {
    for (const [k, v] of Object.entries(ep.response_schema.properties)) {
      const sub = v as { properties?: Record<string, unknown> };
      if (sub?.properties) {
        keys.push(`${k}:{${Object.keys(sub.properties).slice(0, 4).join(",")}}`);
      } else {
        keys.push(k);
      }
    }
  }
  const keysStr = keys.slice(0, 8).join(", ");
  const core = words || "endpoint";
  const base = keysStr ? `Returns ${core} data. fields: ${keysStr}` : `Returns ${core} data`;
  const constraints = extractHeuristicConstraints(ep);
  return constraints.length > 0 ? `${base}. constraints: ${constraints.join("; ")}` : base;
}

function extractHeuristicConstraints(
  ep: import("../types/index.js").EndpointDescriptor,
): string[] {
  const snippets: string[] = [];
  const push = (value: string | undefined): void => {
    if (!value) return;
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) return;
    snippets.push(text);
  };

  push(decodeURIComponentSafe(ep.url_template));
  push(stringifyForHeuristics(ep.query));
  push(stringifyForHeuristics(ep.path_params));
  push(stringifyForHeuristics(ep.body_params));
  push(stringifyForHeuristics(ep.body));
  push(ep.semantic?.description_in);
  push(ep.semantic?.description_out);
  push(ep.semantic?.response_summary);
  collectHeuristicStrings(ep.semantic?.example_request, snippets);
  collectHeuristicStrings(ep.semantic?.example_response_compact, snippets);
  collectSchemaDescriptions(ep.response_schema, snippets);

  const haystack = snippets.join(" ").toLowerCase();
  if (!haystack) return [];

  const constraints: string[] = [];
  const add = (hint: string): void => {
    if (!constraints.includes(hint)) constraints.push(hint);
  };

  if (
    /\bonly applicable to non-residents?(?: of singapore)?\b|\bnon-residents? of singapore\b|\badult \(non-resident\)\b/.test(
      haystack,
    )
  ) {
    add("non-resident only");
  } else if (
    /\blocal residents? exclusive\b|\bsingapore residents? exclusive\b|\badult \(resident\)\b|\bresident rate\b|\bresident pricing\b/.test(
      haystack,
    )
  ) {
    add("resident pricing");
  }

  if (/\bwildpass\b/.test(haystack)) add("WildPass pricing");

  const validityMatch = haystack.match(/\bvalid for(?: up to)? (\d+)[-\s]?days?\b/) ??
    haystack.match(/\b(\d+)[-\s]?day(?:\b|s\b)/);
  if (validityMatch?.[1]) add(`valid for ${validityMatch[1]} days`);

  if (/\bone[-\s]?time access\b|\bone[-\s]?entry\b/.test(haystack)) add("one-time entry");

  const parks = [
    ["night safari", "Night Safari"],
    ["bird paradise", "Bird Paradise"],
    ["river wonders", "River Wonders"],
    ["singapore zoo", "Singapore Zoo"],
    ["rainforest wild asia", "Rainforest Wild ASIA"],
  ].filter(([token]) => haystack.includes(token)).map(([, label]) => label);
  if (parks.length >= 2 && parks.length <= 3) add(`includes ${parks.join(" + ")}`);

  return constraints;
}

function collectHeuristicStrings(value: unknown, out: string[], depth = 0): void {
  if (value == null || depth > 4 || out.length >= 32) return;
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) collectHeuristicStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>).slice(0, 12)) {
      collectHeuristicStrings(entry, out, depth + 1);
    }
  }
}

function collectSchemaDescriptions(
  schema: import("../types/index.js").ResponseSchema | undefined,
  out: string[],
  depth = 0,
): void {
  if (!schema || depth > 4 || out.length >= 32) return;
  if (schema.description) out.push(schema.description);
  if (schema.properties) {
    for (const child of Object.values(schema.properties).slice(0, 12)) {
      collectSchemaDescriptions(child, out, depth + 1);
    }
  }
  if (schema.items) collectSchemaDescriptions(schema.items, out, depth + 1);
  if (schema.anyOf) {
    for (const child of schema.anyOf.slice(0, 6)) collectSchemaDescriptions(child, out, depth + 1);
  }
}

function stringifyForHeuristics(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractSkillId(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { skill_id?: string };
    return content.skill_id ?? null;
  } catch {
    return null;
  }
}

function extractEndpointId(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { endpoint_id?: string };
    return content.endpoint_id ?? null;
  } catch {
    return null;
  }
}

function extractDomain(metadata: Record<string, unknown>): string | null {
  try {
    const content = JSON.parse(metadata.content as string) as { domain?: string };
    return typeof content.domain === "string" ? content.domain : null;
  } catch {
    return null;
  }
}

export function selectSkillIdsToHydrate(
  candidates: Array<{ metadata: Record<string, unknown> }>,
  requestedDomain?: string | null,
  limit = MARKETPLACE_HYDRATE_LIMIT,
): string[] {
  const prioritizedCandidates = [
    ...candidates.filter((candidate) => {
      if (!requestedDomain) return false;
      try {
        const endpointDomain = extractDomain(candidate.metadata);
        return !!endpointDomain && getRegistrableDomain(endpointDomain) === getRegistrableDomain(requestedDomain);
      } catch {
        return false;
      }
    }),
    ...candidates.filter((candidate) => {
      if (!requestedDomain) return true;
      try {
        const endpointDomain = extractDomain(candidate.metadata);
        return !endpointDomain || getRegistrableDomain(endpointDomain) !== getRegistrableDomain(requestedDomain);
      } catch {
        return true;
      }
    }),
  ];
  return [...new Set(prioritizedCandidates.map((c) => extractSkillId(c.metadata)).filter((value): value is string => !!value))].slice(0, limit);
}
