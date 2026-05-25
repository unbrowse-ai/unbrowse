'use client';

import { useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Audience-mode pill: dev (default) vs everyone.
 *
 * Reads ?mode=everyone from the URL. Default render is "dev" so the static
 * prerender bakes the technical copy. Toggle navigates with shallow update.
 *
 * Used in the hero eyebrow row to swap surrounding copy via the
 * useAudienceMode hook in companion components.
 */
export function AudienceToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const mode = (params.get("mode") === "everyone" ? "everyone" : "dev") as "dev" | "everyone";

  const setMode = (next: "dev" | "everyone") => {
    const sp = new URLSearchParams(params.toString());
    if (next === "dev") sp.delete("mode");
    else sp.set("mode", next);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const devRef = useRef<HTMLButtonElement>(null);
  const everyRef = useRef<HTMLButtonElement>(null);

  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = mode === "dev" ? "everyone" : "dev";
      setMode(next);
      (next === "dev" ? devRef : everyRef).current?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      setMode("dev");
      devRef.current?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      setMode("everyone");
      everyRef.current?.focus();
    }
  };

  // Roving tabindex — only the active tab is in the tab order.
  // Inactive-tab text color bumped from rgba(255,156,64,0.6) (FAIL 3.4:1)
  // to rgba(255,176,96,0.85) (PASS 5.5:1) on the near-black hero surface.
  const baseCls =
    "px-3 py-1 text-[10px] font-mono uppercase tracking-[0.2em] cursor-pointer transition-colors";

  return (
    <div
      className="inline-flex items-center gap-0 border border-[rgba(255,122,32,0.3)] rounded-sm overflow-hidden"
      role="tablist"
      aria-label="Audience mode"
    >
      <button
        ref={devRef}
        type="button"
        role="tab"
        aria-selected={mode === "dev"}
        tabIndex={mode === "dev" ? 0 : -1}
        onKeyDown={onKey}
        onClick={() => setMode("dev")}
        className={`${baseCls} ${
          mode === "dev"
            ? "bg-[rgba(255,122,32,0.15)] text-[rgba(255,176,96,1)]"
            : "text-[rgba(255,176,96,0.85)] hover:text-[rgba(255,176,96,1)]"
        }`}
      >
        for devs
      </button>
      <span className="w-px self-stretch bg-[rgba(255,122,32,0.3)]" aria-hidden />
      <button
        ref={everyRef}
        type="button"
        role="tab"
        aria-selected={mode === "everyone"}
        tabIndex={mode === "everyone" ? 0 : -1}
        onKeyDown={onKey}
        onClick={() => setMode("everyone")}
        className={`${baseCls} ${
          mode === "everyone"
            ? "bg-[rgba(255,122,32,0.15)] text-[rgba(255,176,96,1)]"
            : "text-[rgba(255,176,96,0.85)] hover:text-[rgba(255,176,96,1)]"
        }`}
      >
        for everyone
      </button>
    </div>
  );
}

/**
 * Read-only helper: returns the current mode from the URL.
 * Use inside client components that need to swap copy.
 */
export function useAudienceMode(): "dev" | "everyone" {
  const params = useSearchParams();
  return params.get("mode") === "everyone" ? "everyone" : "dev";
}
