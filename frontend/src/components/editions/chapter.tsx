import type { ReactNode } from "react";
import { ScrollReveal } from "./scroll-reveal";

/**
 * Chapter — Shopify-Editions-style chapter section on the cream surface.
 *
 * Layout invariants (SPEC §3):
 *   border-top: 1px solid #909083 (the hairline; static, NOT animated)
 *   first chapter has no top border (handled by .chapter-first or :first-of-type)
 *   number is a plain numeral like [01], NOT a circular badge
 *   lede is HWCigars serif (mapped to --font-serif-editions in our build)
 *
 * Motion: inner shell wraps in ScrollReveal so child opacity-fades stagger
 * via the `--i` index. Hairline itself is NOT animated (per §7).
 */
export function Chapter({
  id,
  number,
  name,
  title,
  lede,
  first,
  reveal = true,
  children,
}: {
  id: string;
  number?: string;
  name?: string;
  title?: ReactNode;
  lede?: ReactNode;
  first?: boolean;
  reveal?: boolean;
  children?: ReactNode;
}) {
  const inner = (
    <div className="editions-shell">
      {(number || name) && (
        <div
          className="chapter-eyebrow"
          data-reveal-child
          style={{ ["--i" as string]: 0 } as React.CSSProperties}
        >
          {number && <span className="ed-number">{number}</span>}
          {name && <span>{name}</span>}
        </div>
      )}
      {title && (
        <h2
          className="chapter-title mt-8"
          data-reveal-child
          style={{ ["--i" as string]: 1 } as React.CSSProperties}
        >
          {title}
        </h2>
      )}
      {lede && (
        <p
          className="chapter-lede mt-8 max-w-[34ch]"
          data-reveal-child
          style={{ ["--i" as string]: 2 } as React.CSSProperties}
        >
          {lede}
        </p>
      )}
      {children !== undefined && (
        <div
          className="mt-12"
          data-reveal-child
          style={{ ["--i" as string]: 3 } as React.CSSProperties}
        >
          {children}
        </div>
      )}
    </div>
  );

  const cls = first ? "chapter chapter-first" : "chapter";
  if (!reveal) {
    return (
      <section id={id} data-chapter={id} className={cls}>
        {inner}
      </section>
    );
  }
  return (
    <ScrollReveal as="section" id={id} data-chapter={id} className={cls}>
      {inner}
    </ScrollReveal>
  );
}

/**
 * FeatureCard — title + description + optional CTA link, sitting on
 * a contained cream-card surface. Used for sub-feature rows.
 */
export function FeatureCard({
  title,
  description,
  href,
  cta,
}: {
  title: ReactNode;
  description: ReactNode;
  href?: string;
  cta?: string;
}) {
  return (
    <article className="feature-card">
      <h3>{title}</h3>
      <p>{description}</p>
      {href && (
        <a href={href} className="cta-link mt-2">
          {cta ?? "Read more"}
        </a>
      )}
    </article>
  );
}

/**
 * FeatureGrid — responsive grid, default 2-up, optional 3-up at lg.
 */
export function FeatureGrid({
  cols = 2,
  children,
}: {
  cols?: 2 | 3;
  children: ReactNode;
}) {
  return (
    <div className={cols === 3 ? "feature-grid feature-grid-3" : "feature-grid"}>
      {children}
    </div>
  );
}

/**
 * CtaLink — underline link with the editions wordmark style.
 */
export function CtaLink({
  href,
  children,
  external,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      className="cta-link"
      {...(external && { target: "_blank", rel: "noopener noreferrer" })}
    >
      {children}
    </a>
  );
}

/**
 * Stat — large display number + caption. Used in stats bands.
 */
export function Stat({
  value,
  label,
  sub,
}: {
  value: ReactNode;
  label: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="tabular-nums"
        style={{
          fontFamily: "var(--font-display-editions), NeueMontreal, Helvetica, Arial, sans-serif",
          fontWeight: 700,
          fontSize: "clamp(2.25rem, 4vw, 3.5rem)",
          lineHeight: 1,
          letterSpacing: "-0.028em",
          color: "var(--ed-ink)",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "0.75rem",
          textTransform: "uppercase",
          letterSpacing: "0.2em",
          color: "var(--ed-ink-muted)",
        }}
      >
        {label}
      </div>
      {sub && (
        <div style={{ fontSize: "0.875rem", color: "var(--ed-ink-muted)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * Hairline — 1px static solid divider (#909083). Per SPEC §7, hairlines
 * are NEVER animated. They are full-bleed, 1px, solid.
 */
export function Hairline({ faint }: { faint?: boolean }) {
  return <hr className={faint ? "hairline-faint" : "hairline"} />;
}
