'use client';

import { Shield } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Toggle that filters search results to only skills with independently verified proofs.
 * URL-param driven (?verified=true) so the SSR pass sees the filter immediately.
 */
export function VerifiedOnlyToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const enabled = params.get("verified") === "true";

  const toggle = () => {
    const sp = new URLSearchParams(params.toString());
    if (enabled) sp.delete("verified");
    else sp.set("verified", "true");
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      title={enabled ? "Showing only skills with independently verified proofs" : "Show only skills with independently verified proofs"}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono uppercase tracking-wider transition-colors
        ${enabled
          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : "bg-surface text-text-muted border-border hover:text-text-primary"}`}
    >
      <Shield className="w-3.5 h-3.5" />
      {enabled ? "Verified only" : "Verified"}
    </button>
  );
}
