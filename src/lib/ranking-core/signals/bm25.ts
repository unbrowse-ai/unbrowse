/**
 * src/ranking/signals/bm25.ts — P1 Wave-3 cluster #1 (BM25 term-frequency).
 *
 * Pure-function BM25 implementation extracted byte-identical from
 * src/execution/index.ts:rankEndpoints (was at L3118-3135 + L3000-3001
 * + the magic `* 20` multiplier at L3643). Relocated for paper §3
 * naming + future regression-fixture coverage in W4.
 *
 * Inputs come from the rankEndpoints setup pipeline at
 * src/execution/index.ts:3575-3587 (queryTokens, docs, avgDl, docCount,
 * docFreqs). That pipeline depends on tokenize/expandQuery/endpointToTokens
 * which are NOT extracted in W3 — they're general tokenization primitives
 * future signal clusters may reuse, and moving them is W4-territory.
 *
 * Parity contract: tests/ranking-parity.test.ts holds the byte-identical
 * baseline. Any change to this function MUST update the parity baseline
 * in the same commit, with a CHANGELOG entry naming what changed.
 *
 * Inoculation #2 binds: the `* 20` multiplier was paper §3 value when
 * codified; do not adjust without a reproducible benchmark.
 */

/** BM25 saturation parameter — paper §3.3 default. */
export const BM25_K1 = 1.2;

/** BM25 length-normalization parameter — paper §3.3 default. */
export const BM25_B = 0.75;

/**
 * Weight applied to the (clamped, non-negative) BM25 score before it
 * joins the inline rankEndpoints score. Pre-extraction this was a magic
 * `* 20` literal at src/execution/index.ts:3643. Named for greppability.
 */
export const BM25_DELTA_WEIGHT = 20;

export function bm25Score(
  query: string[],
  doc: string[],
  avgDl: number,
  docCount: number,
  docFreqs: Map<string, number>,
): number {
  const dl = doc.length;
  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of query) {
    const freq = tf.get(term) ?? 0;
    if (freq === 0) continue;
    // Real IDF: log((N - df + 0.5) / (df + 0.5) + 1) — terms appearing in fewer docs score higher
    const df = docFreqs.get(term) ?? 0;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    const num = freq * (BM25_K1 + 1);
    const denom = freq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDl));
    score += idf * (num / denom);
  }
  return score;
}
