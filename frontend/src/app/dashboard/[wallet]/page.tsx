"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getDashboardByWallet, getStatsSummary, type DashboardData, type StatsSummary } from "@/lib/api";
import { ContributorDashboard } from "@/components/contributor-dashboard";
import { normalizeWalletAddress, storeRecentWallet } from "@/lib/wallet-dashboard";

export default function WalletDashboardPage() {
  const params = useParams<{ wallet: string }>();
  const walletAddress = normalizeWalletAddress(decodeURIComponent(params.wallet));
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    getStatsSummary()
      .then((summary) => {
        if (!cancelled) setStats(summary);
      })
      .catch(() => {});
    getDashboardByWallet(walletAddress)
      .then((data) => {
        if (cancelled) return;
        setDashboard(data);
        storeRecentWallet(walletAddress);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  if (loading) {
    return (
      <StateFrame
        eyebrow="Loading wallet"
        title="Pulling the contributor ledger."
        copy="Fetching earnings, savings, and contribution rank for this wallet."
      />
    );
  }

  if (error || !dashboard) {
    return (
      <StateFrame
        eyebrow="Unknown wallet"
        title="No data for this wallet yet."
        copy={error ?? "This wallet has not been linked to a contributor profile."}
      />
    );
  }

  return <ContributorDashboard dashboard={dashboard} walletAddress={walletAddress} stats={stats ?? undefined} />;
}

function StateFrame({
  eyebrow,
  title,
  copy,
}: {
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <div className="relative overflow-hidden px-6 pt-28 pb-20">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,109,0,0.18),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(255,109,0,0.1),transparent_30%)]" />
      <div className="relative mx-auto max-w-3xl rounded-[32px] border border-border bg-surface-raised p-8 text-center sm:p-10">
        <p className="text-xs font-mono uppercase tracking-[0.24em] text-text-muted">{eyebrow}</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-4 text-base leading-7 text-text-secondary">{copy}</p>
        <div className="mt-8 flex justify-center">
          <Link
            href="/dashboard"
            className="inline-flex items-center rounded-2xl border border-orange-500/20 bg-orange-500/10 px-5 py-3 font-medium text-orange-500 transition-colors hover:border-orange-500/40"
          >
            Try another wallet
          </Link>
        </div>
      </div>
    </div>
  );
}
