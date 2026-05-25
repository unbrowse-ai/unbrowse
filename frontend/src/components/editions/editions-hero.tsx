import type { ReactNode } from "react";
import { WordSplit } from "./scroll-reveal";

/**
 * EditionsHero — editions hero with edition label, large display title,
 * lede, and CTA row. Motion: title accepts either a `splitTitle` string
 * (word-by-word slide-in matching Shopify's `.title__word` slide
 * keyframe) or a `title` ReactNode (no split — used when the headline
 * needs structural breaks the splitter can't infer).
 */
export function EditionsHero({
  eyebrow,
  title,
  splitTitle,
  splitTrailing,
  lede,
  primaryCta,
  primaryHref,
  secondaryCta,
  secondaryHref,
  meta,
}: {
  eyebrow?: string;
  title?: ReactNode;
  splitTitle?: string | string[];
  splitTrailing?: ReactNode;
  lede: ReactNode;
  primaryCta: string;
  primaryHref: string;
  secondaryCta?: string;
  secondaryHref?: string;
  meta?: ReactNode;
}) {
  return (
    <section className="editions-hero relative">
      <div className="editions-shell" style={{ paddingBlock: "clamp(4rem, 9vw, 8rem)" }}>
        {eyebrow && (
          <div
            className="stamp-label mb-6 flex items-center gap-3 animate-fade-up"
            style={{ animationDuration: "0.6s" }}
          >
            <span>{eyebrow}</span>
          </div>
        )}
        <h1 className="editions-hero-h1">
          {splitTitle ? <WordSplit text={splitTitle} /> : title}
          {splitTrailing && <span className="block">{splitTrailing}</span>}
        </h1>
        <p
          className="mt-8 animate-fade-up stagger-3 max-w-[58ch] text-text-secondary"
          style={{ fontSize: "clamp(1.125rem, 1.6vw, 1.375rem)", lineHeight: 1.45 }}
        >
          {lede}
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3 animate-fade-up stagger-4">
          <a href={primaryHref} className="cta-primary cta-accent">
            {primaryCta}
          </a>
          {secondaryCta && secondaryHref && (
            <a href={secondaryHref} className="cta-link">
              {secondaryCta}
            </a>
          )}
        </div>
        {meta && (
          <div className="mt-12 animate-fade-up stagger-5 text-sm text-text-muted">
            {meta}
          </div>
        )}
      </div>
    </section>
  );
}
