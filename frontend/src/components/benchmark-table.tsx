'use client';

import Link from "next/link";

/**
 * Numeric comparison table. Three rows for the headline comparison plus
 * a fourth "across the corpus" row that surfaces the paper-cited mean
 * and median over 94 live domains (the strongest single number we
 * have, per wave-3 audit U6).
 *
 * Numbers anchored:
 *   - Playwright MCP row: t3_1spvkrz (~114K tokens, Microsoft team's own
 *     CLI recommendation), t3_1rhjxet (Charlotte 136x cite).
 *   - ChatGPT Agent / Manus row: t3_1slaon8 ("unsustainable"),
 *     t3_1qjph7y (MiniMax burned 10k credits in 3 hours), t3_1sih7bv
 *     (Playwright "burning tokens"). Qualitative because the cited
 *     threads do not give numeric latencies.
 *   - unbrowse row: paper arxiv 2604.00694 ("3.6x mean, 5.4x median
 *     over Playwright across 94 live domains"), llms.txt:71 three-path
 *     latency model. Browser fallback corrected to 20-80s (was 5-30s in
 *     legacy copy — falsified by llms.txt:71 in wave-3 audit F3).
 *
 * Trace in frontend/docs/POSITIONING.md.
 */
export function BenchmarkTable() {
  const rows: Array<{
    tool: string;
    tokens: string;
    cold: string;
    cached: string;
    cost: string;
    note: string;
    highlight: boolean;
  }> = [
    {
      tool: "Playwright MCP",
      tokens: "~114K",
      cold: "~14s",
      cached: "n/a",
      cost: "$0.04",
      note: "Full a11y tree on every call; Microsoft team recommends their CLI over their own MCP for typical scrapes.",
      highlight: false,
    },
    {
      tool: "ChatGPT Agent / Manus",
      tokens: "n/a",
      cold: "minutes",
      cached: "n/a",
      cost: "\"unsustainable\"",
      note: "Cited as too slow or too expensive to leave running; frequently blocked on real sites.",
      highlight: false,
    },
    {
      tool: "unbrowse",
      tokens: "~5K",
      cold: "20-80s (browser)",
      cached: "<200ms (skill cache)",
      cost: "$0.008 cached / free on capture",
      note: "Three-path resolve: skill cache, shared route graph, then browser fallback. The paper measures 3.6x mean (5.4x median) over Playwright across 94 live domains.",
      highlight: true,
    },
  ];

  return (
    <section id="benchmark" className="relative py-16 sm:py-24 flex flex-col justify-center">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-8">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-2">
            ##  Same intent, three tools
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
            Numbers, not adjectives.
          </h2>
          <p className="text-sm sm:text-base text-text-secondary mt-3 max-w-2xl mx-auto leading-relaxed">
            Paper at{" "}
            <Link
              href="/internal-apis-are-all-you-need"
              className="underline decoration-[rgba(255,122,32,0.4)] hover:text-[rgba(255,176,96,1)]"
            >
              arxiv 2604.00694
            </Link>
            . Reddit citations and code paths in{" "}
            <span className="font-mono">/docs/POSITIONING.md</span>. Rerun the
            bench from <code className="font-mono">harness/probes/</code>.
          </p>
        </div>

        <div className="border border-[rgba(255,122,32,0.25)] bg-[#070503]/90 rounded-sm overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead className="bg-[rgba(0,0,0,0.35)] border-b border-[rgba(255,122,32,0.2)]">
              <tr className="text-[11px] uppercase tracking-[0.2em] text-text-muted">
                <th className="text-left px-4 py-3">Tool</th>
                <th className="text-right px-4 py-3">Tokens / call</th>
                <th className="text-right px-4 py-3">Cold</th>
                <th className="text-right px-4 py-3">Cached</th>
                <th className="text-right px-4 py-3">Cost / call</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.tool}
                  className={`border-b border-[rgba(255,122,32,0.12)] last:border-0 ${r.highlight ? "bg-[rgba(255,122,32,0.04)]" : ""}`}
                >
                  <td className={`px-4 py-3 ${r.highlight ? "text-orange-500 font-medium" : "text-text-primary"}`}>{r.tool}</td>
                  <td className="text-right px-4 py-3 text-text-secondary">{r.tokens}</td>
                  <td className="text-right px-4 py-3 text-text-secondary">{r.cold}</td>
                  <td className="text-right px-4 py-3 text-text-secondary">{r.cached}</td>
                  <td className={`text-right px-4 py-3 ${r.highlight ? "text-orange-500" : "text-text-secondary"}`}>{r.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Across-the-corpus headline number */}
        <div className="mt-5 border border-[rgba(255,122,32,0.18)] bg-[#070503]/70 rounded-sm p-5 sm:p-6 flex flex-col sm:flex-row gap-5 sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-2">
              Across 94 live domains
            </p>
            <p className="text-text-primary text-base sm:text-lg leading-snug">
              <span className="font-display text-3xl text-orange-500 tracking-tight">3.6x</span>{" "}
              mean speedup over Playwright. <span className="text-text-secondary">5.4x median.</span>
            </p>
            <p className="text-xs text-text-muted mt-2 leading-relaxed max-w-xl">
              Measured in the public agent-experience harness. 18 of the 94
              domains complete in sub-100ms from cached skill routes.
            </p>
          </div>
          <Link
            href="/internal-apis-are-all-you-need"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] transition-all whitespace-nowrap"
          >
            Read the methodology →
          </Link>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-text-muted leading-relaxed">
          {rows.map((r) => (
            <p key={`note-${r.tool}`} className={r.highlight ? "text-text-secondary" : ""}>
              <span className={`font-mono ${r.highlight ? "text-orange-500" : "text-text-primary"}`}>{r.tool}.</span>{" "}
              {r.note}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
