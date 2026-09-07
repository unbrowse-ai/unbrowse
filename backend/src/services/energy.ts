/**
 * backend/src/services/energy.ts — the unified proxy-energy calling surface.
 *
 * MOAT BOUNDARY: the PUBLIC name is "energy" — a single `E(intent, route)`
 * scoring surface with a stable signature `energyScore(intent, candidate,
 * evidence) => { energy, witnesses, agree }`. The WEIGHTS and FEATURES below
 * are the IMPLEMENTATION (a hand-tuned evidence-routed blend today; a trained
 * energy head could replace these internals later behind the exact same
 * signature without any caller change). Callers depend on the name, never the
 * weights.
 *
 * It unifies the two ranking witnesses already in the tree:
 *   - witness[0] = LEXICAL: BM25/path-overlap of the candidate's own text
 *     against the intent (the same math as rank-bm25.ts bm25Score and
 *     rank.ts url_path_overlap — token overlap with corpus-free IDF).
 *   - witness[1] = DENSE/STRUCTURAL: the schema/host/reliability/embedding
 *     similarity signal, handed in as evidence.dense in [0,1] (exactly how
 *     discovery.ts feeds the dense vector list and rank.ts surfaces its
 *     structural deltas).
 *
 * Unlike discovery.ts rrfFuse — a FIXED reciprocal-rank vote (RRF_K=60) that
 * weights both lists equally regardless of how much evidence each carries —
 * this fuses by EVIDENCE ROUTING: a lexical-confidence `lex_conf` derived from
 * how much real lexical overlap exists collapses the blend weight toward the
 * witness that actually has evidence. When lexical evidence is weak, the dense
 * witness dominates the ordering; when lexical is strong, dense matters less.
 *
 * EBM direction: `energy = -score`, so a better match settles to a LOWER
 * energy (energy-based-model convention).
 */

import { energyScoreViaWasm } from "./core-wasm";

type Candidate = { id: number; text: string };
type Evidence = { dense: number };

export interface EnergyResult {
  energy: number;
  /** [lexical_witness, dense_witness] — both numbers, both higher = better match. */
  witnesses: [number, number];
  /** Do both witnesses concur on the ranking direction (both say match / both say no-match)? */
  agree: boolean;
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

/**
 * LEXICAL witness — fraction of the intent's content tokens that the
 * candidate text covers. This is the corpus-free shape of bm25Score /
 * urlPathOverlap (token overlap of the candidate's own text vs the intent);
 * it stays in [0,1] so it composes with the dense witness on one scale.
 */
function lexicalWitness(intent: string, candidate: Candidate): number {
  const q = tokenize(intent);
  if (q.length === 0) return 0;
  const docTokens = new Set(tokenize(candidate.text));
  let hit = 0;
  for (const t of q) if (docTokens.has(t)) hit += 1;
  return hit / q.length;
}

/** Above this overlap the lexical witness counts as "matched" (agreement test). */
const MATCH_THRESHOLD = 0.5;

/**
 * energyScoreTs — the pure-TS reference implementation of the unified
 * proxy-energy surface. This is the FALLBACK leg: `energyScore` below prefers
 * the Zig WASM core (`energyScoreViaWasm`) and only calls this when the wasm is
 * unavailable. Kept exported so the conformance witness can assert the WASM and
 * TS legs are bit-identical (ε=0), and so any caller that needs the TS leg
 * directly (tests) can reach it.
 *
 * @param intent     the user's intent string.
 * @param candidate  {id, text} — the route candidate (SearchResult identity
 *                   reduced to the text the lexical witness scores).
 * @param evidence   {dense} — the dense/structural witness in [0,1].
 */
export function energyScoreTs(
  intent: string,
  candidate: Candidate,
  evidence: Evidence,
): EnergyResult {
  const lex = lexicalWitness(intent, candidate); // witness[0], in [0,1]
  // Sanitize the dense witness before clamping into [0,1]. A missing/undefined
  // or NaN field carries no usable structural evidence, so it defaults to 0;
  // +/-Infinity is a (degenerate) ordered value and clamps to 1 / 0. The NaN
  // guard is the load-bearing one: `Math.max(0, Math.min(1, undefined|NaN))` is
  // NaN and would poison the whole score => NaN energy.
  const d = evidence?.dense;
  const rawDense = typeof d === "number" && !Number.isNaN(d) ? d : 0;
  const dense = Math.max(0, Math.min(1, rawDense)); // witness[1], in [0,1]

  // EVIDENCE-ROUTED fusion (NOT a fixed RRF vote).
  //
  // lex_conf = how much real lexical evidence this candidate carries. With no
  // overlap there is nothing to trust on the lexical side, so the blend must
  // collapse onto the dense witness; with full overlap the lexical witness
  // earns its weight and the dense witness's influence shrinks.
  const lex_conf = lex; // already a confidence in [0,1]

  // Dense weight COLLAPSES toward 1 as lexical confidence falls. This is the
  // core of contract 2: when lex_conf -> 0, denseWeight -> 1 (dense controls
  // the ordering entirely), so swinging `dense` moves energy the full amount.
  // When lex_conf is high, denseWeight shrinks, so the SAME dense swing moves
  // energy LESS. A fixed RRF vote would make those two swings equal — rejected.
  const denseWeight = 1 - lex_conf;
  const lexWeight = lex_conf;

  // score in [0,1]; both witnesses pull it up, routed by evidence. Higher
  // score = better match. energy = -score (lower energy = better match).
  const score = lexWeight * lex + denseWeight * dense;
  const energy = -score;

  // Agreement: do both witnesses concur on the ranking direction? Both say
  // "match" (lexical overlap clears the threshold AND dense is confident) or
  // both say "no-match". Disagreement = one witness asserts a match the other
  // denies (e.g. strong lexical but dense says no).
  const lexSaysMatch = lex >= MATCH_THRESHOLD;
  const denseSaysMatch = dense >= MATCH_THRESHOLD;
  const agree = lexSaysMatch === denseSaysMatch;

  return { energy, witnesses: [lex, dense], agree };
}

/**
 * energyScore — the unified proxy-energy surface (WASM-preferred).
 *
 * Sources the energy ordering from the SINGLE unbrowse-core Zig WASM
 * (`energyScoreViaWasm`), falling back to the pure-TS `energyScoreTs` on ANY
 * wasm fault (wasm unavailable, missing export, run failure — all return null,
 * never throw). The Zig port is a bit-for-bit (ε=0) match of `energyScoreTs`
 * (witnessed by the conformance tests), so the live resolve ranking is
 * UNCHANGED — this only moves the energy ordering onto the one core.
 *
 * Signature is identical to the prior `energyScore` so every caller is
 * unchanged.
 */
export function energyScore(
  intent: string,
  candidate: Candidate,
  evidence: Evidence,
): EnergyResult {
  const w = energyScoreViaWasm(intent, candidate, evidence);
  return w === null ? energyScoreTs(intent, candidate, evidence) : w;
}
