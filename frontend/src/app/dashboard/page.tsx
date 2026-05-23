"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ContributorDashboard } from "@/components/contributor-dashboard";
import { InstallInstructions } from "@/components/install-instructions";
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
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
          ##  Contributor Dashboard
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
          Sign in to see your account
        </h1>
        <p className="mt-3 text-sm text-text-secondary leading-relaxed">
          Sign in to see your private account, or open a public wallet ledger.
        </p>
        <div className="mt-6 border border-[rgba(255,122,32,0.22)] bg-[rgba(255,122,32,0.04)] p-5 rounded-sm">
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.7)]">
            ##  You are already earning
          </p>
          <p className="mt-2 text-sm text-text-secondary leading-relaxed">
            If you ran <span className="font-mono text-[rgba(255,176,96,0.95)]">npx unbrowse setup --mcp</span> and your agent has resolved any URL, every shadow-API route it captured is live in the marketplace. When another agent reuses one, x402 pays USDC to the wallet on this account. Sign in to see captures, reuse counts, and earnings per route.
          </p>
          <Link
            href="/miners"
            className="mt-4 inline-flex items-center gap-1 text-xs font-mono text-[rgba(255,176,96,0.95)] hover:text-orange-400 transition-colors"
          >
            <span>[ See the contributor graph → ]</span>
          </Link>
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-orange-500 text-white font-mono font-medium text-sm w-full sm:w-auto hover:bg-orange-600 active:translate-y-px transition-all cursor-pointer"
          >
            <span>[ Sign in with email ]</span>
          </Link>
          <Link
            href="/install"
            className="inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono w-full sm:w-auto hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all cursor-pointer"
          >
            <span>[ Install the MCP ]</span>
          </Link>
        </div>
        <form onSubmit={openWallet} className="mt-10 border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 p-6 rounded-sm">
          <label className="block text-xs font-mono uppercase tracking-[0.2em] text-[rgba(255,122,32,0.5)]">
            Public wallet
            <input
              value={wallet}
              onChange={(event) => setWallet(event.target.value)}
              placeholder="Paste wallet address"
              className="mt-3 block w-full border border-[rgba(255,122,32,0.18)] bg-[#060402] px-4 py-3 text-sm text-text-primary placeholder:text-text-muted focus:border-[rgba(255,122,32,0.4)] focus:outline-none rounded-sm"
            />
          </label>
          <button
            type="submit"
            disabled={!wallet.trim()}
            className="mt-4 inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-orange-500 text-white font-mono font-medium text-sm hover:bg-orange-600 active:translate-y-px transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>[ Open wallet ledger ]</span>
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
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
          ##  Dashboard
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
          Dashboard unavailable
        </h1>
        <p className="mt-3 text-sm text-red-400">{error}</p>
        <button
          onClick={logout}
          className="mt-6 inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all cursor-pointer"
        >
          <span>[ Logout ]</span>
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-32">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)]">
            ##  Signed in
          </p>
          <p className="mt-1 text-sm text-text-secondary">{accountMe?.email ?? agentName}</p>
        </div>
        <button
          onClick={logout}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all cursor-pointer"
        >
          <span>[ Logout ]</span>
        </button>
      </div>

      {error && (
        <div className="mx-auto mt-4 max-w-6xl px-6">
          <p className="border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 rounded-sm px-4 py-3 text-sm text-[rgba(255,176,96,0.9)]">{error}</p>
        </div>
      )}

      {accountMe && prefs && (
        <div className="mx-auto mt-6 max-w-6xl px-6">
          <div className="border border-[rgba(255,122,32,0.18)] bg-[#070503]/90 p-6 rounded-sm">
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

      {/* Install your MCP — bakes the user's API key into the copy-able
          command. Renders on the authed dashboard so a user who just signed
          in gets the install in zero extra clicks. The same widget renders
          on /install and on the landing page. */}
      <div className="mx-auto mt-6 max-w-6xl px-6">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
          ##  Install the MCP
        </p>
        <InstallInstructions />
      </div>
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
