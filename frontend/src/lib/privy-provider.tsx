"use client";

/**
 * Optional Privy provider.
 *
 * Wraps children with @privy-io/react-auth's PrivyProvider ONLY when
 * `NEXT_PUBLIC_PRIVY_APP_ID` is set on the build. When the env is unset
 * (the default in dev, in CI builds without the secret, and on any
 * deployment that hasn't been migrated yet), this is a transparent
 * pass-through — children render unchanged and no Privy code paths
 * load at runtime.
 *
 * Why opt-in rather than always-on:
 *   - Magic-link auth (Resend-backed) is the production login today and
 *     stays the production login. Privy is additive, gated, reversible.
 *     A misconfig or outage on Privy must not break /account.
 *   - The Privy SDK loads ~80 KB of JS at the route boundary. For
 *     deployments that don't use it, no point paying that cost.
 *   - CLAUDE.md "no dramatic behavior under the hood" — if you didn't
 *     set the env, you didn't ship Privy.
 *
 * Mount point: inside `AuthProvider` (which owns the magic-link state)
 * so a logged-in magic-link user keeps their session even if they later
 * connect a Privy wallet, and vice versa. The two auth surfaces live
 * side by side; lobster.cash continues to own the payout wallet.
 *
 * Cloudflare Pages note: the upstream PrivyProvider is a "use client"
 * component that mounts on hydration. It never touches the Node `fs`
 * or `crypto` modules in a way that would break the edge runtime; the
 * server bundle for /account stays trivially renderable because
 * everything Privy does happens after the page is in the browser.
 */

import { useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { PrivyClientConfig } from "@privy-io/react-auth";

// Dynamic import keeps the @privy-io/react-auth runtime chunk (~1.5 MB
// WalletConnect tree) OFF every page when the env flag is unset, and
// off non-account pages even when the flag is set, since the dynamic
// factory only runs once this component renders the inner provider.
const PrivyProviderDynamic = dynamic(
  () =>
    import("@privy-io/react-auth").then((m) => ({
      default: m.PrivyProvider,
    })),
  { ssr: false },
);

const DEFAULT_CONFIG: PrivyClientConfig = {
  // Match the dark theme the rest of the site uses (CLAUDE.md design
  // laws — pick a physical scene, don't combine pure black with pure
  // white). Privy honors a small subset of theme tokens; the rest of
  // its modal styling is fine out of the box.
  appearance: {
    theme: "dark",
    accentColor: "#5b8aff",
  },
  // Wallet-creation policy: only create a Privy-embedded wallet for
  // users who don't already have one. Existing wallets (lobster, any
  // other Solana signer) stay the source of truth. Solana not ethereum:
  // unbrowse's x402 sponsor middleware (backend/src/middleware/sponsor.ts)
  // settles payments on Solana, and the agent.wallet_address column the
  // bind step writes into is a Solana pubkey. An ethereum-only embedded
  // wallet would be orphaned from the payment rail.
  embeddedWallets: {
    solana: { createOnLogin: "users-without-wallets" },
  },
  // Login methods: email + google + external wallet. Wallet covers
  // anyone arriving from lobster.cash who already has a Solana
  // signer; email keeps parity with the existing magic-link path so
  // no current /account user is surprised.
  loginMethods: ["email", "google", "wallet"],
};

export function PrivyOptionalProvider({
  children,
  appId,
  config,
}: {
  children: ReactNode;
  /** Override the env-read at module load (used in tests). */
  appId?: string;
  /** Override the default PrivyClientConfig (used in tests). */
  config?: PrivyClientConfig;
}) {
  const resolvedAppId = appId ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const resolvedConfig = useMemo<PrivyClientConfig>(
    () => config ?? DEFAULT_CONFIG,
    [config],
  );
  if (!resolvedAppId || resolvedAppId.trim().length === 0) {
    // Feature flag OFF: render children unchanged. The dynamic factory
    // for @privy-io/react-auth is never invoked, so the SDK chunk is
    // never fetched by the browser.
    return <>{children}</>;
  }
  return (
    <PrivyProviderDynamic appId={resolvedAppId} config={resolvedConfig}>
      {children}
    </PrivyProviderDynamic>
  );
}

/**
 * Boolean the rest of the app reads to decide whether to render the
 * Privy login button. Centralized so a future env-name change touches
 * one place.
 */
export function isPrivyEnabled(): boolean {
  const id = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  return typeof id === "string" && id.trim().length > 0;
}
