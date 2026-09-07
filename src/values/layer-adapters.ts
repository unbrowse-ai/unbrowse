/**
 * layer-adapters — wrap existing unbrowse caches as SemanticLayer altitudes.
 *
 * Does not replace resolution-cache / execute-result-cache / failure-cache —
 * it presents them as the same SemanticLayer contract walkLayers expects.
 *
 * Production ladder (cheapest first):
 *   failure-skip (prefilter) → process resolution (warm) → execute TTL →
 *   free rescue act → paid rescue act → browser act
 *
 * act_hooks_bind: expensive acts warm the process-shared resolution layer so the
 * next walk hits free altitude instead of re-arming paid/browser egress.
 *
 * Semantic paraphrase cache stays on the Worker (backend/services/semantic-cache.ts);
 * CLI process uses exact keys + optional in-memory semantic via memorySemanticLayer.
 */

import {
  DEFAULT_LAYER_COSTS,
  cosineSimilarity,
  memorySemanticLayer,
  walkLayers,
  type LayerQuery,
  type SemanticLayer,
  type WalkResult,
} from "./semantic-layer-walk.js";
import {
  executeCacheKey,
  getCachedExecuteResult,
  isExecuteResultCacheable,
  setCachedExecuteResult,
  type ExecuteCacheGuard,
  type ExecuteCacheKeyInput,
} from "../execution/execute-result-cache.js";
import { peekFailure } from "./failure-cache.js";
import { isOriginUnreachableError } from "./origin-health.js";

/** Negative prefilter: true when failure-cache says skip this target+egress. */
export function shouldSkipFailedTarget(target: string, egress = "default"): boolean {
  try {
    return peekFailure(target, egress) != null;
  } catch {
    return false;
  }
}

/**
 * Execute-result TTL cache as a SemanticLayer.
 * Query context must carry skillId, endpointId, params for the key;
 * act() is the live executor the caller injects.
 */
export function executeResultLayer<T>(opts: {
  id?: string;
  cost?: number;
  keyInput: (query: LayerQuery) => ExecuteCacheKeyInput | null;
  guard?: (query: LayerQuery, value: T) => ExecuteCacheGuard;
  act?: (query: LayerQuery) => Promise<T | null> | T | null;
  settled?: SemanticLayer<T>["settled"];
}): SemanticLayer<T> {
  const id = opts.id ?? "execute";
  const cost = opts.cost ?? DEFAULT_LAYER_COSTS.execute;

  return {
    id,
    cost,
    settled: opts.settled,
    get(query) {
      const input = opts.keyInput(query);
      if (!input) return null;
      const key = executeCacheKey(input);
      const value = getCachedExecuteResult<T>(key);
      if (value === undefined) return null;
      return { value, via: "hit", score: 1 };
    },
    put(query, value) {
      const input = opts.keyInput(query);
      if (!input) return;
      const guard = opts.guard?.(query, value) ?? {
        success: true,
        method: "GET",
        hasAuth: false,
        hasSession: false,
        dryRun: false,
      };
      if (!isExecuteResultCacheable(guard)) return;
      setCachedExecuteResult(executeCacheKey(input), value);
    },
    act: opts.act,
  };
}

/**
 * In-process resolution layer (exact + optional embedding).
 * For disk-backed resolution use cachedResolution at the call site and put into
 * this layer, or pass act that calls cachedResolution.
 */
export function resolutionMemoryLayer<T>(opts?: {
  id?: string;
  cost?: number;
  threshold?: number;
  act?: SemanticLayer<T>["act"];
  settled?: SemanticLayer<T>["settled"];
}): SemanticLayer<T> & { store: Map<string, { value: T; embedding?: number[] }> } {
  return memorySemanticLayer<T>({
    id: opts?.id ?? "resolution",
    cost: opts?.cost ?? DEFAULT_LAYER_COSTS.resolution,
    threshold: opts?.threshold,
    act: opts?.act,
    settled: opts?.settled,
  });
}

// ── Process-shared resolution (act_hooks_bind warm path) ───────────────────

type ProcessResolutionEntry = { value: unknown; embedding?: number[] };

