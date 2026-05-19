'use client';

import { useAudienceMode } from "./audience-toggle";

/**
 * Hero subhead. Audience-toggle aware. Lewis's locked framing:
 * "universal direct access to anything without setting up another mcp."
 * Subhead carries the mechanism (shadow APIs captured once, called
 * directly thereafter) + the auth-inherit + the integrations.
 */
export function HeroSubhead() {
  const mode = useAudienceMode();

  if (mode === "everyone") {
    return (
      <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
        One tool, every website. Unbrowse visits a new site once to learn
        the APIs behind it, then your agent calls those APIs directly,
        signed in as you. No per-site setup, no new MCP server per service.
      </p>
    );
  }

  return (
    <p className="animate-fade-up stagger-2 mt-5 sm:mt-6 text-base sm:text-xl text-text-secondary max-w-2xl leading-relaxed">
      One MCP server, any site. First visit captures the site&apos;s shadow
      APIs; your agent calls them directly forever after, signed in with
      your cookies. Stop adding a new MCP every time you need a new
      service.
    </p>
  );
}

/**
 * Primary CTA label swap.
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
 * "Why it matters" PEEL block, everyone mode only.
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

/**
 * Hero headline. The locked frame after 6 pivots: the pain is
 * per-site MCP fragmentation + per-site setup. Unbrowse is the one
 * MCP that replaces all of them and works on any site without setup.
 *
 *   dev mode (default): "Direct access to anything on the web. /
 *     Without setting up another MCP."
 *   everyone mode keeps the prior "100x faster" framing.
 */
export function HeroHeadlineInner() {
  const mode = useAudienceMode();

  if (mode === "everyone") {
    return (
      <>
        100x faster. 95% cheaper.{" "}
        <br className="hidden sm:block" />
        <span className="text-orange-500">The API layer for AI agents.</span>
      </>
    );
  }

  return (
    <>
      Direct access to anything on the web.{" "}
      <br className="hidden sm:block" />
      <span className="text-orange-500">Without setting up another MCP.</span>
    </>
  );
}

/**
 * Hero speed-proof strip. Retuned to support the locked H1 (universal,
 * no setup, direct). Numbers anchored:
 *   - 1 MCP / for any site — architectural truth (src/mcp.ts ships 30+
 *     tools in one server)
 *   - 0 setup / per new site — captures via the resolve pipeline; no
 *     per-site MCP install needed (CLAUDE.md)
 *   - 3.6x / mean vs Playwright (n=94) — paper section 7, llms.txt:68
 */
export function HeroSpeedProofStrip() {
  const mode = useAudienceMode();

  const stats =
    mode === "everyone"
      ? [
          { v: "1 tool", l: "for every website" },
          { v: "0 setup", l: "per new site" },
          { v: "3.6x", l: "faster than Playwright" },
        ]
      : [
          { v: "1 MCP", l: "for any site" },
          { v: "0 setup", l: "per new site" },
          { v: "3.6x", l: "mean vs Playwright (n=94)" },
        ];

  return (
    <div className="animate-fade-up stagger-1 mb-2 flex flex-wrap items-stretch justify-center gap-x-1.5 gap-y-2 font-mono">
      {stats.map((s, i) => (
        <span
          key={s.l}
          className="inline-flex items-baseline gap-1.5 px-3 py-1.5 bg-[#070503]/85 border border-[rgba(255,122,32,0.22)] rounded-sm text-xs"
        >
          <span className="text-orange-500 font-medium">{s.v}</span>
          <span className="text-text-muted text-[10px] uppercase tracking-[0.15em]">
            {s.l}
          </span>
          {i < stats.length - 1 && (
            <span className="hidden sm:inline text-[rgba(255,122,32,0.3)] -mr-1.5">·</span>
          )}
        </span>
      ))}
    </div>
  );
}
