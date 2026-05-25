'use client';

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

  const baseCls =
    "px-3 py-1 text-[10px] font-mono uppercase tracking-[0.2em] cursor-pointer transition-colors";

  return (
    <div
      className="inline-flex items-center gap-0 border border-border rounded-sm overflow-hidden"
      role="tablist"
      aria-label="Audience mode"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "dev"}
        onClick={() => setMode("dev")}
        className={`${baseCls} ${
          mode === "dev"
            ? "bg-orange-50 text-orange-500"
            : "text-orange-500 hover:text-text-secondary"
        }`}
      >
        for devs
      </button>
      <span className="w-px self-stretch bg-orange-50" aria-hidden />
      <button
        type="button"
        role="tab"
        aria-selected={mode === "everyone"}
        onClick={() => setMode("everyone")}
        className={`${baseCls} ${
          mode === "everyone"
            ? "bg-orange-50 text-orange-500"
            : "text-orange-500 hover:text-text-secondary"
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
