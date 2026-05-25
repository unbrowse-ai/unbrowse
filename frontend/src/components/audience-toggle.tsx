'use client';

import { useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Audience-mode pill.
 *
 * Banger Wave 1 (2026-05-26): renamed dev/everyone → agent/publisher to
 * surface the marketplace flywheel. The two real ICPs:
 *   - agent (default): the agent builder calling Unbrowse to skip the
 *     browser tax on every site. Buys the speed + 1-MCP story.
 *   - publisher: the developer whose captured route becomes the moat —
 *     earns USDC on Solana via Faremeter Flex every time the next
 *     agent calls it.
 *
 * URL param: ?mode=publisher (no value means agent / default).
 * Hook return: "agent" | "publisher".
 *
 * Audit trail: see .editions-evidence/UNICORN-AUDIT.md (Banger W1).
 */
export type AudienceMode = "agent" | "publisher";

export function AudienceToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const mode: AudienceMode = params.get("mode") === "publisher" ? "publisher" : "agent";

  const setMode = (next: AudienceMode) => {
    const sp = new URLSearchParams(params.toString());
    if (next === "agent") sp.delete("mode");
    else sp.set("mode", next);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const agentRef = useRef<HTMLButtonElement>(null);
  const pubRef = useRef<HTMLButtonElement>(null);

  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next: AudienceMode = mode === "agent" ? "publisher" : "agent";
      setMode(next);
      (next === "agent" ? agentRef : pubRef).current?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      setMode("agent");
      agentRef.current?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      setMode("publisher");
      pubRef.current?.focus();
    }
  };

  const baseCls =
    "px-3 py-1 text-[10px] font-mono uppercase tracking-[0.2em] cursor-pointer transition-colors";

  return (
    <div
      className="inline-flex items-center gap-0 border border-[rgba(255,122,32,0.3)] rounded-sm overflow-hidden"
      role="tablist"
      aria-label="Audience mode"
    >
      <button
        ref={agentRef}
        type="button"
        role="tab"
        aria-selected={mode === "agent"}
        tabIndex={mode === "agent" ? 0 : -1}
        onKeyDown={onKey}
        onClick={() => setMode("agent")}
        className={`${baseCls} ${
          mode === "agent"
            ? "bg-[rgba(255,122,32,0.15)] text-[rgba(255,176,96,1)]"
            : "text-[rgba(255,176,96,0.85)] hover:text-[rgba(255,176,96,1)]"
        }`}
      >
        agent-builder
      </button>
      <span className="w-px self-stretch bg-[rgba(255,122,32,0.3)]" aria-hidden />
      <button
        ref={pubRef}
        type="button"
        role="tab"
        aria-selected={mode === "publisher"}
        tabIndex={mode === "publisher" ? 0 : -1}
        onKeyDown={onKey}
        onClick={() => setMode("publisher")}
        className={`${baseCls} ${
          mode === "publisher"
            ? "bg-[rgba(255,122,32,0.15)] text-[rgba(255,176,96,1)]"
            : "text-[rgba(255,176,96,0.85)] hover:text-[rgba(255,176,96,1)]"
        }`}
      >
        route-publisher
      </button>
    </div>
  );
}

/**
 * Read-only helper: returns the current mode from the URL.
 * Use inside client components that need to swap copy.
 */
export function useAudienceMode(): AudienceMode {
  const params = useSearchParams();
  return params.get("mode") === "publisher" ? "publisher" : "agent";
}
