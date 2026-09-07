"use client";

// Inner component split out so the outer `privy-login-button.tsx` can
// dynamic-import it via `next/dynamic`. Bundles containing this file
// pull the full @privy-io/react-auth SDK (~1.5 MB WalletConnect tree);
// every page that does NOT render this never pays that cost.

import { usePrivy } from "@privy-io/react-auth";

export function PrivyLoginButtonInner({
  className,
}: {
  className?: string;
}) {
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
