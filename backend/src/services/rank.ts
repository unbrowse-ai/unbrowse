/**
 * backend/src/services/rank.ts — server-side evidence-derived endpoint ranker.
 *
 * WAVE 2 of the server-move program: the ranking *intelligence* (which
 * captured endpoint best matches an intent, with what evidence) used to
 * run entirely client-side in `src/execution/index.ts:rankEndpoints`,
 * so the tuning weights shipped in the npm bundle and were
 * reverse-engineerable. This module computes the ranked shortlist +
 * evidence SERVER-side and the client prefers it over the local ranker.
 *
 * Substrate principle: this surfaces EVIDENCE-DERIVED GENERIC signals
 * only — BM25 over the endpoint's own text with real corpus IDF,
 * URL-path keyword overlap with the intent, schema richness, host
 * pattern (api./io./docs.), method tiebreak, response-shape bonuses,
 * the generic noise-filter, and the paper's freshness decay. It does
 * NOT contain per-domain registries and does NOT run a second LLM.
 * Disambiguation when scores tie stays the calling agent's job — the
 * server returns the candidates + per-signal evidence, never a
 * prescriptive single verdict.
 *
 * Parity intent: the signal *shape* mirrors the client ranker's
 * evidence-derived core (tokenize → expand-stem → BM25 → structural
 * deltas). The client keeps the full 900-line ranker as a DEGRADED
 * LOCAL FALLBACK for when this route is unreachable; the server result
 * is the higher-quality path because it can be retuned without a
 * client release.
 */

import type { EndpointDescriptor } from "../types.js";
import {
  NOISE_HOSTS,
  NOISE_PATHS,
  I18N_CONFIG_PATHS,
  AUTH_CONFIG_PATHS,
  SESSION_PLUMBING,
  STATIC_ASSET_PATTERNS,
  UI_ASSET_PATHS,
} from "./rank-noise-patterns.js";
import { bm25Score, BM25_DELTA_WEIGHT } from "./rank-bm25.js";
import { freshnessFromDate } from "./rank-freshness.js";
// The EBM — fs-free cores, bundle into the worker (nodejs_compat / node:crypto only, no node:fs).
import { learnedEnergyEmbedded, routeEnergyFromBackoff } from "../../../src/ranking/signals/learned-energy-core.js";
import { composeChainEnergy, type ChainGraph, type ChainNode } from "../../../src/ranking/signals/path-energy-core.js";

export interface RankSignalEvidence {
  bm25: number;
  url_path_overlap: number;
  schema_richness: number;
  host_pattern: number;
  method_tiebreak: number;
  response_shape: number;
  freshness: number;
  reliability: number;
  /** Context-URL path-prefix match: how many leading path segments of the
   *  endpoint url_template match the user's contextUrl path. Absent on
   *  older clients; readers treat undefined as 0. */
  context_path_prefix_match?: number;
  /** EBM per-hop learned-head delta: sigmoid(head·features) centered at 0.5, bounded. Absent (0) when
   *  no head is shipped — older servers/bundles omit it and readers treat undefined as 0. */
  learned_energy?: number;
  /** EBM fractal chain delta: the head energy composed up the requires/yields DAG (weakest-link),
   *  centered + bounded. Present only when the request carries an operation_graph and this endpoint
   *  is an op in it; when present it SUBSUMES learned_energy in the score (a leaf's chain == its hop). */
  chain_energy?: number;
}

export interface RankedEndpointResult {
  endpoint_id: string;
  score: number;
  /** Per-signal evidence so the calling agent can judge ties itself. */
  evidence: RankSignalEvidence;
}

export interface RankRequest {
  intent?: string;
  endpoints: EndpointDescriptor[];
  skill_domain?: string;
  context_url?: string;
  /** Optional producer→consumer DAG (the skill's operation_graph). When present, the EBM ranks by the
   *  fractal chain energy (weakest-link up the chain) instead of the flat per-hop head. Data-gated:
   *  older clients omit it and the per-hop learned head is used. */
  operation_graph?: ChainGraph;
}

export interface RankResponse {
  ranked: RankedEndpointResult[];
  /** false = computed by this server; the client treats true as a hint
   *  to keep its local fallback authoritative. Always false here. */
  degraded: boolean;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "by", "at", "from", "as",
  "get", "list", "all", "my", "me", "show", "find",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Lightweight Porter-ish suffix strip — generic, no synonym registry. */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
  return w;
}

