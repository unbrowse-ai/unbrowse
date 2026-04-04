"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, WalletCards } from "lucide-react";
import { normalizeWalletAddress, readRecentWallets } from "@/lib/wallet-dashboard";

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
