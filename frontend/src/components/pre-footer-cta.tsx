/**
 * PreFooterCta — single zero-friction CTA band that sits between the FAQ
 * chapter and the dark closing chapter. Unicorn-landing pattern #8 ("CTA
 * is always free") + the standard pre-footer second-CTA pattern
 * (Stripe/Airbnb/Coinbase) catching scrollers who skipped the hero CTA.
 *
 * Restraint: ONE CTA, ONE secondary cta-link, no feature grid. The
 * Closing chapter that already exists handles the final-state dark
 * inverse band; this is the cream-surface call-to-action right before it
 * so the page has a clear "act now" moment without a context switch.
 *
 * No new copy claims — both ctas point at routes that already exist:
 *   - /install (the install guide, primary)
 *   - /playground (the live demo, secondary)
 */

import Link from "next/link";

export function PreFooterCta() {
  return (
    <section
      id="pre-footer-cta"
      aria-label="Get started"
      className="editions-shell"
      style={{ paddingBlock: "clamp(3.5rem, 6vw, 5.5rem)" }}
    >
      <div className="flex flex-col items-start gap-6 md:gap-7 max-w-[60ch]">
        <span className="stamp-label">Ready when you are</span>
        <h2
          className="font-display text-text-primary"
          style={{
            fontSize: "clamp(2rem, 4.2vw, 3.5rem)",
            lineHeight: 1.05,
            letterSpacing: "-0.028em",
          }}
        >
          Install once. Any website, any agent host.
        </h2>
        <p
          className="text-text-secondary"
          style={{ fontSize: "clamp(1rem, 1.2vw, 1.15rem)", maxWidth: "52ch" }}
        >
          Free to run locally. Pay only when you reuse a route someone else
          captured. No signup to try the demo.
        </p>
        <div className="flex flex-wrap items-center gap-4 mt-2">
          <Link href="/install" className="cta-primary cta-accent">
            Install Unbrowse
          </Link>
          <Link href="/playground" className="cta-link">
            Try the playground →
          </Link>
        </div>
      </div>
    </section>
  );
}