function expandStem(tokens: string[]): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    out.add(stem(t));
  }
  return [...out];
}

/** Document tokens from an endpoint — URL path, query, schema, description. */
function endpointToTokens(ep: EndpointDescriptor): string[] {
  const tokens: string[] = [];
  try {
    const u = new URL(ep.url_template);
    const rawSegments = u.pathname
      .split(/[/\-_.{}]/)
      .filter((s) => s.length > 1 && !/^v\d+$/.test(s));
    for (const seg of rawSegments) {
      tokens.push(seg);
      const camelParts = seg
        .split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
        .filter((s) => s.length > 1);
      if (camelParts.length > 1) tokens.push(...camelParts);
    }
    const hostParts = u.hostname.split(".");
    tokens.push(
      ...hostParts.filter(
        (s) =>
          s.length > 2 &&
          s !== "www" &&
          s !== "com" &&
          s !== "org" &&
          s !== "net" &&
          s !== "io",
      ),
    );
    for (const [key, val] of u.searchParams.entries()) {
      tokens.push(key);
      if (val.length > 1 && val.length < 50) {
        tokens.push(...val.split(/[/\-_.]/).filter((s) => s.length > 1));
      }
    }
  } catch {
    /* non-URL template — skip */
  }
  if (ep.response_schema?.properties) {
    tokens.push(...Object.keys(ep.response_schema.properties));
    for (const val of Object.values(ep.response_schema.properties) as Array<{
      properties?: Record<string, unknown>;
    }>) {
      if (val?.properties) tokens.push(...Object.keys(val.properties));
    }
  }
  if (ep.trigger_url) {
    try {
      const tu = new URL(ep.trigger_url);
      tokens.push(
        ...tu.pathname
          .split(/[/\-_.{}]/)
          .filter((s) => s.length > 1 && !/^(i|app|en|v\d+)$/.test(s)),
      );
    } catch {
      /* skip */
    }
  }
  if (ep.description) {
    const descTokens = ep.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w));
    // 3x weight — the LLM description is the strongest semantic signal.
    for (let i = 0; i < 3; i++) tokens.push(...descTokens);
  }
  return tokens.map((t) => stem(t.toLowerCase()));
}

function passesNoiseFilter(ep: EndpointDescriptor): boolean {
  if (ep.method === "HEAD" || ep.method === "OPTIONS") return false;
  if (ep.verification_status === "disabled") return false;
  if (STATIC_ASSET_PATTERNS.test(ep.url_template)) return false;
  if (UI_ASSET_PATHS.test(ep.url_template)) return false;
  try {
    const host = new URL(ep.url_template).hostname;
    if (NOISE_HOSTS.test(host)) return false;
  } catch {
    /* skip */
  }
  if (NOISE_PATHS.test(ep.url_template)) return false;
  if (I18N_CONFIG_PATHS.test(ep.url_template)) return false;
  if (AUTH_CONFIG_PATHS.test(ep.url_template)) return false;
  if (SESSION_PLUMBING.test(ep.url_template)) return false;
  return true;
}

function urlPathOverlap(ep: EndpointDescriptor, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  let path = "";
  try {
    path = new URL(ep.url_template).pathname.toLowerCase();
  } catch {
    path = ep.url_template.toLowerCase();
  }
  let overlap = 0;
  for (const t of queryTokens) {
    if (t.length > 2 && path.includes(t)) overlap += 1;
  }
  return overlap * 8;
}

/**
 * contextPathPrefixMatch — generic structural preference for endpoints whose
 * url_template path shares a left-prefix with the user-provided contextUrl.
 *
 * Background (Issue #48): when the agent passes
 * `params.url = .../users/profile/past-trips`, the ranker had no contextUrl
 * path signal; on airbnb.com it picked /trips/past (matching the intent
 * keyword "past trips") over /users/profile/past-trips (which is the exact
 * URL the user named).
 *
 * Substrate: pure URL.pathname segment comparison. NO per-domain registry,
 * NO host arm. Returns 0 when no contextUrl or no path overlap.
 */
