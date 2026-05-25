import Link from "next/link";
import { Github } from "lucide-react";

/**
 * EditionsFooter — Shopify-Editions-style footer on cream `#dcdcd0`.
 *
 * Pattern:
 *   - GitHub-star eyebrow row at top (small, mono, uppercase)
 *   - L2 tagline "infrastructure for the agentic internet"
 *   - Four category columns (Product / Developer / Resources / Company)
 *   - Hairline divider
 *   - Copyright + small legal row
 *
 * No dark fills. Ink text on cream. Mono uppercase column labels.
 * Link inventory mirrors `site-footer.tsx`; the styling is restyled
 * for the cream surface.
 */

type FooterLink = { href: string; label: string };

const PRODUCT_LINKS: FooterLink[] = [
  { href: "/", label: "Overview" },
  { href: "/#install", label: "Install" },
  { href: "/#demo", label: "Demo" },
  { href: "/miners", label: "Miners" },
  { href: "/leaderboard", label: "Leaderboard" },
];

const DEVELOPER_LINKS: FooterLink[] = [
  { href: "https://github.com/unbrowse-ai/unbrowse", label: "GitHub" },
  { href: "https://www.npmjs.com/package/unbrowse", label: "npm" },
  { href: "/llms.txt", label: "llms.txt" },
  { href: "/.well-known/ai-plugin.json", label: "ai-plugin.json" },
];

const RESOURCES_LINKS: FooterLink[] = [
  { href: "/internal-apis-are-all-you-need", label: "Whitepaper" },
  { href: "/how-unbrowse-pays", label: "How Unbrowse pays" },
  { href: "/papers", label: "Papers" },
  { href: "/blog", label: "Blog" },
  { href: "/faq", label: "FAQ" },
  { href: "/compare/playwright", label: "vs. Playwright" },
];

