"use client";

/**
 * Optional Privy provider — route-gated, dynamic-imported.
 *
 * Banger Wave 3 (2026-05-26): code-split @privy-io/react-auth (~324 KB)
 * off the root layout. Previously this file synchronously imported
 * `PrivyProvider` so the SDK shipped on EVERY route — landing, blog,
 * papers, install — none of which use Privy. The bundle blocked the
 * landing's LCP at 4288 ms POOR.
 *
 * After: the SDK is wrapped in `next/dynamic({ ssr: false })` and gated
 * by `usePathname()`. Pages not in PRIVY_PATH_ALLOWLIST never trigger
 * the chunk load. Pages that ARE in the allowlist load the chunk on
 * client hydration (after first paint), so the route still works.
 *
 * Mount point unchanged: wraps `AuthProvider` (magic-link state) in
 * `app/layout.tsx`. The wrapper itself is now near-zero KB on routes
 * that don't need Privy.
 *
 * Why opt-in rather than always-on:
 *   - Magic-link auth (Resend-backed) is the production login today.
 *     Privy is additive, gated by NEXT_PUBLIC_PRIVY_APP_ID.
 *   - The Privy SDK loads ~324 KB minified + ~1.5 MB WalletConnect tree.
 *     Routes that don't render the login button MUST NOT pay that cost.
 *   - CLAUDE.md "no dramatic behavior under the hood" — if you didn't
 *     set the env, you didn't ship Privy.
 *
 * Cloudflare Pages note: PrivyProvider is "use client" + dynamic with
 * ssr:false, so the server bundle is trivially renderable. The Privy
 * code never reaches the edge runtime.
 */

import { useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import type { PrivyClientConfig } from "@privy-io/react-auth";

/**
 * Paths that may render the Privy login surface. Anything outside this
 * list renders children pass-through and pays zero Privy bytes.
 *
 * Matching is prefix-based (e.g. `/account` matches `/account/cookies`).
 * Keep this list in sync with components that consume `usePrivy()` /
 * `<PrivyLoginButtonOptional />`.
 */
export const PRIVY_PATH_ALLOWLIST: readonly string[] = [
  "/account",
  // Future Privy consumers go here. /login, /billing, /dashboard, /claim
  // currently use the magic-link AuthProvider only, no Privy.
];

/**
 * Inner provider — only imported when a Privy-eligible path is active.
 * `ssr: false` is critical: it prevents the Privy SDK from being
 * pulled into the server bundle AND from blocking first paint.
 */
const PrivyProviderDynamic = dynamic(
  () => import("@privy-io/react-auth").then((m) => ({ default: m.PrivyProvider })),
  { ssr: false, loading: () => null },
);

const DEFAULT_CONFIG: PrivyClientConfig = {
  appearance: {
    theme: "dark",
    accentColor: "#5b8aff",
  },
  embeddedWallets: {
    ethereum: { createOnLogin: "users-without-wallets" },
  },
  loginMethods: ["email", "google", "wallet"],
};

function pathMatchesAllowlist(pathname: string | null): boolean {
  if (!pathname) return false;
  for (const prefix of PRIVY_PATH_ALLOWLIST) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

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
  const pathname = usePathname();
  const resolvedAppId = appId ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const resolvedConfig = useMemo<PrivyClientConfig>(
    () => config ?? DEFAULT_CONFIG,
    [config],
  );

  // Two gates, either short-circuits to pass-through:
  //   1) Privy feature flag (env) is off.
  //   2) Current path is not in the allowlist.
  // Pass-through means: no dynamic import, no SDK chunk, no Privy cost.
  if (!resolvedAppId || resolvedAppId.trim().length === 0) {
    return <>{children}</>;
  }
  if (!pathMatchesAllowlist(pathname)) {
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
 * one place. Note: this is the FLAG check only; route-gating is done
 * separately in PrivyOptionalProvider above.
 */
export function isPrivyEnabled(): boolean {
  const id = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  return typeof id === "string" && id.trim().length > 0;
}
