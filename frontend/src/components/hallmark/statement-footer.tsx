import Link from "next/link";

/**
 * StatementFooter — Hallmark Ft5 archetype, archival surface.
 *
 * Replaces the prior fixed-bottom chrome bar. End-of-page closer,
 * dark band, one statement line + minimal link row.
 * All colors and fonts reference --hl-* tokens (gate 58).
 */
export function StatementFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="hl-statement" aria-label="Site footer">
      <div className="hl-statement__inner">
        <p className="hl-statement__line">
          One MCP for every site. <em style={{ fontStyle: "normal", color: "var(--hl-accent)" }}>The API layer for AI agents.</em>
        </p>
        <div className="hl-statement__row">
          <span className="hl-statement__copy">
            $ &copy; {year} Unbrowse AI Pte. Ltd.
          </span>
          <a
            href="https://github.com/unbrowse-ai/unbrowse"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <Link href="/papers">Paper</Link>
          <Link href="/faq">FAQ</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </div>
      </div>
    </footer>
  );
}
