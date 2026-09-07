/**
 * Live A/B: unbrowse's OWN web-search provider vs raw keyless DDG (and exa if a
 * key is set). Real queries, real fetches — latency + highlight quality.
 *   bun backend/scripts/web-search-compare.ts
 */
import { ddgSearch } from "../src/services/web-search/providers/ddg.js";
import { unbrowseSearch } from "../src/services/web-search/providers/unbrowse.js";
import { exaSearch } from "../src/services/web-search/providers/exa.js";
import type { WebResult } from "../src/services/web-search/types.js";

const QUERIES = [
  "how does retrieval augmented generation reduce hallucination",
  "postgres connection pool sizing best practices",
  "what causes the northern lights aurora",
];

const ms = (n: number) => `${Math.round(n)}ms`;
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const v = await fn();
  return [v, performance.now() - t];
}
const hi = (r?: WebResult) => (r?.highlights?.[0] ?? "(none)").slice(0, 160);

const EXA = process.env.EXA_API_KEY;

for (const q of QUERIES) {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("QUERY:", q);
  let ddg: WebResult[] = [], ub: WebResult[] = [], dms = 0, ums = 0;
  try { [ddg, dms] = await timed(() => ddgSearch(q, 5)); } catch (e) { console.log("  ddg err:", (e as Error).message); }
  try { [ub, ums] = await timed(() => unbrowseSearch(q, 5)); } catch (e) { console.log("  unbrowse err:", (e as Error).message); }

  console.log(`\n  RAW DDG        ${ms(dms)}  (${ddg.length} results) — highlight = DDG snippet`);
  console.log(`    top: ${ddg[0]?.url ?? "(none)"}`);
  console.log(`    hi : ${hi(ddg[0])}`);
  console.log(`\n  UNBROWSE       ${ms(ums)}  (${ub.length} results) — highlight = content-grounded (BM25 over fetched page)`);
  console.log(`    top: ${ub[0]?.url ?? "(none)"}`);
  console.log(`    hi : ${hi(ub[0])}`);

  // quality signal: how many of the top-3 unbrowse results carry a content highlight that differs from the thin DDG snippet
  const ddgHi = new Set(ddg.map((r) => r.highlights?.[0]));
  const enriched = ub.slice(0, 3).filter((r) => r.highlights?.[0] && !ddgHi.has(r.highlights[0])).length;
  console.log(`\n  → unbrowse enriched ${enriched}/3 top results with NEW content-grounded highlights (vs DDG's snippet)`);

  if (EXA) {
    try {
      const [ex, ems] = await timed(() => exaSearch(EXA, q, 5));
      console.log(`\n  EXA            ${ms(ems)}  (${ex.length} results)`);
      console.log(`    top: ${ex[0]?.url ?? "(none)"}`);
      console.log(`    hi : ${hi(ex[0])}`);
    } catch (e) { console.log("  exa err:", (e as Error).message); }
  }
}
console.log("\n════════════════════════════════════════════════════════════════");
console.log("verdict: latency cost = unbrowse − ddg (the per-query fetch+extract overhead);");
console.log("quality gain = content-grounded highlights replacing thin DDG snippets.");