/** Shared across walkCapabilityLayers calls in this process (not disk). */
const processResolutionStore = new Map<string, ProcessResolutionEntry>();

function resolutionExactKey(q: LayerQuery): string {
  return (q.key?.trim() || q.intent.trim().toLowerCase());
}

/** Test isolation: clear process-warm resolution entries. */
export function _clearProcessResolutionForTests(): void {
  processResolutionStore.clear();
}

/**
 * Process-shared resolution altitude. Survives across walkCapabilityLayers calls
 * so a free/paid/browser act can warm the next walk without re-egress.
 */
export function processResolutionLayer<T>(opts?: {
  settled?: SemanticLayer<T>["settled"];
  threshold?: number;
}): SemanticLayer<T> {
  const threshold = opts?.threshold ?? 0.8;
  return {
    id: "resolution",
    cost: DEFAULT_LAYER_COSTS.resolution,
    settled: opts?.settled,
    get(query) {
      const k = resolutionExactKey(query);
      const exact = processResolutionStore.get(k);
      if (exact) return { value: exact.value as T, via: "hit" as const, score: 1 };

      const emb = query.embedding;
      if (!emb || emb.length === 0) return null;
      let best: { value: T; score: number } | null = null;
      for (const entry of processResolutionStore.values()) {
        if (!entry.embedding) continue;
        const score = cosineSimilarity(emb, entry.embedding);
        if (score >= threshold && (!best || score > best.score)) {
          best = { value: entry.value as T, score };
        }
      }
      return best ? { value: best.value, via: "hit" as const, score: best.score } : null;
    },
    put(query, value) {
      processResolutionStore.set(resolutionExactKey(query), {
        value,
        embedding: query.embedding ? [...query.embedding] : undefined,
      });
    },
  };
}

export interface ActHooks<T> {
  /** Free anti-bot / impersonate / proxy / camoufox. */
  rescueFree?: (query: LayerQuery) => Promise<T | null> | T | null;
  /** Paid unlock / Capzy. */
  rescuePaid?: (query: LayerQuery) => Promise<T | null> | T | null;
  /** Deep browser capture. */
  browser?: (query: LayerQuery) => Promise<T | null> | T | null;
  /** Live execute of a known route (marketplace / skill endpoint). */
  execute?: (query: LayerQuery) => Promise<T | null> | T | null;
  settled?: SemanticLayer<T>["settled"];
  /** Skip targets still cooling down in failure-cache. */
  failureEgress?: string;
  /**
   * When false, use ephemeral (non-shared) resolution — for isolated unit tests.
   * Default true: process-shared warm path (act_hooks_bind).
   */
  sharedResolution?: boolean;
}

function isActSettled<T>(
  settled: SemanticLayer<T>["settled"] | undefined,
  query: LayerQuery,
  value: T,
): boolean {
  if (settled) return settled(query, value);
  // Default: soft-ok quality gate (soft-green never warms / never hard-settles).
  return softOkQualityScore(value) >= 1;
}

/** Default settled predicate for capability walks — soft-green markers score 0. */
export function defaultActSettled<T>(_query: LayerQuery, value: T): boolean {
  return softOkQualityScore(value) >= 1;
}

/**
 * Bind ActHooks so successful expensive acts warm the process resolution layer.
 * Cost order free → paid → browser is unchanged; only the post-settle put is added.
 * Soft-green values (settled() false) never warm.
 */
export function bindActHooks<T>(hooks: ActHooks<T>): ActHooks<T> {
  if (hooks.sharedResolution === false) return hooks;

  const warm = (query: LayerQuery, value: T): void => {
    try {
      processResolutionLayer<T>({ settled: hooks.settled }).put?.(query, value);
    } catch {
      /* fail-open: walk result is authoritative; warm is best-effort */
    }
  };

  const wrapAct = (
    act: ((query: LayerQuery) => Promise<T | null> | T | null) | undefined,
  ): ((query: LayerQuery) => Promise<T | null>) | undefined => {
    if (!act) return undefined;
    return async (q) => {
      const v = await Promise.resolve(act(q));
      if (v != null && isActSettled(hooks.settled, q, v)) {
        warm(q, v);
      }
      return v;
    };
  };

  return {
    ...hooks,
    execute: wrapAct(hooks.execute),
    rescueFree: wrapAct(hooks.rescueFree),
    rescuePaid: wrapAct(hooks.rescuePaid),
    browser: wrapAct(hooks.browser),
  };
}

