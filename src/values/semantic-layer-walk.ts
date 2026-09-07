/**
 * semantic-layer-walk — "TSP for unbrowse" without the wrong classical algorithm.
 *
 * Paper (crypto-was-all-you-needed): resolve→execute→fallback is Dijkstra over a
 * tree of nodes with edge weight = compute cost; stop at the first settled
 * witness. Each altitude is a Docker-style layer: HIT replays, MISS rebuilds
 * and memoizes. Classic TSP (visit every city, return home) is the wrong
 * single-intent shape — you want first settle, not a tour of every layer.
 *
 * Two walks this module owns:
 *
 *   1. walkLayers (Dijkstra / cheapest-first ladder)
 *      layers are semantic KV altitudes sorted by cost; probe cheap→expensive;
 *      return on first settled hit or successful act; put warms the layer.
 *
 *   2. orderTour (ATSP-family for multi-hop composition)
 *      when several nodes must be visited (operation_graph bindings), order
 *      them as a cheapest tour under a pairwise cost — the residual "TSP"
 *      intuition. Greedy nearest-neighbour + optional 2-opt; exact held-Karp
 *      only for tiny N. Not the resolve ladder.
 *
 * Reuse, do not replace: resolution-cache, execute-result-cache, backend
 * semantic-cache, skill-contract-cache, failure-cache — wrap them as
 * SemanticLayer adapters. This file is the walk + contracts only.
 */

/** Query folded into every layer key. Callers own domain/intent semantics. */
export interface LayerQuery {
  intent: string;
  /** Exact or content key (sha/domain/endpoint). Semantic layers may ignore. */
  key?: string;
  /** Optional dense vector for cosine semantic hit. */
  embedding?: readonly number[];
  /** Free-form context the layer may use (url, domain, principal…). */
  context?: Record<string, unknown>;
}

export interface LayerHit<T> {
  value: T;
  /** How the value was obtained. */
  via: "hit" | "act";
  /** Cosine similarity when the layer is semantic (1 = exact). */
  score?: number;
}

/**
 * One altitude of the stack, memoized as (exact or semantic) KV.
 * cost = edge weight into this layer (USD-proxy or ms-proxy — same units across layers).
 */
export interface SemanticLayer<T> {
  id: string;
  /** Fixed probe cost. Lower runs first in walkLayers. */
  cost: number;
  get(query: LayerQuery): Promise<LayerHit<T> | null> | LayerHit<T> | null;
  /** Optional warm after settle. Fail-open if absent. */
  put?(query: LayerQuery, value: T): Promise<void> | void;
  /** Optional rebuild on miss (Docker layer rebuild). */
  act?(query: LayerQuery): Promise<T | null> | T | null;
  /** Default: non-null value settles. Override for structural gates. */
  settled?(query: LayerQuery, value: T): boolean;
}

export interface WalkStep {
  layer: string;
  cost: number;
  outcome: "hit" | "act" | "miss" | "reject";
  score?: number;
}

export interface WalkResult<T> {
  ok: boolean;
  value?: T;
  layer?: string;
  via?: "hit" | "act";
  /** Total cost of probes attempted (including misses). */
  costPaid: number;
  path: WalkStep[];
}

function isSettled<T>(layer: SemanticLayer<T>, query: LayerQuery, value: T): boolean {
  if (layer.settled) return layer.settled(query, value);
  return value != null;
}

/**
 * Cheapest-first walk over semantic-KV layers (paper Dijkstra instance).
 * Layers are sorted by ascending cost; first settled hit/act wins.
 * Does NOT visit every layer — that would be TSP, which is wrong here.
 */
export async function walkLayers<T>(
  layers: readonly SemanticLayer<T>[],
  query: LayerQuery,
  opts: { warmOnAct?: boolean; deadlineAt?: number; signal?: AbortSignal } = {},
): Promise<WalkResult<T>> {
  const warmOnAct = opts.warmOnAct !== false;
  const ordered = [...layers].sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  const path: WalkStep[] = [];
  let costPaid = 0;

  const deadlineExpired = (): boolean => {
    if (opts.signal?.aborted) return true;
    if (opts.deadlineAt != null && Date.now() >= opts.deadlineAt) return true;
    return false;
  };

  for (const layer of ordered) {
    if (deadlineExpired()) break;
    costPaid += layer.cost;
    const hit = await Promise.resolve(layer.get(query));
    if (hit && isSettled(layer, query, hit.value)) {
      path.push({ layer: layer.id, cost: layer.cost, outcome: "hit", score: hit.score });
      return { ok: true, value: hit.value, layer: layer.id, via: "hit", costPaid, path };
    }
    if (deadlineExpired()) break;

    if (layer.act) {
      if (opts.signal) opts.signal.throwIfAborted?.();
      const rebuilt = await Promise.resolve(layer.act(query));
      if (deadlineExpired()) break;
      if (rebuilt != null && isSettled(layer, query, rebuilt)) {
        path.push({ layer: layer.id, cost: layer.cost, outcome: "act" });
        if (warmOnAct && layer.put) {
          try {
            await Promise.resolve(layer.put(query, rebuilt));
          } catch {
            /* fail-open: walk succeeded; warm is best-effort */
          }
        }
        return { ok: true, value: rebuilt, layer: layer.id, via: "act", costPaid, path };
      }
      path.push({ layer: layer.id, cost: layer.cost, outcome: rebuilt == null ? "miss" : "reject" });
    } else {
      path.push({ layer: layer.id, cost: layer.cost, outcome: "miss" });
    }
  }

  return { ok: false, costPaid, path };
}

