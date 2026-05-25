'use client';

import { useAudienceMode } from "./audience-toggle";
import { HeroTerminal } from "./hero-terminal";

/**
 * HeroTerminal gated to dev mode. In everyone mode, the technical
 * decision_trace JSON gets replaced by a plain-language timeline.
 */
export function HeroTerminalGated() {
  const mode = useAudienceMode();
  if (mode === "everyone") {
    return (
      <div className="animate-fade-up stagger-3 w-full max-w-2xl mt-12">
        <div
          className="relative w-full border border-border bg-surface-ink overflow-hidden rounded-sm shadow-xl shadow-black/30"
          style={{ boxShadow: "0 0 60px -20px rgba(255,122,32,0.25)" }}
        >
          <div className="border-b border-border bg-[rgba(0,0,0,0.4)] px-4 py-2 flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-[0.25em] text-orange-500">
              ##  How long does it take?
            </span>
          </div>
          <div className="px-4 py-5 sm:px-6 sm:py-6 space-y-4 text-left">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.25em] text-orange-500 mb-1">
                Normal browsing tool
              </div>
              <div className="flex items-center gap-3">
                <div
                  className="h-2 bg-orange-50 rounded-full"
                  style={{ width: "100%" }}
                />
                <span className="text-xs font-mono text-text-secondary whitespace-nowrap">
                  ~30 seconds
                </span>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.25em] text-orange-500 mb-1">
                With Unbrowse
              </div>
              <div className="flex items-center gap-3">
                <div
                  className="h-2 bg-orange-500 rounded-full"
                  style={{ width: "1.6%", minWidth: 6 }}
                />
                <span className="text-xs font-mono text-orange-500 whitespace-nowrap">
                  ~0.5 seconds
                </span>
              </div>
            </div>
          </div>
        </div>
        <p className="mt-3 text-center text-[10px] font-mono uppercase tracking-[0.25em] text-text-muted">
          Same task. 60x less waiting.
        </p>
      </div>
    );
  }

  return <HeroTerminal />;
}
