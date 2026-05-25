"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Crown, Globe, Target, TrendingUp, Trophy, Users, Zap } from "lucide-react";
import { getMinerStats, type MinerStats } from "@/lib/api";
import {
  CoverageAtlasSection,
  DomainMapSection,
  LeaderboardSection,
  StatCard,
  TOP_DOMAINS,
} from "./sections";

type MinerTab = "leaderboard" | "coverage" | "domains";

export default function MinersPage() {
  const [data, setData] = useState<MinerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MinerTab>("coverage");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    getMinerStats()
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, []);

  const indexedDomainSet = new Set(data?.domains.map((domain) => domain.domain) ?? []);

  function copyCommand(command: string, id: string) {
    navigator.clipboard.writeText(command);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="relative overflow-hidden px-6 pb-20 pt-28">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,109,0,0.16),transparent_30%),radial-gradient(circle_at_80%_20%,rgba(56,189,248,0.12),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(255,109,0,0.08),transparent_24%)]" />

      <div className="relative mx-auto max-w-7xl">
        <section className="animate-fade-up rounded-sm border-[var(--border)] bg-surface-raised/90 p-8">
          <p className="text-xs font-mono uppercase tracking-[0.3em] text-orange-500/90">
            ## CONTRIBUTOR GRAPH
          </p>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            Index routes. Grow the graph.
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-text-secondary">
            Every route you index earns when agents reuse it. No fake quests. No arbitrary bonus layer.
            Just coverage, demand, payouts, and the contributor board.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-sm bg-orange-500 px-5 py-3 font-mono text-white transition-colors hover:bg-orange-600 active:translate-y-px"            >
              [ START INDEXING → ]
            </a>
            <Link
              href="/mine-the-internet"
              className="rounded-sm border-[var(--border)] bg-surface-raised/90 px-5 py-3 font-mono text-orange-500 transition-colors hover:bg-surface active:translate-y-px"
            >
              [ HOW IT WORKS ]
            </Link>
            <Link
              href="/dashboard"
              className="rounded-sm border-[var(--border)] bg-surface-raised/90 px-5 py-3 font-mono text-orange-500 transition-colors hover:bg-surface active:translate-y-px"
            >
              My dashboard
            </Link>
          </div>
        </section>

        {error && (
          <div className="mt-6 rounded-sm border-red-500/20 bg-red-500/10 px-4 py-3 font-mono text-sm text-red-400">
            {error}
          </div>
        )}

        <section className="animate-fade-up stagger-1 mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Routes Indexed" value={data?.network.total_routes ?? 0} icon={<Globe className="h-4 w-4" />} />
          <StatCard label="Active Contributors" value={data?.network.total_agents ?? 0} icon={<Users className="h-4 w-4" />} />
          <StatCard label="Domains Covered" value={data?.domains.length ?? 0} icon={<Target className="h-4 w-4" />} />
          <StatCard label="Marketplace Hit Rate" value={`${data?.network.marketplace_hit_rate ?? 0}%`} icon={<TrendingUp className="h-4 w-4" />} />
          <StatCard label="Total Resolves" value={data?.network.total_resolves ?? 0} icon={<Zap className="h-4 w-4" />} />
          <StatCard label="x402 Paid Out" value={`$${(data?.network.total_earned_usd ?? 0).toFixed(4)}`} icon={<Trophy className="h-4 w-4" />} />
        </section>

        <div className="animate-fade-up stagger-2 mt-8 flex gap-2 overflow-x-auto scrollbar-hide">
          {([
            { key: "coverage", label: "Coverage Atlas", icon: <Globe className="h-4 w-4" /> },
            { key: "leaderboard", label: "Top Contributors", icon: <Crown className="h-4 w-4" /> },
            { key: "domains", label: "Domain Registry", icon: <Target className="h-4 w-4" /> },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex whitespace-nowrap rounded-sm border px-5 py-3 text-sm font-mono transition-all ${
                activeTab === tab.key
                  ? "border-orange-500/30 bg-orange-500/10 text-orange-500"
                  : "border-border bg-surface-raised/90 text-text-secondary hover:border-orange-500/20"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                {tab.icon}
                {tab.label}
              </span>
            </button>
          ))}
        </div>

        <div className="animate-fade-up stagger-3 mt-6">
          {activeTab === "coverage" && (
            <CoverageAtlasSection
              network={data?.network ?? null}
              domains={data?.domains ?? []}
              demandTargets={data?.bounties ?? []}
              indexedSet={indexedDomainSet}
              topDomains={TOP_DOMAINS}
              onCopy={copyCommand}
              copiedId={copiedId}
            />
          )}
          {activeTab === "leaderboard" && <LeaderboardSection entries={data?.leaderboard ?? []} />}
          {activeTab === "domains" && (
            <DomainMapSection
              domains={data?.domains ?? []}
              topDomains={TOP_DOMAINS}
              indexedSet={indexedDomainSet}
              onCopy={copyCommand}
              copiedId={copiedId}
            />
          )}
        </div>

        <section className="animate-fade-up stagger-4 mt-12 rounded-sm border-orange-500/20 bg-orange-500/6 p-8 text-center">
          <p className="text-xs font-mono uppercase tracking-[0.3em] text-orange-500/90">
            ## READY TO INDEX?
          </p>
          <p className="mx-auto mt-3 max-w-2xl font-mono text-sm text-text-secondary">
            Install Unbrowse, browse real sites, and push the route graph forward. Better coverage means
            more reuse, better agent success, and more earnings for contributors who found the useful paths first.
          </p>
          <div className="mt-6 inline-flex items-center gap-3 rounded-sm border-[var(--border)] bg-surface-raised/90 px-4 py-3 font-mono text-sm">
            <span className="text-text-muted">$</span>
            <span className="text-text-tertiary">curl -fsSL https://unbrowse.ai/install.sh | bash</span>
          </div>
        </section>
      </div>
    </div>
  );
}
