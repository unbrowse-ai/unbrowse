'use client';

import Link from "next/link";
import { IconCompass, IconDiamondCheck, IconArrow } from "./archival-icons";

/**
 * UniversalProofBand — four cards proving what "universal MCP" means:
 *   1. Drop-in Playwright Browser class (llms.txt:74; codebase U1)
 *   2. Two-call canonical loop (resolve + execute); 30+ MCP tools as
 *      cold-fallback (src/mcp.ts tool registrations)
 *   3. 94 live domains in the open bench; 3.6x mean / 5.4x median
 *      speedup over Playwright (paper section 7, llms.txt:68)
 *   4. Compounding flywheel: every install captures new cold sites
 *      to the shared marketplace (CLAUDE.md resolve pipeline)
 *
 * Honesty note: an earlier draft of Card 3 claimed "+24% over browsing
 * agents on WebArena" as our own measurement. That number is from
 * Song et al. "Beyond Browsing: API-Based Web Agents", cited in our
 * paper section 2.1 as related work — NOT our measurement. Removed.
 */
export function UniversalProofBand() {
  return (
    <section id="universal" className="relative py-16 sm:py-24 flex flex-col justify-center">
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 min-w-0">
        <div className="text-center mb-8 flex flex-col items-center">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
            ##  What &quot;universal&quot; means here
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary max-w-3xl">
            One MCP server. One Browser class. Every website your agent points at.
          </h2>
          <p className="text-sm sm:text-base text-text-secondary mt-3 max-w-2xl leading-relaxed">
            Not a stack of per-site MCPs. Not another framework on top of
            Playwright. The web layer your agent already wants.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

          {/* Card 1 — Drop-in Playwright */}
          <div className="group relative p-5 sm:p-6 border border-[rgba(255,122,32,0.25)] bg-[#070503]/90 overflow-hidden hover:border-[rgba(255,122,32,0.4)] rounded-sm flex flex-col">
            <div className="mb-3 flex items-center gap-2 text-orange-500">
              <IconCompass size={16} />
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Drop-in</span>
            </div>
            <h3 className="text-lg sm:text-xl font-semibold mb-2 tracking-tight">Already wrote Playwright code? Swap the import.</h3>
            <p className="text-text-secondary text-sm leading-relaxed mb-4">
              The unbrowse SDK ships a Browser class with the same shape your
              agent already calls. <code className="text-orange-500 font-mono">page.goto()</code> resolves from the skill cache
              first; behind the familiar interface, the engine is calling the
              captured shadow API, not driving Chromium. Falls through to the
              real browser only when the route is not yet known.
            </p>
            <div className="bg-[#060402] border border-[rgba(255,122,32,0.22)] p-3.5 mt-auto rounded-sm font-mono text-xs leading-[1.6]">
              <div className="text-[rgba(120,108,96,0.85)] line-through mb-1.5">
                import {"{"} chromium {"}"} from &quot;playwright&quot;;
              </div>
              <div className="text-orange-500 font-medium">
                import {"{"} Browser {"}"} from &quot;@unbrowse/sdk&quot;;
              </div>
            </div>
          </div>

          {/* Card 2 — resolve + execute canonical loop */}
          <div className="group relative p-5 sm:p-6 border border-[rgba(255,122,32,0.25)] bg-[#070503]/90 overflow-hidden hover:border-[rgba(255,122,32,0.4)] rounded-sm flex flex-col">
            <div className="mb-3 flex items-center gap-2 text-orange-500">
              <IconCompass size={16} />
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">MCP surface</span>
            </div>
            <h3 className="text-lg sm:text-xl font-semibold mb-2 tracking-tight">Two tool calls do most of the work.</h3>
            <p className="text-text-secondary text-sm leading-relaxed mb-4">
              The canonical loop is{" "}
              <code className="text-[rgba(255,176,96,0.95)] font-mono">unbrowse_resolve</code>{" "}
              (find the right captured endpoint) then{" "}
              <code className="text-[rgba(255,176,96,0.95)] font-mono">unbrowse_execute</code>{" "}
              (call it with your cookies). 30+ other MCP tools{" "}
              (<code className="text-[10px]">_go, _snap, _click, _fill, _submit, _eval, _scroll, _press, _select, _cookies, _auth_capture</code>) are there for the
              cold-discovery path when a new site has not been captured yet.
            </p>
            <div className="pt-3 border-t border-[rgba(255,122,32,0.15)] mt-auto space-y-1.5 text-sm">
              <div className="flex items-center gap-2 text-text-secondary">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0" /> One <code className="text-xs font-mono">mcp.json</code> entry replaces your stack
              </div>
              <div className="flex items-center gap-2 text-text-secondary">
                <IconDiamondCheck size={14} className="text-orange-500 shrink-0" /> New site appears: same server, no config edit
              </div>
            </div>
          </div>

          {/* Card 3 — Bench coverage (numbers from OUR paper only) */}
          <div className="group relative p-5 sm:p-6 border border-[rgba(255,122,32,0.25)] bg-[#070503]/90 overflow-hidden hover:border-[rgba(255,122,32,0.4)] rounded-sm flex flex-col">
            <div className="mb-3 flex items-center gap-2 text-orange-500">
              <IconCompass size={16} />
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Coverage</span>
            </div>
            <h3 className="text-lg sm:text-xl font-semibold mb-2 tracking-tight">
              <span className="font-display text-2xl sm:text-3xl text-orange-500 tabular-nums tracking-[-0.03em]">94</span>{" "}
              live domains in the open bench.
            </h3>
            <p className="text-text-secondary text-sm leading-relaxed mb-4">
              The paper measures <span className="text-orange-300 font-medium tabular-nums">3.6x</span> mean speedup
              (<span className="text-orange-300 font-medium tabular-nums">5.4x</span> median) over
              Playwright across 94 live domains. <span className="text-orange-300 font-medium tabular-nums">18</span> of those domains complete
              in under 100ms from the cache. The corpus is at{" "}
              <code className="text-xs font-mono">harness/probes/corpus.txt</code>; rerun the bench yourself.
            </p>
            <Link
              href="/internal-apis-are-all-you-need"
              className="inline-flex items-center gap-1.5 text-xs font-mono text-[rgba(255,176,96,0.85)] hover:text-orange-500 transition-colors mt-auto"
            >
              Read the paper{" "}
              <IconArrow size={11} className="group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>

          {/* Card 4 — Compounding flywheel */}
          <div className="group relative p-5 sm:p-6 border border-[rgba(255,122,32,0.25)] bg-[#070503]/90 overflow-hidden hover:border-[rgba(255,122,32,0.4)] rounded-sm flex flex-col">
            <div className="mb-3 flex items-center gap-2 text-orange-500">
              <IconCompass size={16} />
              <span className="text-xs font-mono uppercase tracking-[0.2em] text-text-muted">Compounds</span>
            </div>
            <h3 className="text-lg sm:text-xl font-semibold mb-2 tracking-tight">Every install makes the next user faster.</h3>
            <p className="text-text-secondary text-sm leading-relaxed mb-4">
              When your agent hits a site nobody has captured yet, the
              first-pass browser captures it once and publishes the route to
              the shared marketplace. The next agent on the same site (yours
              or someone else&apos;s) skips the browser entirely. The cold-start
              tax shrinks across the network as more people install unbrowse.
            </p>
            <Link
              href="/search"
              className="inline-flex items-center gap-1.5 text-xs font-mono text-[rgba(255,176,96,0.85)] hover:text-orange-500 transition-colors mt-auto"
            >
              Browse the marketplace{" "}
              <IconArrow size={11} />
            </Link>
          </div>

        </div>
      </div>
    </section>
  );
}
