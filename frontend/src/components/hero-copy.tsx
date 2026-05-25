'use client';

import { useAudienceMode } from "./audience-toggle";

/**
 * Hero subhead. Audience-toggle aware.
 *
 * Banger Wave 1 (2026-05-26): tightened to ≤15 words per spec.
 *   - agent (default): the call-the-shadow-API frame.
 *   - publisher: the earn-USDC frame, supply-side flywheel.
 */
export function HeroSubhead() {
  const mode = useAudienceMode();

  if (mode === "publisher") {
    return (
      <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
        Your route is the moat. When the next agent calls it, you earn
        USDC on Solana via Faremeter Flex.
      </p>
    );
  }

  return (
    <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
      One MCP server, any site. Your agent calls the shadow API, not
      the browser.
    </p>
  );
}

/**
 * Primary CTA label swap.
 *   - agent: install-and-call-the-API canonical command.
 *   - publisher: same install, --mining hint exposes the earnings flow.
 */
export function HeroPrimaryCtaLabel() {
  const mode = useAudienceMode();
  return (
    <span className="flex items-center justify-center gap-2">
      {mode === "publisher" ? "[ npx unbrowse setup --mining → ]" : "[ npx unbrowse setup → ]"}
    </span>
  );
}

/**
 * "Why it matters" PEEL block — RETAINED for backward-compat, but now
 * returns null from hero callsites (Banger W1 lifted it out of the hero
 * to honor the ≤30-word hero cap). Still rendered mid-page via a
 * separate consumer if/when needed; for now no caller mounts it.
 */
export function HeroWhyItMatters() {
  // Banger W1: hero hard-caps at ≤30 words. Why-it-matters now lives
  // mid-page inside the flywheel chapter (page.tsx).
  return null;
}

/**
 * Hero headline.
 *
 * Banger Wave 1 (2026-05-26): unicorn-tier H1 cut.
 *   Previous (locked after 6 pivots): "Direct access to anything on
 *     the web. Without setting up another MCP." (12 words)
 *   New: "The API layer for AI agents." (7 words, +1 with period = 8)
 *
 * Why the lock broke: the unicorn-landing audit (8-tier survey of
 * Stripe / Coinbase / Linear / Vercel hero patterns) showed every
 * reference landing renders the category claim in ≤8 words. The prior
 * H1 leans on negation ("without setting up another MCP") which forces
 * the reader to know what MCP is before the value lands. The new H1
 * states the category directly; the subhead carries the mechanism.
 * See .editions-evidence/UNICORN-AUDIT.md.
 *
 * agent + publisher modes both render the same H1 — the category
 * is the same; only the subhead/CTA framing flips.
 */
export function HeroHeadlineInner() {
  return (
    <>
      The API layer{" "}
      <br className="hidden sm:block" />
      <span className="text-orange-500">for AI agents.</span>
    </>
  );
}

/**
 * Hero speed-proof strip. Three short pills — anchored numbers only.
 *   - 1 MCP / for any site — architectural truth (src/mcp.ts ships 30+
 *     tools in one server)
 *   - 0 setup / per new site — captures via the resolve pipeline
 *   - 3.6x / mean vs Playwright (n=94) — paper section 7, llms.txt:68
 *
 * Banger W1: keeps the 3-pill layout (CLS lock matches Suspense
 * fallback in page.tsx). Publisher mode swaps the third pill to the
 * earnings number.
 */
export function HeroSpeedProofStrip() {
  const mode = useAudienceMode();

  const stats =
    mode === "publisher"
      ? [
          { v: "USDC", l: "settled on Solana" },
          { v: "0 setup", l: "to start earning" },
          { v: "first-mover", l: "2x reward rate" },
        ]
      : [
          { v: "1 MCP", l: "for any site" },
          { v: "0 setup", l: "per new site" },
          { v: "3.6x", l: "mean vs Playwright (n=94)" },
        ];

  return (
    <div className="animate-fade-up stagger-1 mb-2 flex flex-wrap items-stretch justify-center gap-x-1.5 gap-y-2 font-mono">
      {stats.map((s) => (
        <span
          key={s.l}
          className="inline-flex items-baseline gap-2 px-3 py-1.5 bg-[#070503]/85 border border-[rgba(255,122,32,0.22)] rounded-sm text-xs"
        >
          <span className="text-orange-500 font-semibold tabular-nums tracking-tight">{s.v}</span>
          <span className="text-text-muted text-[10px] uppercase tracking-[0.18em]">
            {s.l}
          </span>
        </span>
      ))}
    </div>
  );
}