function contextPathPrefixMatch(ep: EndpointDescriptor, contextUrl?: string): number {
  if (!contextUrl) return 0;
  let epPath: string[] = [];
  let ctxPath: string[] = [];
  try {
    epPath = new URL(ep.url_template).pathname.toLowerCase().split("/").filter(Boolean);
    ctxPath = new URL(contextUrl).pathname.toLowerCase().split("/").filter(Boolean);
  } catch {
    return 0;
  }
  if (epPath.length === 0 || ctxPath.length === 0) return 0;
  // Count contiguous matching segments from the LEFT. Treats template
  // placeholders ({id}, :slug) as wildcard matches against any literal
  // segment so the signal still fires on /users/{userId}/past-trips when
  // contextUrl is /users/42/past-trips.
  let matched = 0;
  const n = Math.min(epPath.length, ctxPath.length);
  for (let i = 0; i < n; i++) {
    const epSeg = epPath[i];
    const ctxSeg = ctxPath[i];
    const isPlaceholder = /^[{:].*[}]?$/.test(epSeg);
    if (epSeg === ctxSeg || isPlaceholder) matched += 1;
    else break;
  }
  // Per-segment weight in the same ballpark as urlPathOverlap's per-token
  // (+8); slightly lower because path-prefix can be coincidental.
  return matched * 6;
}

function schemaRichness(ep: EndpointDescriptor): number {
  const props = ep.response_schema?.properties;
  if (!props) return 0;
  const n = Object.keys(props).length;
  if (n === 0) return 0;
  // Diminishing returns — a schema'd endpoint is real data, but more
  // fields past ~12 is not proportionally more relevant.
  return Math.min(n, 12) * 4;
}

