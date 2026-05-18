"use client";

/**
 * Privy login button.
 *
 * Renders ONLY when `NEXT_PUBLIC_PRIVY_APP_ID` is set on the build. When
 * not set, the component returns null and the page chrome looks exactly
 * like it does today (magic-link form is the only auth surface).
 *
 * The button has two states:
 *   - Not authenticated: "Sign in with Privy" -> opens Privy's modal
 *   - Authenticated:     "<email or wallet> - Sign out"
 *
 * Privy and magic-link operate independently. A user logged in via
 * one is not automatically logged in via the other; that's intentional
 * for v1. A future step can bind the Privy-issued access token to a
 * unbrowse agent_id (similar to the lobster wallet auto-publish in
 * src/client/index.ts), but that crosses the auth-vs-payout boundary
 * the project already documented; better as a separate ticket.
 */

import { usePrivy } from "@privy-io/react-auth";
import { isPrivyEnabled } from "@/lib/privy-provider";

export function PrivyLoginButton({
  className,
}: {
  className?: string;
}) {
  // Hook order: do NOT early-return before calling usePrivy. The hook
  // itself must always be called when the component is rendered (React
  // hook rules). The parent gates whether THIS component renders at
  // all via `isPrivyEnabled()`; if the env is off, the parent renders
  // null in our place, the hook never runs.
  const { ready, authenticated, user, login, logout } = usePrivy();

  if (!ready) {
    return (
      <button
        type="button"
        disabled
        className={[
          "inline-flex items-center justify-center rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-muted",
          className ?? "",
        ].join(" ")}
      >
        Loading Privy...
      </button>
    );
  }

  if (!authenticated) {
    return (
      <button
        type="button"
        onClick={() => void login()}
        className={[
          "inline-flex items-center justify-center rounded-md border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary hover:bg-surface",
          className ?? "",
        ].join(" ")}
      >
        Sign in with Privy
      </button>
    );
  }

  // Authenticated. Surface a short identifier the user recognizes:
  // email -> google email -> wallet address (first 6 + ... + last 4).
  const ident =
    user?.email?.address ??
    user?.google?.email ??
    (user?.wallet?.address
      ? `${user.wallet.address.slice(0, 6)}...${user.wallet.address.slice(-4)}`
      : "Signed in");

  return (
    <div
      className={[
        "inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary",
        className ?? "",
      ].join(" ")}
    >
      <span className="font-mono">{ident}</span>
      <button
        type="button"
        onClick={() => void logout()}
        className="text-xs text-text-muted hover:text-text-primary underline"
      >
        Sign out
      </button>
    </div>
  );
}

/**
 * Wrapper that ONLY renders the button when Privy is enabled. Drop
 * this directly on /account next to the magic-link form.
 */
export function PrivyLoginButtonOptional({
  className,
}: {
  className?: string;
}) {
  if (!isPrivyEnabled()) return null;
  return <PrivyLoginButton className={className} />;
}
