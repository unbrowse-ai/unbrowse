"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Coins, TrendingUp, WalletCards } from "lucide-react";
import { normalizeWalletAddress, readRecentWallets } from "@/lib/wallet-dashboard";
import { useAuth } from "@/lib/auth-context";
import { getCreditBalance, getMyProfile, type CreditBalance } from "@/lib/api";
import Link from "next/link";

function ucToUsd(uc: number): string {
  return (uc / 1_000_000).toFixed(2);
}

function MyCreditsSection() {
  const { isAuthenticated, agentName } = useAuth();
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) return;
    setLoading(true);
    Promise.all([
      getCreditBalance(),
      getMyProfile().catch(() => null),
    ])
      .then(([bal, profile]) => {
        setBalance(bal);
        if (profile?.wallet_address) setWalletAddress(profile.wallet_address);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load credits"))
      .finally(() => setLoading(false));
  }, [isAuthenticated]);

  if (!isAuthenticated) return null;

  const selfSustainingPercent = balance
    ? balance.earned_uc > 0 && balance.consumed_uc > 0
      ? Math.min(100, Math.round((balance.earned_uc / balance.consumed_uc) * 100))
      : balance.is_self_sustaining
        ? 100
        : 0
    : 0;

  return (
    <section className="mb-6 rounded-[32px] border border-border bg-surface-raised p-8 sm:p-10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-orange-500" />
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-500">
            My credits
          </p>
        </div>
        <a
          href="https://www.crossmint.com"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken px-3 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-text-muted transition-colors hover:border-orange-500/20 hover:text-text-secondary"
        >
          Powered by Crossmint
        </a>
      </div>

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-text-muted">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
          Loading balance...
        </div>
      ) : error ? (
        <div className="mt-6 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      ) : balance ? (
        <>
          <div className="mt-5 flex items-baseline gap-3">
            <span className="text-4xl font-bold tracking-tight">${ucToUsd(balance.balance_uc)}</span>
            {agentName && (
              <span className="text-sm text-text-muted">{agentName}</span>
            )}
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-border bg-surface-sunken px-4 py-3">
              <p className="text-xs font-mono uppercase tracking-[0.18em] text-text-muted">Granted</p>
              <p className="mt-1 font-mono text-sm text-text-primary">${ucToUsd(balance.granted_uc)}</p>
              <p className="text-xs text-text-muted">welcome credits</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface-sunken px-4 py-3">
              <p className="text-xs font-mono uppercase tracking-[0.18em] text-text-muted">Earned</p>
              <p className="mt-1 font-mono text-sm text-text-primary">${ucToUsd(balance.earned_uc)}</p>
              <p className="text-xs text-text-muted">from other agents</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface-sunken px-4 py-3">
              <p className="text-xs font-mono uppercase tracking-[0.18em] text-text-muted">Spent</p>
              <p className="mt-1 font-mono text-sm text-text-primary">${ucToUsd(balance.consumed_uc)}</p>
            </div>
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-mono uppercase tracking-[0.18em] text-text-muted">
                <TrendingUp className="h-3 w-3" />
                {balance.is_self_sustaining ? "Self-sustaining" : "Subsidized"}
              </span>
              {!balance.is_self_sustaining && (
                <span className="font-mono text-text-muted">{selfSustainingPercent}% to self-sustaining</span>
              )}
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
              <div
                className="h-full rounded-full bg-orange-500 transition-all duration-500"
                style={{ width: `${selfSustainingPercent}%` }}
              />
            </div>
          </div>

          <div className="mt-5">
            {walletAddress ? (
              <Link
                href={`/dashboard/${encodeURIComponent(walletAddress)}`}
                className="inline-flex items-center gap-2 text-sm font-medium text-orange-500 transition-colors hover:text-orange-400"
              >
                View full dashboard
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <p className="text-sm text-text-muted">
                Link a wallet to see your full contributor dashboard.
              </p>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

export default function DashboardLookupPage() {
  const router = useRouter();
  const [walletAddress, setWalletAddress] = useState("");
  const [recentWallets, setRecentWallets] = useState<string[]>([]);

  useEffect(() => {
    setRecentWallets(readRecentWallets());
  }, []);

  function openWallet(rawWallet: string) {
    const normalized = normalizeWalletAddress(rawWallet);
    if (!normalized) return;
    router.push(`/dashboard/${encodeURIComponent(normalized)}`);
  }

  return (
    <div className="relative overflow-hidden px-6 pt-28 pb-20">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,109,0,0.14),transparent_28%)]" />
      <div className="relative mx-auto max-w-4xl">
        <MyCreditsSection />

        <section className="rounded-[32px] border border-border bg-surface-raised p-8 sm:p-10">
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-500">
            Public contributor dashboard
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            Paste a wallet. open the ledger.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-text-secondary sm:text-base">
            Earnings, savings, time saved, and rank. Public by wallet. No login.
          </p>

          <form
            className="mt-8"
            onSubmit={(event) => {
              event.preventDefault();
              openWallet(walletAddress);
            }}
          >
            <label className="block text-xs font-mono uppercase tracking-[0.18em] text-text-muted">
              Contributor wallet
            </label>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <input
                value={walletAddress}
                onChange={(event) => setWalletAddress(event.target.value)}
                placeholder="So111... or 0xabc..."
                className="w-full rounded-2xl border border-border bg-surface-sunken px-4 py-4 font-mono text-sm text-text-primary outline-none transition-colors focus:border-orange-500/40"
              />
              <button
                type="submit"
                disabled={!normalizeWalletAddress(walletAddress)}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-orange-500 px-5 py-4 font-semibold text-white transition-all hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-44"
              >
                View dashboard
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </form>

          <div className="mt-6 rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-text-secondary">
            One wallet = one contributor profile in v1. This page is read-only and public.
          </div>
        </section>

        <section className="mt-6 rounded-[28px] border border-border bg-surface p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">Recent wallets</p>
              <h2 className="mt-2 text-2xl font-semibold">Jump back in.</h2>
            </div>
            <span className="text-xs font-mono uppercase tracking-[0.18em] text-text-muted">{recentWallets.length} stored</span>
          </div>
          <div className="mt-5 space-y-3">
            {recentWallets.length > 0 ? recentWallets.map((wallet) => (
              <button
                key={wallet}
                onClick={() => openWallet(wallet)}
                className="flex w-full items-center justify-between rounded-2xl border border-border bg-surface-sunken px-4 py-3 text-left transition-colors hover:border-orange-500/30"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <WalletCards className="h-4 w-4 shrink-0 text-orange-500" />
                  <span className="truncate font-mono text-xs text-text-primary sm:text-sm">{wallet}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-text-muted" />
              </button>
            )) : (
              <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-text-muted">
                No wallets viewed yet.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