/** Cosine similarity in [0,1] for non-zero vectors; 0 if degenerate. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/**
 * In-memory exact+semantic KV layer for tests and local process caches.
 * Exact key hits score 1; embedding nearest-neighbour above threshold is semantic hit.
 */
export function memorySemanticLayer<T>(opts: {
  id: string;
  cost: number;
  threshold?: number;
  act?: SemanticLayer<T>["act"];
  settled?: SemanticLayer<T>["settled"];
}): SemanticLayer<T> & { store: Map<string, { value: T; embedding?: number[] }> } {
  const threshold = opts.threshold ?? 0.8;
  const store = new Map<string, { value: T; embedding?: number[] }>();

  const exactKey = (q: LayerQuery): string =>
    (q.key?.trim() || q.intent.trim().toLowerCase());

  return {
    id: opts.id,
    cost: opts.cost,
    store,
    act: opts.act,
    settled: opts.settled,
    get(query) {
      const k = exactKey(query);
      const exact = store.get(k);
      if (exact) return { value: exact.value, via: "hit" as const, score: 1 };

      const emb = query.embedding;
      if (!emb || emb.length === 0) return null;
      let best: { value: T; score: number } | null = null;
      for (const entry of store.values()) {
        if (!entry.embedding) continue;
        const score = cosineSimilarity(emb, entry.embedding);
        if (score >= threshold && (!best || score > best.score)) {
          best = { value: entry.value, score };
        }
      }
      return best ? { value: best.value, via: "hit" as const, score: best.score } : null;
    },
    put(query, value) {
      store.set(exactKey(query), {
        value,
        embedding: query.embedding ? [...query.embedding] : undefined,
      });
    },
  };
}

// ── Multi-hop tour (the residual TSP) ──────────────────────────────────────

export interface TourNode {
  id: string;
  /** Optional fixed node cost added when the node is visited. */
  cost?: number;
}

/**
 * Order required nodes under pairwise transition costs (asymmetric OK).
 * Greedy nearest-neighbour from `start` (or lowest self-cost). Optional 2-opt
 * polish for Euclidean-ish metrics. Exact TSP is NP-hard; this is the production
 * approximation for operation_graph composition tours.
 */
export function orderTour(
  nodes: readonly TourNode[],
  costBetween: (from: string, to: string) => number,
  opts: { start?: string; twoOpt?: boolean } = {},
): { order: string[]; cost: number } {
  if (nodes.length === 0) return { order: [], cost: 0 };
  if (nodes.length === 1) {
    const only = nodes[0]!;
    return { order: [only.id], cost: only.cost ?? 0 };
  }

  const ids = nodes.map((n) => n.id);
  const self = new Map(nodes.map((n) => [n.id, n.cost ?? 0]));
  const remaining = new Set(ids);
  let current =
    opts.start && remaining.has(opts.start)
      ? opts.start
      : ids.reduce((a, b) => ((self.get(a) ?? 0) <= (self.get(b) ?? 0) ? a : b));
  const order: string[] = [current];
  remaining.delete(current);
  let total = self.get(current) ?? 0;

  while (remaining.size > 0) {
    let best: string | null = null;
    let bestEdge = Infinity;
    for (const cand of remaining) {
      const edge = costBetween(current, cand) + (self.get(cand) ?? 0);
      if (edge < bestEdge || (edge === bestEdge && cand.localeCompare(best ?? "") < 0)) {
        bestEdge = edge;
        best = cand;
      }
    }
    current = best!;
    remaining.delete(current);
    order.push(current);
    total += bestEdge;
  }

  if (opts.twoOpt !== false && order.length >= 4) {
    const polished = twoOptTour(order, costBetween, self);
    return polished;
  }
  return { order, cost: total };
}

function pathCost(
  order: readonly string[],
  costBetween: (from: string, to: string) => number,
  self: Map<string, number>,
): number {
  if (order.length === 0) return 0;
  let t = self.get(order[0]!) ?? 0;
  for (let i = 1; i < order.length; i++) {
    t += costBetween(order[i - 1]!, order[i]!) + (self.get(order[i]!) ?? 0);
  }
  return t;
}

/** 2-opt polish on an open path (no return-to-start — ATSP open tour). */
function twoOptTour(
  order: string[],
  costBetween: (from: string, to: string) => number,
  self: Map<string, number>,
): { order: string[]; cost: number } {
  let best = [...order];
  let bestCost = pathCost(best, costBetween, self);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const next = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const c = pathCost(next, costBetween, self);
        if (c + 1e-12 < bestCost) {
          best = next;
          bestCost = c;
          improved = true;
        }
      }
    }
  }
  return { order: best, cost: bestCost };
}

/**
 * Canonical production layer ids (documentation + adapter registry).
 * Costs are relative ranks — calibrate to real ms/USD at the adapter boundary.
 */
export const DEFAULT_LAYER_COSTS = {
  /** L0 in-process exact */
  memory: 0,
  /** L1 resolution / execute result (content-addressed) */
  resolution: 1,
  /** L2 semantic paraphrase hit */
  semantic: 2,
  /** L3 marketplace / known route execute */
  execute: 10,
  /** L4 anti-bot free rungs */
  rescue_free: 50,
  /** L5 paid unlock / captcha */
  rescue_paid: 200,
  /** L6 deep browser capture */
  browser: 500,
} as const;
