import Link from "next/link";
import { Chapter } from "../chapter";
import { getStatsSummary, type StatsSummary } from "@/lib/api";

/**
 * Chapter [04] — Numbers.
 *
 * Source: MAY18-INVENTORY §7 BenchmarkTable + §8 HeroStats (live).
 * The 3.6x pull-quote is a massive Bricolage display numeral. The
 * comparison table is a cream card with hairline rules between rows;
 * the unbrowse row carries a left ink bar instead of a dark fill.
 * Live HeroStats counters render on cream.
 */
export function Ch04Numbers() {
  return (
    <Chapter
      id="numbers"
      number="[04]"
      name="Numbers"
      title="Numbers, not adjectives."
      lede="3.6x mean. 5.4x median. Eighteen of ninety-four domains complete in under a hundred milliseconds, from cache."
    >
      {/* Pull-quote */}
      <div className="numbers-pull">
        <span className="numbers-bignum">3.6x</span>
        <span className="numbers-bignum-caption">
          mean speedup over Playwright across 94 live-bench domains.
        </span>
      </div>

      {/* Benchmark table */}
      <div className="benchmark-table" role="table" aria-label="Tool comparison">
        <div className="bench-head" role="row">
          <span role="columnheader">Tool</span>
          <span role="columnheader">Tokens/call</span>
          <span role="columnheader">Cold</span>
          <span role="columnheader">Cached</span>
          <span role="columnheader">Cost/call</span>
        </div>
        <div className="bench-row" role="row">
          <span role="cell" className="bench-tool">Playwright MCP</span>
          <span role="cell">~114K</span>
          <span role="cell">~14s</span>
          <span role="cell">n/a</span>
          <span role="cell">$0.04</span>
        </div>
        <div className="bench-row" role="row">
          <span role="cell" className="bench-tool">ChatGPT Agent / Manus</span>
          <span role="cell">n/a</span>
          <span role="cell">minutes</span>
          <span role="cell">n/a</span>
          <span role="cell">&quot;unsustainable&quot;</span>
        </div>
        <div className="bench-row bench-row-us" role="row">
          <span role="cell" className="bench-tool">unbrowse</span>
          <span role="cell">~5K</span>
          <span role="cell">20-80s browser cold</span>
          <span role="cell">&lt;200ms</span>
          <span role="cell">$0.008 cached / free on capture</span>
        </div>
      </div>

      {/* Live counters */}
      <NumbersLiveStats />

      <Link
        href="/internal-apis-are-all-you-need"
        className="cta-link"
        style={{ marginTop: "1.5rem" }}
      >
        Read the methodology →
      </Link>

      <style>{`
        .numbers-pull {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin-bottom: clamp(2rem, 4vw, 3rem);
        }
        .numbers-bignum {
          font-family: var(--font-display-editions), NeueMontreal, Helvetica, Arial, sans-serif;
          font-weight: 700;
          font-size: clamp(8rem, 14vw, 18rem);
          line-height: 0.9;
          letter-spacing: -0.04em;
          color: var(--ed-ink);
          font-variant-numeric: tabular-nums;
        }
        .numbers-bignum-caption {
          font-family: var(--font-serif-editions), HWCigars, Georgia, serif;
          font-size: 1.5rem;
          line-height: 0.97;
          letter-spacing: -0.04em;
          color: var(--ed-ink-muted);
          max-width: 38ch;
        }
        .benchmark-table {
          background-color: var(--ed-cream-card);
          border-radius: 0.75rem;
          overflow: hidden;
          margin-bottom: clamp(2rem, 4vw, 3rem);
        }
        .bench-head,
        .bench-row {
          display: grid;
          grid-template-columns: 1.4fr 1fr 1fr 1fr 1.5fr;
          gap: 1rem;
          padding: clamp(0.9rem, 1.5vw, 1.25rem) clamp(1rem, 2vw, 1.5rem);
          align-items: baseline;
          font-family: var(--font-mono);
          font-size: 0.9rem;
          color: var(--ed-ink);
        }
        .bench-head {
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: var(--ed-ink-muted);
          border-bottom: 1px solid var(--ed-hairline-faint);
        }
        .bench-row {
          border-bottom: 1px solid var(--ed-hairline-faint);
        }
        .bench-row:last-child {
          border-bottom: 0;
        }
        .bench-tool {
          font-family: var(--font-display-editions), NeueMontreal, Helvetica, Arial, sans-serif;
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        .bench-row-us {
          position: relative;
          background-color: rgba(41, 41, 25, 0.04);
        }
        .bench-row-us::before {
          content: "";
          position: absolute;
          left: 0;
          top: 0.4rem;
          bottom: 0.4rem;
          width: 3px;
          background-color: var(--ed-ink);
          border-radius: 0 2px 2px 0;
        }
        @media (max-width: 720px) {
          .bench-head { display: none; }
          .bench-row {
            grid-template-columns: 1fr 1fr;
            row-gap: 0.4rem;
          }
        }
      `}</style>
    </Chapter>
  );
}

/**
 * NumbersLiveStats — server-rendered live counters. Same pattern as the
 * legacy HeroStats but recoloured for the cream surface (no orange).
 */
async function NumbersLiveStats() {
  let summary: StatsSummary | null = null;
  try {
    summary = await getStatsSummary();
  } catch {
    summary = null;
  }
  const domains = summary?.domains ?? 600;
  const executions = summary?.executions ?? 1_000_000;
  const skills = summary?.skills ?? 18_000;

  const fmt = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return String(n);
  };

  const cells: Array<{ label: string; value: string }> = [
    { label: "domains in registry", value: fmt(domains) },
    { label: "agent visits", value: fmt(executions) },
    { label: "shadow API endpoints", value: fmt(skills) },
  ];

  return (
    <div className="numbers-live">
      {cells.map((c) => (
        <div key={c.label} className="numbers-live-cell">
          <div className="numbers-live-value">{c.value}</div>
          <div className="numbers-live-label">{c.label}</div>
        </div>
      ))}
      <style>{`
        .numbers-live {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: clamp(0.75rem, 1.5vw, 1.5rem);
        }
        .numbers-live-cell {
          background-color: var(--ed-cream-card);
          border-radius: 0.75rem;
          padding: clamp(1.25rem, 2.5vw, 2rem) clamp(1rem, 2vw, 1.5rem);
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          align-items: flex-start;
        }
        .numbers-live-value {
          font-family: var(--font-display-editions), NeueMontreal, Helvetica, Arial, sans-serif;
          font-weight: 700;
          font-size: clamp(2.25rem, 5vw, 3.5rem);
          line-height: 1;
          letter-spacing: -0.03em;
          color: var(--ed-ink);
          font-variant-numeric: tabular-nums;
        }
        .numbers-live-label {
          font-family: var(--font-mono);
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.2em;
          color: var(--ed-ink-muted);
        }
        @media (max-width: 640px) {
          .numbers-live {
            grid-template-columns: repeat(1, minmax(0, 1fr));
          }
        }
      `}</style>
    </div>
  );
}