const COMPANY_LINKS: FooterLink[] = [
  { href: "https://discord.gg/VWugEeFNsG", label: "Discord" },
  { href: "https://x.com/getFoundry", label: "X / @getFoundry" },
  { href: "/openclaw-earn", label: "Earn" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
];

function FooterColumn({ heading, links }: { heading: string; links: FooterLink[] }) {
  return (
    <div className="ed-footer-col">
      <p className="ed-footer-col-heading">{heading}</p>
      <ul className="ed-footer-col-list">
        {links.map((link) => {
          const external =
            link.href.startsWith("http") ||
            link.href.endsWith(".txt") ||
            link.href.endsWith(".md") ||
            link.href.endsWith(".json");
          return (
            <li key={link.href}>
              {external ? (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener"
                  className="ed-footer-link"
                >
                  {link.label}
                </a>
              ) : (
                <Link href={link.href} className="ed-footer-link">
                  {link.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function EditionsFooter() {
  return (
    <footer className="ed-footer" data-global-chrome="editions-footer">
      <div className="editions-shell">
        {/* GitHub-star eyebrow */}
        <div className="ed-footer-eyebrow">
          <span className="ed-footer-eyebrow-label">## Unbrowse</span>
          <a
            href="https://github.com/unbrowse-ai/unbrowse"
            target="_blank"
            rel="noopener"
            className="ed-footer-eyebrow-link"
          >
            <Github className="ed-footer-eyebrow-icon" aria-hidden="true" />
            Star on GitHub
          </a>
        </div>

        {/* L2 tagline */}
        <p className="ed-footer-tagline">
          Infrastructure for the agentic internet.
          <span className="ed-footer-tagline-sub">
            Capture once, replay forever. One agent&apos;s capture is every
            agent&apos;s speed-up.
          </span>
        </p>

        {/* Category columns */}
        <div className="ed-footer-cols">
          <FooterColumn heading="Product" links={PRODUCT_LINKS} />
          <FooterColumn heading="Developer" links={DEVELOPER_LINKS} />
          <FooterColumn heading="Resources" links={RESOURCES_LINKS} />
          <FooterColumn heading="Company" links={COMPANY_LINKS} />
        </div>

        <hr className="hairline ed-footer-divider" />

        {/* Copyright + legal */}
        <div className="ed-footer-bottom">
          <span>&copy; {new Date().getFullYear()} Unbrowse AI Pte. Ltd.</span>
          <span className="ed-footer-bottom-sep" aria-hidden="true">
            ·
          </span>
          <span>Free, open source, AGPL-3.0</span>
        </div>
      </div>

      <style>{`
        .editions-surface .ed-footer {
          background-color: var(--ed-cream);
          color: var(--ed-ink);
          border-top: 1px solid var(--ed-hairline);
          padding: clamp(3rem, 6vw, 5rem) clamp(1rem, 4vw, 6rem);
        }
        .editions-surface .ed-footer-eyebrow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          margin-bottom: clamp(1.5rem, 3vw, 2.25rem);
          flex-wrap: wrap;
        }
        .editions-surface .ed-footer-eyebrow-label {
          font-family: var(--font-mono);
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.3em;
          color: var(--ed-ink-muted);
        }
        .editions-surface .ed-footer-eyebrow-link {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-family: var(--font-mono);
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.2em;
          color: var(--ed-ink);
          text-decoration: none;
          padding: 0.4rem 0.75rem;
          border: 1px solid var(--ed-hairline);
          border-radius: 999px;
          transition: background-color 0.15s ease;
        }
        .editions-surface .ed-footer-eyebrow-link:hover {
          background-color: var(--ed-cream-card);
        }
        .editions-surface .ed-footer-eyebrow-icon {
          width: 0.95rem;
          height: 0.95rem;
        }
        .editions-surface .ed-footer-tagline {
          font-family: var(--font-display-editions), NeueMontreal, Helvetica, Arial, sans-serif;
          font-weight: 700;
          font-size: clamp(2rem, 4vw, 3rem);
          line-height: 0.95;
          letter-spacing: -0.03em;
          color: var(--ed-ink);
          margin: 0 0 clamp(2.5rem, 5vw, 4rem) 0;
          max-width: 28ch;
        }
        .editions-surface .ed-footer-tagline-sub {
          display: block;
          font-family: var(--font-serif-editions), HWCigars, Georgia, serif;
          font-weight: 400;
          font-size: 1.25rem;
          line-height: 1.1;
          letter-spacing: -0.04em;
          color: var(--ed-ink-muted);
          margin-top: 0.75rem;
          max-width: 40ch;
        }
        .editions-surface .ed-footer-cols {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: clamp(2rem, 4vw, 3rem);
          margin-bottom: clamp(2rem, 4vw, 3rem);
        }
        @media (min-width: 768px) {
          .editions-surface .ed-footer-cols {
            grid-template-columns: repeat(4, minmax(0, 1fr));
          }
        }
        .editions-surface .ed-footer-col {
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
        }
        .editions-surface .ed-footer-col-heading {
          font-family: var(--font-mono);
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.25em;
          color: var(--ed-ink-muted);
          margin: 0;
        }
        .editions-surface .ed-footer-col-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
        }
        .editions-surface .ed-footer-link {
          font-family: var(--font-mono);
          font-size: 0.875rem;
          color: var(--ed-ink);
          text-decoration: none;
          opacity: 0.85;
          transition: opacity 0.15s ease;
        }
        .editions-surface .ed-footer-link:hover {
          opacity: 1;
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        .editions-surface .ed-footer-divider {
          margin: clamp(1.5rem, 3vw, 2.5rem) 0 clamp(1rem, 2vw, 1.5rem);
        }
        .editions-surface .ed-footer-bottom {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.6rem;
          font-family: var(--font-mono);
          font-size: 0.75rem;
          color: var(--ed-ink-muted);
        }
        .editions-surface .ed-footer-bottom-sep {
          opacity: 0.5;
        }
      `}</style>
    </footer>
  );
}
