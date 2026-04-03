"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Crown,
  Sparkles,
  TrendingUp,
  Globe,
  Target,
  Zap,
  Users,
  ArrowRight,
  ExternalLink,
  Trophy,
  Timer,
  Lock,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
} from "lucide-react";
import {
  getMinerStats,
  type MinerStats,
  type LeaderboardEntry,
  type DomainCoverage,
  type MinerBounty,
  type MinerQuest,
} from "@/lib/api";

/* High-value domains that agents query most, with "claimed" status based on live data */
const TOP_DOMAINS = [
  "github.com",
  "google.com",
  "reddit.com",
  "stackoverflow.com",
  "news.ycombinator.com",
  "linkedin.com",
  "youtube.com",
  "x.com",
  "stripe.com",
  "aws.amazon.com",
  "npmjs.com",
  "pypi.org",
  "docs.google.com",
  "notion.so",
  "figma.com",
  "vercel.com",
  "cloudflare.com",
  "discord.com",
  "slack.com",
  "twitch.tv",
  "medium.com",
  "dev.to",
  "gitlab.com",
  "bitbucket.org",
  "heroku.com",
  "netlify.com",
  "supabase.com",
  "firebase.google.com",
  "airtable.com",
  "shopify.com",
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function MinersPage() {
  const [data, setData] = useState<MinerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"leaderboard" | "domains" | "bounties" | "quests">("leaderboard");
  const [expandedBounty, setExpandedBounty] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    getMinerStats()
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, []);

  const indexedDomainSet = new Set(data?.domains.map((d) => d.domain) ?? []);

  function copyCommand(command: string, id: string) {
    navigator.clipboard.writeText(command);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="relative overflow-hidden px-6 pt-28 pb-20">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,109,0,0.14),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(255,109,0,0.08),transparent_25%)]" />

      <div className="relative mx-auto max-w-7xl">
        {/* Hero */}
        <section className="rounded-[32px] border border-border bg-surface-raised p-8 animate-fade-up">
          <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-[11px] font-mono uppercase tracking-[0.22em] text-orange-500">
            <Zap className="h-3 w-3" />
            Miner Leaderboard
          </div>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            Mine the web. Earn x402.
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-text-secondary">
            Every route you index earns micropayments when AI agents use it. Compete to cover the most
            valuable domains, claim bounties for high-demand endpoints, and climb the miner rankings.
            The more you browse, the more you earn.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href="https://github.com/unbrowse-ai/unbrowse"
              target="_blank"
              rel="noopener"
              className="rounded-2xl bg-orange-500 px-5 py-3 font-semibold text-white transition-colors hover:bg-orange-600 inline-flex items-center gap-2"
            >
              Start Mining <ArrowRight className="h-4 w-4" />
            </a>
            <Link
              href="/mine-the-internet"
              className="rounded-2xl border border-border px-5 py-3 font-medium text-text-primary transition-colors hover:border-orange-500/30 hover:text-orange-500"
            >
              How it works
            </Link>
            <Link
              href="/dashboard"
              className="rounded-2xl border border-border px-5 py-3 font-medium text-text-primary transition-colors hover:border-orange-500/30 hover:text-orange-500"
            >
              My dashboard
            </Link>
          </div>
        </section>

        {error && (
          <div className="mt-6 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Network Stats Bar */}
        <section className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6 animate-fade-up stagger-1">
          <StatCard
            label="Routes Indexed"
            value={data?.network.total_routes ?? 0}
            icon={<Globe className="h-4 w-4" />}
          />
          <StatCard
            label="Active Miners"
            value={data?.network.total_agents ?? 0}
            icon={<Users className="h-4 w-4" />}
          />
          <StatCard
            label="Domains Covered"
            value={data?.domains.length ?? 0}
            icon={<Target className="h-4 w-4" />}
          />
          <StatCard
            label="Marketplace Hit Rate"
            value={`${data?.network.marketplace_hit_rate ?? 0}%`}
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <StatCard
            label="Total Resolves"
            value={data?.network.total_resolves ?? 0}
            icon={<Zap className="h-4 w-4" />}
          />
          <StatCard
            label="x402 Paid Out"
            value={`$${(data?.network.total_earned_usd ?? 0).toFixed(4)}`}
            icon={<Trophy className="h-4 w-4" />}
          />
        </section>

        {/* Tab Navigation */}
        <div className="mt-8 flex gap-2 overflow-x-auto scrollbar-hide animate-fade-up stagger-2">
          {(
            [
              { key: "leaderboard", label: "Top Miners", icon: <Crown className="h-4 w-4" /> },
              { key: "domains", label: "Domain Map", icon: <Globe className="h-4 w-4" /> },
              { key: "bounties", label: "Bounty Board", icon: <Target className="h-4 w-4" /> },
              { key: "quests", label: "Weekly Quests", icon: <Sparkles className="h-4 w-4" /> },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-2 rounded-2xl border px-5 py-3 text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-orange-500/30 bg-orange-500/10 text-orange-500"
                  : "border-border bg-surface text-text-secondary hover:border-orange-500/20 hover:text-text-primary"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="mt-6 animate-fade-up stagger-3">
          {activeTab === "leaderboard" && (
            <LeaderboardSection entries={data?.leaderboard ?? []} />
          )}
          {activeTab === "domains" && (
            <DomainMapSection
              domains={data?.domains ?? []}
              topDomains={TOP_DOMAINS}
              indexedSet={indexedDomainSet}
              onCopy={copyCommand}
              copiedId={copiedId}
            />
          )}
          {activeTab === "bounties" && (
            <BountySection
              bounties={data?.bounties ?? []}
              expandedId={expandedBounty}
              onToggle={(id) => setExpandedBounty(expandedBounty === id ? null : id)}
              onCopy={copyCommand}
              copiedId={copiedId}
            />
          )}
          {activeTab === "quests" && <QuestSection quests={data?.quests ?? []} />}
        </div>

        {/* CTA */}
        <section className="mt-12 rounded-[32px] border border-orange-500/20 bg-orange-500/8 p-8 text-center animate-fade-up stagger-4">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Ready to mine?
          </h2>
          <p className="mt-3 text-sm text-text-secondary max-w-2xl mx-auto">
            Install Unbrowse, browse any website, and start earning. Every route you discover
            joins the shared graph and earns you x402 micropayments whenever an AI agent uses it.
          </p>
          <div className="mt-6 inline-flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 font-mono text-sm">
            <span className="text-text-muted">$</span>
            <span className="text-text-primary">curl -fsSL https://unbrowse.ai/install.sh | bash</span>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stat Card                                                          */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-[20px] border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-text-muted">
        {icon}
        <span className="text-[11px] font-mono uppercase tracking-[0.18em]">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold gradient-text">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  1. Top Miners Leaderboard                                          */
/* ------------------------------------------------------------------ */

function LeaderboardSection({ entries }: { entries: LeaderboardEntry[] }) {
  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);

  return (
    <div>
      {/* Podium cards */}
      <div className="grid gap-6 lg:grid-cols-3">
        {podium.map((entry, index) => (
          <article
            key={entry.agent_id}
            className={`rounded-[28px] border p-6 transition-all hover:scale-[1.01] ${
              index === 0
                ? "border-orange-500/30 bg-orange-500/12 orange-glow"
                : "border-border bg-surface"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-mono uppercase tracking-[0.2em] text-text-muted">
                {index === 0 ? (
                  <Crown className="h-3.5 w-3.5 text-orange-500" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-orange-500" />
                )}
                Rank #{index + 1}
              </div>
              <span className="text-xs text-text-muted">
                {new Date(entry.created_at).toLocaleDateString()}
              </span>
            </div>
            <h2 className="mt-5 text-2xl font-semibold truncate">{entry.name}</h2>
            <p className="mt-2 text-4xl font-bold gradient-text">
              {entry.contribution_score.toFixed(4)}
            </p>
            <div className="mt-5 space-y-3">
              <BoardMetric
                label="x402 Earned"
                value={`$${entry.total_earned_usd.toFixed(6)}`}
              />
              <BoardMetric label="Executions" value={String(entry.executions)} />
              <BoardMetric
                label="Routes Discovered"
                value={String(entry.skills_discovered)}
              />
              <BoardMetric
                label="Time Saved"
                value={
                  entry.time_saved_hours == null
                    ? "Not enough data yet"
                    : `${entry.time_saved_hours.toFixed(4)}h`
                }
              />
            </div>
            {/* Share button */}
            <div className="mt-4 pt-4 border-t border-border/70">
              <button
                onClick={() => {
                  const text = `I'm ranked #${index + 1} on the Unbrowse miner leaderboard with a score of ${entry.contribution_score.toFixed(4)}. Mining the web for AI agents.\n\nhttps://unbrowse.ai/miners`;
                  window.open(
                    `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`,
                    "_blank"
                  );
                }}
                className="w-full rounded-xl border border-border px-4 py-2 text-xs font-medium text-text-secondary hover:border-orange-500/30 hover:text-orange-500 transition-all"
              >
                Share ranking on X
              </button>
            </div>
          </article>
        ))}
      </div>

      {/* Full table */}
      <div className="mt-8 rounded-[32px] border border-border bg-surface p-4 sm:p-6">
        <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">
              Full board
            </p>
            <h2 className="mt-2 text-2xl font-semibold">All miners</h2>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-xs font-mono uppercase tracking-[0.2em] text-orange-500">
            <TrendingUp className="h-3.5 w-3.5" />
            {entries.length} ranked
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left">
            <thead>
              <tr className="text-xs font-mono uppercase tracking-[0.18em] text-text-muted">
                <th className="px-3 py-3">Rank</th>
                <th className="px-3 py-3">Miner</th>
                <th className="px-3 py-3">Score</th>
                <th className="px-3 py-3">x402 Earned</th>
                <th className="px-3 py-3">Executions</th>
                <th className="px-3 py-3">Routes</th>
                <th className="px-3 py-3">Share</th>
              </tr>
            </thead>
            <tbody>
              {rest.length > 0 ? (
                rest.map((entry, index) => (
                  <tr
                    key={entry.agent_id}
                    className="border-t border-border/70 hover:bg-orange-500/5 transition-colors"
                  >
                    <td className="px-3 py-4 text-sm font-semibold text-text-primary">
                      #{index + 4}
                    </td>
                    <td className="px-3 py-4">
                      <div className="font-medium text-text-primary truncate max-w-[200px]">
                        {entry.name}
                      </div>
                      <div className="mt-1 text-xs font-mono text-text-muted">
                        norms{" "}
                        {entry.score_components.earned_norm.toFixed(2)} /{" "}
                        {entry.score_components.execution_norm.toFixed(2)} /{" "}
                        {entry.score_components.discovery_norm.toFixed(2)}
                      </div>
                    </td>
                    <td className="px-3 py-4 text-sm font-semibold text-orange-500">
                      {entry.contribution_score.toFixed(4)}
                    </td>
                    <td className="px-3 py-4 text-sm text-text-primary">
                      ${entry.total_earned_usd.toFixed(6)}
                    </td>
                    <td className="px-3 py-4 text-sm text-text-primary">
                      {entry.executions}
                    </td>
                    <td className="px-3 py-4 text-sm text-text-primary">
                      {entry.skills_discovered}
                    </td>
                    <td className="px-3 py-4">
                      <button
                        onClick={() => {
                          const text = `I'm ranked #${index + 4} on the Unbrowse miner leaderboard. Mining the web for AI agents.\n\nhttps://unbrowse.ai/miners`;
                          window.open(
                            `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`,
                            "_blank"
                          );
                        }}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-muted hover:border-orange-500/30 hover:text-orange-500 transition-all"
                      >
                        Share
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-sm text-text-muted"
                  >
                    No ranked miners yet. Be the first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  2. Domain Coverage Map                                             */
/* ------------------------------------------------------------------ */

function DomainMapSection({
  domains,
  topDomains,
  indexedSet,
  onCopy,
  copiedId,
}: {
  domains: DomainCoverage[];
  topDomains: string[];
  indexedSet: Set<string>;
  onCopy: (cmd: string, id: string) => void;
  copiedId: string | null;
}) {
  return (
    <div className="space-y-6">
      {/* Indexed domains */}
      <div className="rounded-[32px] border border-border bg-surface p-6">
        <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">
              Covered domains
            </p>
            <h2 className="mt-2 text-2xl font-semibold">Indexed domains</h2>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-green-500/20 bg-green-500/10 px-3 py-1 text-xs font-mono uppercase tracking-[0.2em] text-green-500">
            {domains.length} active
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {domains.map((d) => (
            <div
              key={d.domain}
              className="rounded-2xl border border-border/70 bg-surface-raised p-4 hover:border-orange-500/20 transition-all"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-text-primary text-sm truncate">
                  {d.domain}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-mono uppercase text-green-500">
                  indexed
                </span>
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-text-muted">
                <span>{d.endpoints} routes</span>
                <span>{d.skills} skills</span>
              </div>
              <div className="mt-2 text-[10px] text-text-muted">
                Updated {new Date(d.updated_at).toLocaleDateString()}
              </div>
            </div>
          ))}
          {domains.length === 0 && (
            <div className="col-span-full py-8 text-center text-sm text-text-muted">
              No domains indexed yet. Start mining to claim the first.
            </div>
          )}
        </div>
      </div>

      {/* Unclaimed high-value domains */}
      <div className="rounded-[32px] border border-orange-500/20 bg-surface p-6">
        <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-500">
              Unclaimed territory
            </p>
            <h2 className="mt-2 text-2xl font-semibold">High-value domains to mine</h2>
          </div>
          <Link
            href="/top-domains-to-mine"
            className="inline-flex items-center gap-1 text-xs text-orange-500 hover:underline"
          >
            Full guide <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
        <p className="mt-3 text-sm text-text-secondary">
          These are the domains AI agents query most. Index them first and earn on every resolve.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {topDomains.map((domain) => {
            const isClaimed = indexedSet.has(domain) || indexedSet.has(`www.${domain}`);
            const cmdId = `mine-${domain}`;
            return (
              <div key={domain} className="group relative">
                <button
                  onClick={() => {
                    if (!isClaimed) onCopy(`unbrowse go https://${domain}`, cmdId);
                  }}
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-all ${
                    isClaimed
                      ? "border-green-500/20 bg-green-500/8 text-green-500 cursor-default"
                      : "border-orange-500/20 bg-orange-500/8 text-orange-500 hover:bg-orange-500/15 cursor-pointer"
                  }`}
                >
                  {isClaimed ? (
                    <Check className="h-3 w-3" />
                  ) : copiedId === cmdId ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Target className="h-3 w-3" />
                  )}
                  {domain}
                </button>
                {!isClaimed && copiedId === cmdId && (
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-surface-raised border border-border px-2 py-1 text-[10px] text-text-muted">
                    Copied command
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  3. Bounty Board                                                    */
/* ------------------------------------------------------------------ */

function BountySection({
  bounties,
  expandedId,
  onToggle,
  onCopy,
  copiedId,
}: {
  bounties: MinerBounty[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onCopy: (cmd: string, id: string) => void;
  copiedId: string | null;
}) {
  const difficultyColor = {
    easy: "text-green-500 bg-green-500/10 border-green-500/20",
    medium: "text-yellow-500 bg-yellow-500/10 border-yellow-500/20",
    hard: "text-red-400 bg-red-400/10 border-red-400/20",
  };

  return (
    <div className="rounded-[32px] border border-border bg-surface p-6">
      <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">
            Wanted endpoints
          </p>
          <h2 className="mt-2 text-2xl font-semibold">Bounty Board</h2>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-xs font-mono uppercase tracking-[0.2em] text-orange-500">
          <Target className="h-3.5 w-3.5" />
          {bounties.filter((b) => !b.claimed).length} open
        </div>
      </div>
      <p className="mt-3 text-sm text-text-secondary">
        Agent builders need these endpoints. Index them and earn the multiplied reward on every
        future resolve.
      </p>

      <div className="mt-6 space-y-3">
        {bounties.length === 0 && (
          <div className="rounded-2xl border border-border/70 bg-surface-raised px-4 py-8 text-center text-sm text-text-muted">
            Demand telemetry has not produced bounty candidates yet.
          </div>
        )}
        {bounties.map((bounty) => {
          const isExpanded = expandedId === bounty.id;
          return (
            <div
              key={bounty.id}
              className={`rounded-2xl border transition-all ${
                bounty.claimed
                  ? "border-border/50 bg-surface-raised/50 opacity-60"
                  : "border-border bg-surface-raised hover:border-orange-500/20"
              }`}
            >
              <button
                onClick={() => onToggle(bounty.id)}
                className="flex w-full items-center justify-between gap-4 p-4 text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${difficultyColor[bounty.difficulty]}`}
                  >
                    {bounty.claimed ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Target className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-text-primary truncate">
                        {bounty.title}
                      </h3>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase ${difficultyColor[bounty.difficulty]}`}
                      >
                        {bounty.difficulty}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-text-muted truncate">
                      {bounty.domain}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-3 py-1 text-xs font-semibold text-orange-500">
                    {bounty.reward_multiplier}x reward
                  </span>
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-text-muted" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-text-muted" />
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-border/70 px-4 pb-4 pt-3">
                  <p className="text-sm text-text-secondary">{bounty.description}</p>
                  <div className="mt-3 flex items-center gap-2 text-xs text-text-muted">
                    <span className="inline-flex items-center gap-1 rounded bg-surface px-2 py-1 border border-border">
                      <Globe className="h-3 w-3" /> {bounty.category}
                    </span>
                  </div>
                  {!bounty.claimed && (
                    <div className="mt-3">
                      <button
                        onClick={() =>
                          onCopy(
                            `unbrowse go https://${bounty.domain}`,
                            `bounty-${bounty.id}`
                          )
                        }
                        className="inline-flex items-center gap-2 rounded-xl border border-orange-500/20 bg-orange-500/10 px-4 py-2 text-xs font-medium text-orange-500 hover:bg-orange-500/15 transition-all"
                      >
                        {copiedId === `bounty-${bounty.id}` ? (
                          <>
                            <Check className="h-3 w-3" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> Copy mining command
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  4. Weekly Quests                                                   */
/* ------------------------------------------------------------------ */

function QuestSection({ quests }: { quests: MinerQuest[] }) {
  const typeIcon = {
    "first-indexer": <Trophy className="h-4 w-4" />,
    "route-count": <TrendingUp className="h-4 w-4" />,
    "domain-sprint": <Globe className="h-4 w-4" />,
  };
  const typeColor = {
    "first-indexer": "text-orange-500 bg-orange-500/10 border-orange-500/20",
    "route-count": "text-blue-400 bg-blue-400/10 border-blue-400/20",
    "domain-sprint": "text-purple-400 bg-purple-400/10 border-purple-400/20",
  };

  return (
    <div className="rounded-[32px] border border-border bg-surface p-6">
      <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">
            Limited time
          </p>
          <h2 className="mt-2 text-2xl font-semibold">Weekly Quests</h2>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-mono text-text-muted">
          <Timer className="h-3.5 w-3.5" />
          Resets Sunday
        </div>
      </div>
      <p className="mt-3 text-sm text-text-secondary">
        Complete quests before the weekly reset for bonus multipliers. First-indexer quests are
        winner-take-all.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {quests.length === 0 && (
          <div className="rounded-2xl border border-border bg-surface-raised p-5 text-sm text-text-muted sm:col-span-2">
            Weekly quests will appear once enough demand telemetry lands.
          </div>
        )}
        {quests.map((quest) => (
          <div
            key={quest.id}
            className="rounded-2xl border border-border bg-surface-raised p-5 hover:border-orange-500/20 transition-all"
          >
            <div className="flex items-start justify-between gap-3">
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${typeColor[quest.type]}`}
              >
                {typeIcon[quest.type]}
              </div>
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-3 py-1 text-xs font-semibold text-orange-500">
                {quest.reward_multiplier}x
              </span>
            </div>
            <h3 className="mt-3 font-semibold text-text-primary">{quest.title}</h3>
            <p className="mt-1 text-xs text-text-secondary leading-5">
              {quest.description}
            </p>

            {quest.goal != null && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-[10px] text-text-muted mb-1">
                  <span>
                    {quest.progress ?? 0} / {quest.goal}
                  </span>
                  <span>{quest.deadline}</span>
                </div>
                <div className="h-1.5 rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-orange-500 transition-all"
                    style={{
                      width: `${Math.min(100, ((quest.progress ?? 0) / quest.goal) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {quest.type === "first-indexer" && (
              <div className="mt-3 flex items-center gap-2">
                <Lock className="h-3 w-3 text-text-muted" />
                <span className="text-[10px] text-text-muted uppercase tracking-wider">
                  Winner takes all
                </span>
              </div>
            )}

            {quest.target_domain && (
              <div className="mt-3 inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] font-mono text-text-muted">
                <Globe className="h-2.5 w-2.5" />
                {quest.target_domain}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared Components                                                  */
/* ------------------------------------------------------------------ */

function BoardMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/70 py-2.5 last:border-b-0">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className="text-sm font-medium text-text-primary">{value}</span>
    </div>
  );
}