function hostPattern(ep: EndpointDescriptor): number {
  try {
    const host = new URL(ep.url_template).hostname.toLowerCase();
    if (/(^|\.)(api|io|graphql|rest|rpc)\./.test(host)) return 30;
    if (/(^|\.)docs?\./.test(host)) return 10;
  } catch {
    /* skip */
  }
  if (/\/(api|graphql|rest|rpc)\//.test(ep.url_template.toLowerCase())) return 18;
  return 0;
}

function methodTiebreak(ep: EndpointDescriptor): number {
  // Read verbs win for read intents; write verbs are demoted so a
  // read-on-write endpoint never tops the shortlist (Agent-UX A13).
  switch (ep.method) {
    case "GET":
      return 6;
    case "POST":
      return 2; // GraphQL reads are POST — small positive, not a penalty
    case "PUT":
    case "PATCH":
    case "DELETE":
      return -120;
    case "WS":
      return 1;
    default:
      return 0;
  }
}

function responseShape(ep: EndpointDescriptor): number {
  const root = ep.response_schema?.type;
  if (root === "array") return 14;
  if (root === "object") return 8;
  return 0;
}

function reliabilitySignal(ep: EndpointDescriptor): number {
  const r = typeof ep.reliability_score === "number" ? ep.reliability_score : 0;
  // reliability_score is [0,1]; surface it as a bounded structural delta.
  return Math.max(0, Math.min(1, r)) * 25;
}

/** Bounded weight for the learned-head signal. Kept < reliability/2 (25) so the max learned spread
 *  (2·8=16) can never overturn a full reliability gap (25): the durable signal stays primary; the
 *  head only breaks ties and ranks cold/sparse endpoints the back-off (reliability_score 0) is blind to. */
const LEARNED_WEIGHT = 8;

/**
 * EBM learned-head signal: the shipped energy head's P(success) for (domain, endpoint, intent),
 * surfaced as a centered, bounded delta in [-LEARNED_WEIGHT, +LEARNED_WEIGHT]. ADDITIVE — it never
 * erases the durable reliability signal; it lets the head generalise to cold/sparse endpoints the
 * back-off is blind to. No head shipped → learnedEnergyEmbedded returns null → 0 → score identical
 * to today. The head is fed by the same identity-free (domain,endpoint) signal as reliability.
 */
function learnedHeadSignal(ep: EndpointDescriptor, req: RankRequest): number {
  const e = learnedEnergyEmbedded(req.skill_domain, ep.endpoint_id, "", req.intent);
  if (e === null) return 0;
  return (e - 0.5) * 2 * LEARNED_WEIGHT;
}

/**
 * EBM fractal chain signal: the head energy composed up the requires/yields DAG ending at this
 * endpoint's op (weakest-link / Bellman over -log), centered + bounded by the SAME weight as the
 * per-hop head so it never escapes the reliability-primary invariant. Returns null when the request
 * carries no operation_graph or this endpoint isn't an op in it → the caller uses the per-hop head.
 * Per-hop leaf = the EBM leaf (durable reliability blended with the embedded head), all fs-free.
 */
function chainHeadSignal(ep: EndpointDescriptor, req: RankRequest): number | null {
  const g = req.operation_graph;
  if (!g || !Array.isArray(g.operations) || !g.operations.some((o) => o.endpoint_id === ep.endpoint_id)) {
    return null;
  }
  const relById = new Map(
    req.endpoints.map((e) => [
      e.endpoint_id,
      typeof e.reliability_score === "number" ? Math.max(0, Math.min(1, e.reliability_score)) : 0.5,
    ]),
  );
  const hop = (o: ChainNode): number =>
    routeEnergyFromBackoff(relById.get(o.endpoint_id) ?? 0.5, req.skill_domain ?? "", o.endpoint_id, "", req.intent);
  const chain = composeChainEnergy(g, ep.endpoint_id, hop);
  return (chain - 0.5) * 2 * LEARNED_WEIGHT;
}

function freshnessSignal(ep: EndpointDescriptor): number {
  if (!ep.last_verified_at) return 0;
  // paper §6.3 freshness decay, surfaced as a small bounded bonus.
  return freshnessFromDate(ep.last_verified_at) * 12;
}

/**
 * Rank endpoints by evidence-derived generic signals. Returns the
 * ranked shortlist with per-signal evidence so the calling agent can
 * judge ties. Pure: no network, no LLM, no per-domain registry.
 */
export function rankEndpointsServer(req: RankRequest): RankResponse {
  const endpoints = Array.isArray(req.endpoints) ? req.endpoints : [];
  const candidates = endpoints.filter(passesNoiseFilter);
  const pool = candidates.length > 0
    ? candidates
    : endpoints.filter((e) => e.verification_status !== "disabled");
  if (pool.length === 0) return { ranked: [], degraded: false };

  const rawTokens = req.intent ? tokenize(req.intent) : [];
  const queryTokens = rawTokens.length > 0 ? expandStem(rawTokens) : [];
  const docs = pool.map((ep) => endpointToTokens(ep));
  const avgDl = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const docFreqs = new Map<string, number>();
  for (const doc of docs) {
    for (const t of new Set(doc)) docFreqs.set(t, (docFreqs.get(t) ?? 0) + 1);
  }
  const docCount = docs.length;

  const ranked: RankedEndpointResult[] = pool.map((ep, i) => {
    const bm25Raw =
      queryTokens.length > 0
        ? bm25Score(queryTokens, docs[i], avgDl, docCount, docFreqs)
        : 0;
    const bm25 = Math.max(0, bm25Raw) * BM25_DELTA_WEIGHT;
    const overlap = urlPathOverlap(ep, queryTokens);
    const schema = schemaRichness(ep);
    const host = hostPattern(ep);
    const method = methodTiebreak(ep);
    const shape = responseShape(ep);
    const fresh = freshnessSignal(ep);
    const reliability = reliabilitySignal(ep);
    const learned = learnedHeadSignal(ep, req);
    const chain = chainHeadSignal(ep, req); // null when no operation_graph for this endpoint
    const ebm = chain !== null ? chain : learned; // the fractal chain subsumes the per-hop head
    const ctxPathPrefix = contextPathPrefixMatch(ep, req.context_url);
    const score =
      bm25 + overlap + schema + host + method + shape + fresh + reliability + ctxPathPrefix + ebm;
    return {
      endpoint_id: ep.endpoint_id,
      score,
      evidence: {
        bm25,
        url_path_overlap: overlap,
        schema_richness: schema,
        host_pattern: host,
        method_tiebreak: method,
        response_shape: shape,
        freshness: fresh,
        reliability,
        context_path_prefix_match: ctxPathPrefix,
        learned_energy: learned,
        chain_energy: chain ?? undefined,
      },
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return { ranked, degraded: false };
}
