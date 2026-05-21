"use client";

/**
 * Privy login button.
 *
 * Renders ONLY when `NEXT_PUBLIC_PRIVY_APP_ID` is set on the build. When
 * not set, the component returns null and the page chrome looks exactly
 * like it does today (magic-link form is the only auth surface).
 *
 * The Privy SDK (~1.5 MB WalletConnect bundle) is loaded via
 * `next/dynamic` from `./privy-login-button-inner`, so when the env is
 * unset the SDK chunk is never fetched.
 */

import dynamic from "next/dynamic";
import { isPrivyEnabled } from "@/lib/privy-provider";

const PrivyLoginButtonDynamic = dynamic(
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
        Loading Privy...
      </button>
    ),
  },
);

export function PrivyLoginButton({ className }: { className?: string }) {
  return <PrivyLoginButtonDynamic className={className} />;
}

/**
 * Wrapper that ONLY renders the button when Privy is enabled. Drop
 * this directly on /account next to the magic-link form. When the env
 * is unset, returns null and the Privy SDK chunk is never fetched.
 */
export function PrivyLoginButtonOptional({
  className,
}: {
  className?: string;
}) {
  if (!isPrivyEnabled()) return null;
  return <PrivyLoginButtonDynamic className={className} />;
}
