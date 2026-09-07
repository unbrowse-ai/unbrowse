import { ScrollReveal, WordSplit } from "./scroll-reveal";

/**
 * EditionsHero — cream-surface hero (Chapter 00, no top border).
 *
 * Per SPEC:
 *   - .ed-headline-1 clamp(7.5rem, …, 13.75rem) — Bricolage Grotesque 700
 *   - .ed-narrative-1 lede — Instrument Serif (HWCigars substitute)
 *   - Word stagger: opacity-only fade-in, no translate
 *   - Two CTAs: dark-ink primary, underline secondary
 *   - Below CTAs: speed-proof strip
 *
 * Hero is rendered as a Chapter section with `chapter-first` so it has no
 * top border (SPEC §3). Sits on cream, no decorative overlay.
 */
export function EditionsHero({
  headline = ["Direct access to anything on the web.", "Without setting up another MCP."],
  lede = "One MCP server, any site. First visit captures the site's shadow APIs; your agent calls them directly forever after, signed in with your cookies.",
  primaryHref = "#install",
  primaryLabel = "npx unbrowse setup",
  secondaryHref = "/internal-apis-are-all-you-need",
  secondaryLabel = "Read the paper",
}: {
  headline?: string | string[];
  lede?: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <ScrollReveal
      as="section"
      id="hero"
      data-chapter="hero"
      className="chapter chapter-first editions-hero"
    >
      <div className="editions-shell">
        <h1
          className="ed-headline-1"
          data-reveal-child
          style={{ ["--i" as string]: 0 } as React.CSSProperties}
        >
          <WordSplit text={headline} />
        </h1>

        <p
          className="ed-narrative-1 mt-10 max-w-[42ch]"
          data-reveal-child
          style={{ ["--i" as string]: 1 } as React.CSSProperties}
        >
          {lede}
        </p>

        <div
          className="mt-12 flex flex-wrap items-center gap-6"
          data-reveal-child
          style={{ ["--i" as string]: 2 } as React.CSSProperties}
        >
          <a href={primaryHref} className="ed-cta-primary">
            <span>{primaryLabel}</span>
            <span aria-hidden>{"->"}</span>
          </a>
          <a href={secondaryHref} className="ed-cta-secondary">
            {secondaryLabel}
          </a>
        </div>

        <div
          className="ed-proof-strip mt-16"
          data-reveal-child
          style={{ ["--i" as string]: 3 } as React.CSSProperties}
        >
          <span>
            <strong>1 MCP</strong> / any site
          </span>
          <span>
            <strong>0 setup</strong> / new site
          </span>
          <span>
            <strong>3.6x mean</strong> (n=94)
          </span>
        </div>
      </div>
    </ScrollReveal>
  );
}