/**
 * Build the production-shaped layer stack for a capability walk.
 * Only layers with a provided act (or always-on caches) are included.
 * Callers should pass hooks through bindActHooks (walkCapabilityLayers does this).
 */
export function buildCapabilityLayers<T>(hooks: ActHooks<T> = {}): SemanticLayer<T>[] {
  const layers: SemanticLayer<T>[] = [];
  // Soft-ok quality is the default settle gate so soft live-capture shells
  // never stamp process resolution unless the caller overrides settled().
  const settled = hooks.settled ?? defaultActSettled;
  const shared = hooks.sharedResolution !== false;

  // L1 resolution — process-shared by default so act warm survives the next walk
  layers.push(
    shared
      ? processResolutionLayer<T>({ settled })
      : resolutionMemoryLayer<T>({ settled }),
  );

  // L3 execute cache + optional live execute
  layers.push(
    executeResultLayer<T>({
      settled,
      keyInput: (q) => {
        const skillId = typeof q.context?.skillId === "string" ? q.context.skillId : "";
        const endpointId = typeof q.context?.endpointId === "string" ? q.context.endpointId : "";
        if (!skillId || !endpointId) return null;
        const params =
          q.context?.params && typeof q.context.params === "object"
            ? (q.context.params as Record<string, unknown>)
            : {};
        return { skillId, endpointId, params };
      },
      act: hooks.execute,
    }),
  );

  if (hooks.rescueFree) {
    layers.push({
      id: "rescue_free",
      cost: DEFAULT_LAYER_COSTS.rescue_free,
      settled,
      get: () => null,
      act: hooks.rescueFree,
    });
  }
  if (hooks.rescuePaid) {
    layers.push({
      id: "rescue_paid",
      cost: DEFAULT_LAYER_COSTS.rescue_paid,
      settled,
      get: () => null,
      act: hooks.rescuePaid,
    });
  }
  if (hooks.browser) {
    layers.push({
      id: "browser",
      cost: DEFAULT_LAYER_COSTS.browser,
      settled,
      get: () => null,
      act: hooks.browser,
    });
  }

  return layers;
}

/**
 * Full capability walk: failure prefilter → bindActHooks → walkLayers.
 * Expensive acts warm process resolution for the next walk (free before paid).
 */
