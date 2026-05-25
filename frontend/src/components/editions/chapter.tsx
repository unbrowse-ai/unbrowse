import type { ReactNode } from "react";
import { ScrollReveal } from "./scroll-reveal";

/**
 * Chapter — top-level editions section. Hairline rule above, generous
 * vertical rhythm, scroll-triggered reveal on the inner content.
 *
 * Motion: the inner shell is wrapped in <ScrollReveal>, so the eyebrow,
 * title, lede, and children fade-up together once ~18% of the section
 * crosses the viewport. Children that opt in with the `data-reveal-child`
 * attribute and a CSS `--i` index get a stagger.
 */
export function Chapter({
  id,
  number,
  name,
  title,
  lede,
  inverse,
  reveal = true,
  children,
}: {
  id: string;
  number?: string;
  name?: string;
  title?: ReactNode;
  lede?: ReactNode;
  inverse?: boolean;
  reveal?: boolean;
  children?: ReactNode;
}) {
  const inner = (
    <div className="editions-shell">
      {/* Animated hairline rule that paints across the chapter top on reveal.
          Mirrors shopify.com/editions/winter2026's chapter-divider motion;
          uses the line-fade keyframe with origin-left scaleX 0→1. */}
      <div className="chapter-rule" data-reveal-child aria-hidden style={{ ["--i" as string]: -1 } as React.CSSProperties} />
      {(number || name) && (
        <div className="chapter-eyebrow" data-reveal-child style={{ ["--i" as string]: 0 } as React.CSSProperties}>
          {number && <span>{number}</span>}
          {name && <span>{name}</span>}
        </div>
      )}
      {title && (
        <h2 className="chapter-title" data-reveal-child style={{ ["--i" as string]: 1 } as React.CSSProperties}>
          {title}
        </h2>
      )}
      {lede && (
        <p className="chapter-lede" data-reveal-child style={{ ["--i" as string]: 2 } as React.CSSProperties}>
          {lede}
        </p>
      )}
      <div data-reveal-child style={{ ["--i" as string]: 3 } as React.CSSProperties}>
        {children}
      </div>
    </div>
  );

  const cls = inverse ? "chapter chapter-inverse" : "chapter";
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
 * FeatureCard — title + 1-line description + optional CTA link.
 * Hover bounces 2px on the editions ease-bounce-out curve.
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
 * CtaLink — underline-with-arrow link, Shopify-editions style.
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
        className="font-display tabular-nums text-text-primary"
        style={{
          fontSize: "clamp(2.25rem, 4vw, 3.5rem)",
          lineHeight: 1,
          letterSpacing: "-0.028em",
        }}
      >
        {value}
      </div>
      <div className="stamp-label">{label}</div>
      {sub && <div className="text-sm text-text-muted">{sub}</div>}
    </div>
  );
}

/**
 * Hairline — single hairline divider. Animates its width on reveal.
 */
export function Hairline({ strong }: { strong?: boolean }) {
  return <hr className={`${strong ? "hairline-strong" : "hairline"} animate-line-fade`} />;
}
