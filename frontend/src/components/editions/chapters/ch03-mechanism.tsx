import { Chapter } from "../chapter";

/**
 * Chapter [03] — Mechanism.
 *
 * Source: merged MAY18-INVENTORY §5 UseCasesBand intro lede + §6
 * ZeroSetupBand (three defaults). Explains HOW: three-path resolve
 * (cache / marketplace / first-pass browser) and the three bypasses
 * already wired in (JA4, auth inheritance, broker-side extraction).
 *
 * No dark chapter surface. The JA4 mini-comparison is the only contained
 * dark figure; everything else lives on cream cards.
 */
export function Ch03Mechanism() {
  return (
    <Chapter
      id="mechanism"
      number="[03]"
      name="Mechanism"
      title="Browse once. Call forever."
      lede="Three-path resolve: route cache under 200ms, marketplace ~1s, first-pass browser 20-80s capturing for the next agent."
    >
      {/* Latency strip — three numeric cells with hairlines between */}
      <div className="latency-strip">
        <div className="latency-cell">
          <span className="latency-value">&lt;200ms</span>
          <span className="latency-label">route cache</span>
        </div>
        <div className="latency-cell">
          <span className="latency-value">~1s</span>
          <span className="latency-label">marketplace</span>
        </div>
        <div className="latency-cell">
          <span className="latency-value">20-80s</span>
          <span className="latency-label">first-pass browser</span>
        </div>
      </div>

      {/* Three default cards */}
      <div className="mech-grid">
        <article className="feature-card mech-card">
          <span className="mech-eyebrow">## Bot detection</span>
          <h3>JA4 fingerprint of a real Chrome.</h3>
          <p className="mech-body">
            <code className="mech-code">unbrowse_fetch</code> ships with
            libcurl-impersonate. Turnstile, Datadome, PerimeterX usually
            never fire. Residential-proxy fallback is one env var away.
          </p>
          <div className="ed-dark-figure mech-darkmini">
            <div className="ja4-row">
              <span className="ja4-out">Headless Chrome (default JA4)</span>
              <span className="ja4-verdict ja4-verdict-bad">flagged</span>
            </div>
            <div className="ja4-row">
              <span className="ja4-in">unbrowse JA4 + your cookies</span>
              <span className="ja4-verdict ja4-verdict-good">200 OK</span>
            </div>
          </div>
        </article>

        <article className="feature-card mech-card">
          <span className="mech-eyebrow">## Auth intelligence</span>
          <h3>Your agent inherits your login. And knows when it dies.</h3>
          <p className="mech-body">
            Chrome + Firefox cookie jars are read in-place; the ranker
            demotes <code className="mech-code">auth_walled</code>{" "}
            endpoints. Three login-hint surfaces: Keychain, browser, agent
            prompt.
          </p>
        </article>

        <article className="feature-card mech-card">
          <span className="mech-eyebrow">## Extraction</span>
          <h3>Markdown out. Not innerHTML.</h3>
          <p className="mech-body">
            Extraction runs inside the browser broker, not as injected JS,
            so CSP-strict sites work. Endpoint descriptions are
            LLM-authored at capture time.
          </p>
        </article>
      </div>

      <style>{`
        .latency-strip {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 0;
          border-top: 1px solid var(--ed-hairline-faint);
          border-bottom: 1px solid var(--ed-hairline-faint);
          margin-bottom: clamp(2rem, 4vw, 3rem);
        }
        .latency-cell {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 0.4rem;
          padding: clamp(1rem, 2vw, 1.75rem) clamp(0.75rem, 1.5vw, 1.5rem);
          border-right: 1px solid var(--ed-hairline-faint);
        }
        .latency-cell:last-child {
          border-right: 0;
        }
        .latency-value {
          font-family: var(--font-mono);
          font-size: clamp(1.5rem, 3vw, 2.25rem);
          line-height: 1;
          letter-spacing: -0.02em;
          color: var(--ed-ink);
          font-variant-numeric: tabular-nums;
        }
        .latency-label {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: var(--ed-ink-muted);
        }
        .mech-grid {
          display: grid;
          grid-template-columns: repeat(1, minmax(0, 1fr));
          gap: clamp(1rem, 2vw, 1.75rem);
        }
        @media (min-width: 768px) {
          .mech-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
        .mech-card {
          gap: 0.85rem;
        }
        .mech-eyebrow {
          font-family: var(--font-mono);
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.25em;
          color: var(--ed-ink-muted);
        }
        .mech-body {
          font-family: var(--font-serif-editions), HWCigars, Georgia, serif;
          font-size: 1.125rem;
          line-height: 1.2;
          letter-spacing: -0.03em;
          color: var(--ed-ink);
          margin: 0;
        }
        .mech-code {
          font-family: var(--font-mono);
          font-size: 0.85em;
          background-color: rgba(41, 41, 25, 0.06);
          padding: 0.05em 0.4em;
          border-radius: 0.2rem;
          letter-spacing: 0;
        }
        .editions-surface .mech-darkmini {
          padding: 1rem 1.25rem;
          font-size: 0.8rem;
          margin: 0.5rem 0 0;
        }
        .ja4-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.4rem 0;
          border-bottom: 1px solid rgba(247, 247, 238, 0.12);
        }
        .ja4-row:last-child {
          border-bottom: 0;
        }
        .ja4-out {
          color: rgba(247, 247, 238, 0.55);
          text-decoration: line-through;
        }
        .ja4-in {
          color: var(--ed-cream-warm);
        }
        .ja4-verdict {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.15em;
          padding: 0.1rem 0.5rem;
          border-radius: 0.2rem;
        }
        .ja4-verdict-bad {
          color: rgba(247, 247, 238, 0.65);
          background-color: rgba(247, 247, 238, 0.08);
        }
        .ja4-verdict-good {
          color: var(--ed-cream-warm);
          background-color: rgba(247, 247, 238, 0.16);
        }
      `}</style>
    </Chapter>
  );
}
