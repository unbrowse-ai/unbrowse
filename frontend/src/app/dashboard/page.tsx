"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ContributorDashboard } from "@/components/contributor-dashboard";
import {
  getAccountMe,
  getAccountPreferences,
  getMyDashboard,
  updateAccountPreferences,
  type AccountMe,
  type AccountPreferences,
  type DashboardData,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function DashboardPage() {
  const router = useRouter();
  const { isAuthenticated, agentName, logout } = useAuth();
  const [wallet, setWallet] = useState("");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [accountMe, setAccountMe] = useState<AccountMe | null>(null);
  const [prefs, setPrefs] = useState<AccountPreferences | null>(null);
  const [prefsBusy, setPrefsBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      getMyDashboard(),
      getAccountMe().catch(() => null),
    ])
      .then(async ([dash, me]) => {
        if (cancelled) return;
        setDashboard(dash);
        setAccountMe(me);
        if (me) {
          const nextPrefs = await getAccountPreferences().catch(() => null);
          if (!cancelled) setPrefs(nextPrefs);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const togglePrefs = async () => {
    if (!prefs || prefsBusy) return;
    setPrefsBusy(true);
    try {
      const next = await updateAccountPreferences({ share_pointers: !prefs.share_pointers });
      setPrefs(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPrefsBusy(false);
    }
  };

  const openWallet = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = wallet.trim();
    if (!trimmed) return;
    router.push(`/dashboard/${encodeURIComponent(trimmed)}`);
  };

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-2xl px-6 pb-20 pt-32">
        <h1 className="text-3xl font-bold">Contributor Dashboard</h1>
        <p className="mt-3 text-text-secondary">
          Sign in to see your private account, or open a public wallet ledger.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-2xl bg-orange-500 px-6 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-orange-600"
          >
            Sign in with email
          </Link>
          <Link
            href="/#get-started"
            className="inline-flex items-center justify-center rounded-2xl border border-border px-6 py-3.5 text-sm font-semibold text-text-secondary transition-colors hover:border-orange-500/30 hover:text-text-primary"
          >
            Get CLI key
          </Link>
        </div>
        <form onSubmit={openWallet} className="mt-10 rounded-[28px] border border-border bg-surface p-6">
          <label className="block text-xs font-mono uppercase tracking-[0.22em] text-text-muted">
            Public wallet
            <input
              value={wallet}
              onChange={(event) => setWallet(event.target.value)}
              placeholder="Paste wallet address"
              className="mt-3 block w-full rounded-2xl border border-border bg-bg px-4 py-3 text-sm text-text-primary placeholder:text-text-muted focus:border-orange-500/50 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={!wallet.trim()}
            className="mt-4 inline-flex items-center justify-center rounded-2xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Open wallet ledger
          </button>
        </form>
      </div>
    );
  }

  if (loading && !dashboard) {
    return (
      <div className="mx-auto max-w-2xl px-6 pb-20 pt-32">
        <p className="text-sm text-text-muted">Loading dashboard...</p>
      </div>
    );
  }

  if (error && !dashboard) {
    return (
      <div className="mx-auto max-w-2xl px-6 pb-20 pt-32">
        <h1 className="text-3xl font-bold">Dashboard unavailable</h1>
        <p className="mt-3 text-sm text-red-400">{error}</p>
        <button
          onClick={logout}
          className="mt-6 rounded-2xl border border-border px-5 py-3 text-sm text-text-primary transition-colors hover:border-red-400/30 hover:text-red-400"
        >
          Logout
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-24">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">Signed in</p>
          <p className="mt-1 text-sm text-text-secondary">{accountMe?.email ?? agentName}</p>
        </div>
        <button
          onClick={logout}
          className="rounded-2xl border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:border-red-400/30 hover:text-red-400"
        >
          Logout
        </button>
      </div>

      {error && (
        <div className="mx-auto mt-4 max-w-6xl px-6">
          <p className="rounded-2xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-sm text-red-400">{error}</p>
        </div>
      )}

      {accountMe && prefs && (
        <div className="mx-auto mt-6 max-w-6xl px-6">
          <div className="rounded-[28px] border border-border bg-surface p-6">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="font-semibold text-text-primary">Auto-publish to marketplace</div>
                <div className="mt-1 max-w-xl text-sm text-text-muted">
                  On publishes captured routes to the public marketplace. Off keeps captures private to your account.
                </div>
              </div>
              <button
                onClick={togglePrefs}
                disabled={prefsBusy}
                aria-pressed={prefs.share_pointers}
                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                  prefs.share_pointers ? "bg-orange-500" : "bg-border"
                } ${prefsBusy ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
              >
                <span
                  className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${
                    prefs.share_pointers ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {dashboard && (
        <ContributorDashboard
          dashboard={dashboard}
          walletAddress={dashboard.profile.wallet_address ?? dashboard.profile.agent_id}
          view="private"
        />
      )}
    </div>
  );
}
