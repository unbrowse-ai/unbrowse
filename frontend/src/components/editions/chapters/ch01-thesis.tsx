import Link from "next/link";
import { Chapter } from "../chapter";

/**
 * Chapter [01] — Thesis.
 *
 * Source: MAY18-INVENTORY §4 UniversalProofBand. Four cards proving
 * what "universal MCP" actually means. Lede + numbers verbatim from
 * the 76-reddit-thread positioning. Card 1's Playwright diff lives
 * inside a contained dark-figure card; the rest of the chapter stays
 * on cream.
 */
export function Ch01Thesis() {
  return (
    <Chapter
      id="thesis"
      number="[01]"
      name="Thesis"
      title="One MCP. Any website."
      lede="Not a stack of per-site MCPs. Not another framework on top of Playwright. The web layer your agent already wants."
    >
      <div className="thesis-grid">
        {/* Card 1 — Playwright drop-in */}
        <article className="feature-card thesis-card">
          <h3>Already wrote Playwright code? Swap the import.</h3>
          <div className="ed-dark-figure" style={{ marginTop: "1rem" }}>
            <pre>
              <span className="ed-diff-out">{`import { chromium } from "playwright";`}</span>
              {"\n"}
              <span className="ed-diff-in">{`import { Browser } from "@unbrowse/sdk";`}</span>
            </pre>
          </div>
          <p className="thesis-body">
            <code className="thesis-code">page.goto()</code> resolves from the
            skill cache first; the engine calls the captured shadow API.
          </p>
        </article>

        {/* Card 2 — Two-call loop */}
        <article className="feature-card thesis-card">
          <h3>Two tool calls do most of the work.</h3>
          <p className="thesis-body">
            <code className="thesis-code">unbrowse_resolve</code> +{" "}
            <code className="thesis-code">unbrowse_execute</code> are the
            canonical loop. Thirty-plus other tools{" "}
            (<code className="thesis-code">_go, _snap, _click, _fill, _submit, _eval, _scroll, _press, _select, _cookies, _auth_capture</code>){" "}
            are the cold-discovery fallback.
          </p>
          <ul className="thesis-bullets">
            <li>
              <span aria-hidden="true">◇</span> One mcp.json entry replaces your stack
            </li>
            <li>
              <span aria-hidden="true">◇</span> New site appears: same server, no config edit
            </li>
          </ul>
        </article>

        {/* Card 3 — 94 domains, 3.6x */}
        <article className="feature-card thesis-card">
          <h3>94 live domains in the open bench.</h3>
          <div className="thesis-bignum-wrap">
            <span className="thesis-bignum">3.6x</span>
            <span className="thesis-bignum-caption">
              mean over Playwright (5.4x median).
            </span>
          </div>
          <p className="thesis-body">
            18 of those domains complete in under 100ms from the cache.
            Corpus: <code className="thesis-code">harness/probes/corpus.txt</code>.
          </p>
          <Link href="/internal-apis-are-all-you-need" className="cta-link">
            Read the paper →
          </Link>
        </article>

        {/* Card 4 — Compounding flywheel */}
        <article className="feature-card thesis-card">
          <h3>Every install makes the next user faster.</h3>
          <p className="thesis-body">
            First-pass browser captures the route. Publishes it. The next
            agent skips the browser. The cold-start tax shrinks across the
            whole network.
          </p>
          <Link href="/search" className="cta-link">
            Browse the marketplace →
          </Link>
        </article>
      </div>

      {/* Scoped styles for the thesis chapter */}
      <style>{`
        .thesis-grid {
          display: grid;
          grid-template-columns: repeat(1, minmax(0, 1fr));
          gap: clamp(1rem, 2vw, 2rem);
        }
        @media (min-width: 768px) {
          .thesis-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        .thesis-card {
          gap: 1rem;
        }
        .thesis-body {
          font-family: var(--font-serif-editions), HWCigars, Georgia, serif;
          font-size: 1.25rem;
          line-height: 1.15;
          letter-spacing: -0.03em;
          color: var(--ed-ink);
          margin: 0;
        }
        .thesis-code {
          font-family: var(--font-mono);
          font-size: 0.85em;
          background-color: rgba(41, 41, 25, 0.06);
          padding: 0.05em 0.4em;
          border-radius: 0.2rem;
          letter-spacing: 0;
        }
        .thesis-bullets {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          font-family: var(--font-mono);
          font-size: 0.9rem;
          color: var(--ed-ink);
        }
        .thesis-bullets li {
          display: flex;
          gap: 0.6rem;
          align-items: baseline;
        }
        .thesis-bullets span {
          color: var(--ed-ink-muted);
        }
        .thesis-bignum-wrap {
          display: flex;
          align-items: baseline;
          gap: 1rem;
          flex-wrap: wrap;
          margin-top: 0.5rem;
        }
        .thesis-bignum {
          font-family: var(--font-display-editions), NeueMontreal, Helvetica, Arial, sans-serif;
          font-weight: 700;
          font-size: clamp(4.5rem, 9vw, 7.5rem);
          line-height: 0.9;
          letter-spacing: -0.04em;
          color: var(--ed-ink);
          font-variant-numeric: tabular-nums;
        }
        .thesis-bignum-caption {
          font-family: var(--font-serif-editions), HWCigars, Georgia, serif;
          font-size: 1.1rem;
          line-height: 1.1;
          letter-spacing: -0.03em;
          color: var(--ed-ink-muted);
          max-width: 18ch;
        }
      `}</style>
    </Chapter>
  );
}
