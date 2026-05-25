"use client";

/**
 * Privy login button (outer shell).
 *
 * Banger Wave 3 (2026-05-26): dynamic-import the inner so the @privy-io
 * SDK chunk is requested only when this component is actually rendered.
 * Pages that import this file (but render `null` via the optional
 * wrapper) pay only the tiny outer shell, not the ~324 KB SDK.
 *
 * Inner lives in `privy-login-button-inner.tsx` — it consumes
 * `usePrivy()` and renders the modal trigger. Dynamic-import with
 * `ssr: false` keeps the SDK out of the server bundle and off the
 * critical path on hydration.
 *
 * The button has two states (rendered by the inner):
 *   - Not authenticated: "Sign in with Privy" → opens Privy's modal
 *   - Authenticated:     "<email or wallet> — Sign out"
 *
 * Privy and magic-link operate independently. A user logged in via
 * one is not automatically logged in via the other; that's intentional
 * for v1.
 */

import dynamic from "next/dynamic";
import { isPrivyEnabled } from "@/lib/privy-provider";

const PrivyLoginButtonInner = dynamic(
  () =>
    import("./privy-login-button-inner").then((m) => ({
      default: m.PrivyLoginButtonInner,
    })),
  {
    ssr: false,
    loading: () => (
      <button
        type="button"
        disabled
        className="inline-flex items-center justify-center rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-muted"
      >
        Loading sign-in…
      </button>
    ),
  },
);

export function PrivyLoginButton({ className }: { className?: string }) {
  return <PrivyLoginButtonInner className={className} />;
}

/**
 * Wrapper that ONLY renders the button (and triggers the dynamic-import)
 * when Privy is enabled. Drop this on /account next to the magic-link
 * form.
 */
export function PrivyLoginButtonOptional({
  className,
}: {
  className?: string;
}) {
  if (!isPrivyEnabled()) return null;
  return <PrivyLoginButton className={className} />;
}