export async function walkCapabilityLayers<T>(
  query: LayerQuery,
  hooks: ActHooks<T> = {},
  opts: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<WalkResult<T> & { skippedFailure?: boolean }> {
  const target =
    (typeof query.context?.url === "string" && query.context.url) ||
    (typeof query.context?.target === "string" && query.context.target) ||
    query.key ||
    "";
  if (target && shouldSkipFailedTarget(target, hooks.failureEgress ?? "default")) {
    return {
      ok: false,
      costPaid: 0,
      path: [{ layer: "failure_cache", cost: 0, outcome: "reject" }],
      skippedFailure: true,
    };
  }
  const bound = bindActHooks(hooks);
  const layers = buildCapabilityLayers(bound);
  return walkLayers(layers, query, opts);
}

/** HTML payload from a free/paid/browser rung before document acceptance. */
export interface EscalationHtml {
  html: string;
  via: string;
  bytes: number;
}

/** Settled escalation value: accepted document + provenance. */
export interface DocumentEscalationValue<TDoc> {
  document: TDoc;
  via: string;
  bytes: number;
}

export interface DocumentEscalationHooks<TDoc> {
  /** Free rungs: impersonate / proxy / camoufox — never paid egress. */
  freeHtml: (query: LayerQuery) => Promise<EscalationHtml | null> | EscalationHtml | null;
  /** Paid rungs: x402 / Capzy — only after free miss. */
  paidHtml?: (query: LayerQuery) => Promise<EscalationHtml | null> | EscalationHtml | null;
  /** Deep browser capture — last resort. */
  browserHtml?: (query: LayerQuery) => Promise<EscalationHtml | null> | EscalationHtml | null;
  /**
   * Convert raw HTML into an accepted document, or null to reject and continue
   * the walk (e.g. still interstitial / thin after render).
   */
  accept: (
    html: string,
    via: string,
    bytes: number,
    query: LayerQuery,
  ) => Promise<TDoc | null> | TDoc | null;
  failureEgress?: string;
}

/**
 * Soft-ok quality score for settle candidates.
 * 0 = soft-green (rejected / task_ok:false / empty) — never warm, never strict-ok.
 * 1 = hard usable settle (no soft-fail markers).
 *
 * Used by documentEscalationSettled and bindActHooks so soft live-capture
 * shells do not stamp process resolution or count as a free residual win.
 */
export function softOkQualityScore(value: unknown): number {
  if (value == null) return 0;
  if (typeof value !== "object") return 1;
  const v = value as {
    rejected?: unknown;
    task_ok?: unknown;
    document?: unknown;
    error?: unknown;
    ok?: unknown;
  };
  // Nested DocumentEscalationValue
  if ("document" in v && v.document !== undefined) {
    return softOkQualityScore(v.document);
  }
  if (v.rejected === true) return 0;
  if (v.task_ok === false) return 0;
  // Explicit ok:false is soft (never warm / never strict-ok).
  if (v.ok === false) return 0;
  if (typeof v.error === "string" && v.error.trim()) {
    const err = v.error.toLowerCase();
    // Aligned with bench/sites100/strict_ok.py SOFT_FAIL_ERR (structural markers).
    if (
      err.includes("no_endpoints") ||
      err.includes("no relevant endpoint") ||
      err.includes("no_json") ||
      err.includes("datadome") ||
      err.includes("challenge") ||
      err.includes("interstitial") ||
      // Dead-origin markers share ONE definition with the browser-fallback
      // decision (values/origin-health.ts) so the two cannot drift apart.
      isOriginUnreachableError(err) ||
      err.includes("cli_timeout") ||
      err.includes("cli_empty") ||
      err.includes("connection_failed")
    ) {
      return 0;
    }
  }
  return 1;
}

/**
 * Soft-green verdict gate for document-shaped settle values.
 * Rejects explicit rejected / task_ok:false documents so partial shape
 * mismatches do not warm the process resolution layer or count as a hard win.
 */
export function documentEscalationSettled<TDoc>(
  _query: LayerQuery,
  value: DocumentEscalationValue<TDoc>,
): boolean {
  return softOkQualityScore(value) >= 1;
}

/**
 * Orchestrator-facing document escalation walk (N2b).
 * free → paid → browser via walkCapabilityLayers; settle only when accept()
 * returns a non-soft-green document (task_ok !== false, rejected !== true).
 */
export async function walkDocumentEscalationLayers<TDoc>(
  query: LayerQuery,
  hooks: DocumentEscalationHooks<TDoc>,
  opts: { deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<WalkResult<DocumentEscalationValue<TDoc>> & { skippedFailure?: boolean }> {
  const wrap = (
    act: ((q: LayerQuery) => Promise<EscalationHtml | null> | EscalationHtml | null) | undefined,
  ): ActHooks<DocumentEscalationValue<TDoc>>["rescueFree"] => {
    if (!act) return undefined;
    return async (q) => {
      const raw = await Promise.resolve(act(q));
      if (!raw?.html) return null;
      const document = await Promise.resolve(hooks.accept(raw.html, raw.via, raw.bytes, q));
      if (document == null) return null;
      // Soft-green gate at the act boundary (softOkQualityScore + settled).
      if (softOkQualityScore(document) < 1) return null;
      return { document, via: raw.via, bytes: raw.bytes };
    };
  };

  return walkCapabilityLayers<DocumentEscalationValue<TDoc>>(query, {
    failureEgress: hooks.failureEgress,
    rescueFree: wrap(hooks.freeHtml),
    rescuePaid: wrap(hooks.paidHtml),
    browser: wrap(hooks.browserHtml),
    settled: documentEscalationSettled,
  }, opts);
}
