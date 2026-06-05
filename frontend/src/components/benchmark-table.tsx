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
      <div className="max-w-6xl w-full mx-auto px-4 sm:px-6 min-w-0">
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

        <div className="border border-[rgba(255,122,32,0.25)] bg-[#070503]/90 rounded-sm overflow-x-auto min-w-0 max-w-full">
          <table className="w-full text-sm font-mono tabular-nums">
            <thead className="bg-[rgba(0,0,0,0.45)] border-b border-[rgba(255,122,32,0.28)]">
              <tr className="text-[10px] uppercase tracking-[0.24em] text-[rgba(255,122,32,0.7)]">
                <th className="text-left px-4 py-3.5 font-medium">Tool</th>
                <th className="text-right px-4 py-3.5 font-medium">Tokens / call</th>
                <th className="text-right px-4 py-3.5 font-medium">Cold</th>
                <th className="text-right px-4 py-3.5 font-medium">Cached</th>
                <th className="text-right px-4 py-3.5 font-medium">Cost / call</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.tool}
                  className={`border-b border-[rgba(255,122,32,0.12)] last:border-0 ${r.highlight ? "bg-[rgba(255,122,32,0.06)]" : ""}`}
                >
                  <td className={`px-4 py-3.5 ${r.highlight ? "text-orange-500 font-semibold tracking-tight" : "text-text-primary"}`}>{r.tool}</td>
                  <td className="text-right px-4 py-3.5 text-text-secondary">{r.tokens}</td>
                  <td className="text-right px-4 py-3.5 text-text-secondary">{r.cold}</td>
                  <td className="text-right px-4 py-3.5 text-text-secondary">{r.cached}</td>
                  <td className={`text-right px-4 py-3.5 ${r.highlight ? "text-orange-500 font-medium" : "text-text-secondary"}`}>{r.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Banger W1: MASSIVE 3.6x band. Display weight pushed to
            clamp(8rem, 18vw, 22rem) — the number IS the band. Caption
            sits inline on desktop, stacks under on mobile. Halftone
            overlay inherits the dot pattern from globals.css. */}
        <div className="halftone-overlay mt-6 border border-[rgba(255,122,32,0.35)] bg-[#070503]/80 rounded-sm px-6 sm:px-10 py-8 sm:py-10 relative overflow-hidden">
          <p className="relative z-10 text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.7)] mb-4">
            ##  Across 94 live domains
          </p>
          <div className="relative z-10 flex flex-col lg:flex-row lg:items-baseline lg:gap-8">
            <span
              className="font-display text-orange-500 tabular-nums leading-[0.85] block"
              style={{
                fontSize: "clamp(8rem, 18vw, 22rem)",
                letterSpacing: "-0.05em",
                textShadow: "0 0 80px rgba(255,82,0,0.25)",
              }}
              aria-label="3.6 times mean speedup over Playwright"
            >
              3.6×
            </span>
            <p
              className="text-text-secondary italic max-w-md font-serif text-base sm:text-lg lg:text-xl leading-snug mt-3 lg:mt-0"
              style={{ fontFamily: "var(--font-serif, 'Cormorant Garamond', Georgia, serif)" }}
            >
              mean speedup over Playwright across 94 live-bench domains.{" "}
              <span className="text-orange-300 not-italic font-mono text-sm">5.4× median.</span>{" "}
              <span className="text-text-muted not-italic font-mono text-sm">18 of 94 cached under 100ms.</span>
            </p>
          </div>
          <div className="relative z-10 mt-6 flex items-center justify-end">
            <Link
              href="/internal-apis-are-all-you-need"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] transition-colors duration-200 whitespace-nowrap"
            >
              Read the paper →
            </Link>
          </div>
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
