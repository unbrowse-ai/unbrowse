'use client';

import { useAudienceMode } from "./audience-toggle";

/**
 * Hero subhead that swaps between dev (default) and normie (PEEL-structured)
 * copy based on the audience-mode pill. Both variants stay under the
 * unicorn-pattern hero word budget.
 */
export function HeroSubhead() {
  const mode = useAudienceMode();

  if (mode === "everyone") {
    return (
      <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
        Your AI agent reads websites in half a second instead of half a minute.
        Same data, fraction of the time, no more agents stuck on slow pages.
      </p>
    );
  }

  return (
    <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
      Your agent calls the site&apos;s real API instead of driving a browser.
      Plugs into OpenClaw, Claude Desktop, Cursor, and any MCP-aware framework.
    </p>
  );
}

/**
 * Primary CTA label swap. Dev mode shows the literal install command;
 * everyone mode shows the outcome-named button.
 */
export function HeroPrimaryCtaLabel() {
  const mode = useAudienceMode();
  return (
    <span className="flex items-center justify-center gap-2">
      {mode === "everyone" ? "[ Install free ]" : "[ npx unbrowse setup → ]"}
    </span>
  );
}

/**
 * "Why it matters" PEEL block, only shown in everyone mode. Renders below
 * the CTA group, inside the hero centered column.
 */
export function HeroWhyItMatters() {
  const mode = useAudienceMode();
  if (mode !== "everyone") return null;

  return (
    <div className="animate-fade-up stagger-3 mt-12 max-w-2xl">
      <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.5)] mb-3 text-left">
        ##  Why it matters
      </p>
      <p className="text-sm sm:text-base text-text-secondary leading-relaxed text-left">
        Once one person finds the fast path through a website, every other
        agent gets it for free. Unbrowse already covers 600+ websites, and
        over a million agent visits have used what previous visitors
        discovered. The more people use it, the faster it gets for everyone,
        instead of every agent redoing the same slow work on the same sites.
        That is how a free, open-source tool quietly becomes the default
        way agents read the web.
      </p>
    </div>
  );
}
