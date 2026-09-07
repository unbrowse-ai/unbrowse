'use client';

import { useAudienceMode } from "./audience-toggle";
import { HeroTerminal } from "./hero-terminal";

/**
 * HeroTerminal gated to dev mode. In everyone mode, the technical
 * decision_trace JSON gets replaced by a plain-language timeline.
 */
export function HeroTerminalGated() {
  const mode = useAudienceMode();
  if (mode === "publisher") {
    return (
      <div className="animate-fade-up stagger-3 w-full max-w-2xl mt-12">
        <div
          className="relative w-full border border-[rgba(255,122,32,0.35)] bg-[#060402] overflow-hidden rounded-sm shadow-xl shadow-black/30"
          style={{ boxShadow: "0 0 60px -20px rgba(255,122,32,0.25)" }}
        >
          <div className="border-b border-[rgba(255,122,32,0.18)] bg-[rgba(0,0,0,0.4)] px-4 py-2 flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-[0.25em] text-[rgba(255,122,32,0.55)]">
              ##  How long does it take?
            </span>
          </div>
          <div className="px-4 py-5 sm:px-6 sm:py-6 space-y-4 text-left">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.25em] text-[rgba(255,122,32,0.5)] mb-1">
                Normal browsing tool
              </div>
              <div className="flex items-center gap-3">
                <div
                  className="h-2 bg-[rgba(255,122,32,0.25)] rounded-full"
                  style={{ width: "100%" }}
                />
                <span className="text-xs font-mono text-[rgba(255,176,96,0.7)] whitespace-nowrap">
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
                <span className="text-xs font-mono text-[rgba(255,176,96,1)] whitespace-nowrap">
                  ~0.5 seconds
                </span>
              </div>
            </div>
          </div>
        </div>
        <p className="mt-3 text-center text-[10px] font-mono uppercase tracking-[0.25em] text-[rgba(255,122,32,0.45)]">
          Same task. 60x less waiting.
        </p>
      </div>
    );
  }

  return <HeroTerminal />;
}
