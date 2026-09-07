/**
 * backend/src/services/rank-bm25.ts — Worker-portable copy of the pure
 * BM25 signal at src/ranking/signals/bm25.ts.
 *
 * Byte-identical math relocated for the Cloudflare Worker bundle
 * (backend tsconfig rootDir=src cannot import from ../../src/). The
 * client keeps src/ranking/signals/bm25.ts; this is its server twin.
 * Any change to the BM25 constants/formula MUST land in both files in
 * the same commit (the rank parity test pins this).
 */

/** BM25 saturation parameter — paper §3.3 default. */
export const BM25_K1 = 1.2;

/** BM25 length-normalization parameter — paper §3.3 default. */
export const BM25_B = 0.75;

/** Weight applied to the clamped, non-negative BM25 score. */
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
    const df = docFreqs.get(term) ?? 0;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    const num = freq * (BM25_K1 + 1);
    const denom = freq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDl));
    score += idf * (num / denom);
  }
  return score;
}
