"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Coins, Clock3, SearchCheck, Trophy, WalletCards } from "lucide-react";
import type { DashboardData } from "@/lib/api";

export function ContributorDashboard({
  dashboard,
  walletAddress,
}: {
  dashboard: DashboardData;
  walletAddress: string;
}) {
  return (
    <div className="relative overflow-hidden px-6 pt-28 pb-20">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,109,0,0.12),transparent_26%)]" />
      <div className="relative mx-auto max-w-6xl">
        <div className="flex flex-col gap-5 rounded-[32px] border border-border bg-surface-raised p-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.24em] text-orange-500">Contributor ledger</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
              {dashboard.profile.name || "Contributor dashboard"}
            </h1>
            <div className="mt-4 inline-flex max-w-full items-center gap-2 rounded-2xl border border-orange-500/20 bg-orange-500/10 px-4 py-2 text-sm text-orange-500">
              <WalletCards className="h-4 w-4 shrink-0" />
              <span className="break-all font-mono">{walletAddress}</span>
            </div>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-text-secondary">
              Public wallet view. No settings. No account chrome.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-2xl border border-border px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-orange-500/30 hover:text-orange-500"
            >
              <ArrowLeft className="h-4 w-4" />
              Lookup another wallet
            </Link>
            <Link
              href="/leaderboard"
              className="inline-flex items-center gap-2 rounded-2xl border border-orange-500/20 bg-orange-500/10 px-4 py-2.5 text-sm font-medium text-orange-500 transition-colors hover:border-orange-500/40"
            >
              View leaderboard
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={<Coins className="h-4 w-4" />} label="Money earned" value={formatUsd(dashboard.economics.total_earned_usd)} tone="orange" />
          <MetricCard icon={<SearchCheck className="h-4 w-4" />} label="Money spent" value={formatUsd(dashboard.economics.spent_usd)} />
          <MetricCard icon={<Clock3 className="h-4 w-4" />} label="Time saved" value={formatHours(dashboard.savings.time_saved_hours, "Not enough data yet")} unavailableText="Not enough data yet" />
          <MetricCard icon={<Trophy className="h-4 w-4" />} label="Cost saved" value={formatUsdNullable(dashboard.savings.cost_saved_usd)} unavailableText="Not enough data yet" />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <section>
            <Panel title="Recent transactions" eyebrow="Activity">
              {dashboard.recent_transactions.length ? (
                <div className="space-y-3">
                  {dashboard.recent_transactions.map((transaction) => (
                    <div key={`${transaction.direction}-${transaction.transaction_id}`} className="rounded-2xl border border-border bg-surface-sunken px-4 py-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-text-primary">
                            {transaction.direction === "spent" ? "Paid for" : "Earned from"} {transaction.skill_id}
                          </p>
                          <p className="mt-1 text-xs font-mono uppercase tracking-[0.18em] text-text-muted">
                            {transaction.direction} • {transaction.status}
                            {transaction.endpoint_id ? ` • ${transaction.endpoint_id}` : ""}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-base font-semibold text-text-primary">{formatUsd(transaction.amount_usd)}</p>
                          <p className="mt-1 text-xs text-text-muted">
                            fee {formatUsd(transaction.platform_fee_usd)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-col gap-1 text-xs text-text-muted sm:flex-row sm:justify-between">
                        <span>{new Date(transaction.created_at).toLocaleString()}</span>
                        <span className="break-all">counterparty {transaction.counterparty_agent_id}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Unavailable copy="No paid activity recorded yet." />
              )}
            </Panel>
          </section>

          <section className="grid gap-6">
            <Panel title="Contribution" eyebrow="Rank">
              <div className="rounded-3xl border border-orange-500/20 bg-orange-500/10 p-5">
                <p className="text-xs font-mono uppercase tracking-[0.24em] text-orange-500">Score</p>
                <p className="mt-3 text-4xl font-bold gradient-text">{dashboard.rank.contribution_score.toFixed(4)}</p>
                <p className="mt-3 text-sm text-text-secondary">
                  {dashboard.rank.position != null
                    ? `Position #${dashboard.rank.position} on the board.`
                    : "No public rank yet."}
                </p>
              </div>
              <BreakdownRow label="Executions" value={formatInt(dashboard.activity.total_executions)} />
              <BreakdownRow label="Discoveries" value={formatInt(dashboard.activity.skills_discovered)} />
              <BreakdownRow label="Feedback" value={formatInt(dashboard.activity.total_feedback_given)} />
            </Panel>

            <Panel title="Breakdown" eyebrow="Ledger">
              <BreakdownRow label="Creator payouts" value={formatUsd(dashboard.economics.creator_earned_usd)} />
              <BreakdownRow label="Attribution credits" value={formatUsd(dashboard.economics.attribution_earned_usd)} />
              <BreakdownRow label="Graph fees" value={formatUsd(dashboard.economics.graph_fees_paid_usd)} />
              <BreakdownRow label="Paid execution" value={formatUsd(dashboard.economics.paid_execution_usd)} />
              <BreakdownRow label="Contributor ID" value={dashboard.profile.agent_id} mono />
            </Panel>

            <Link
              href="/leaderboard"
              className="inline-flex items-center justify-between rounded-2xl border border-border px-4 py-3 text-sm font-medium text-text-primary transition-colors hover:border-orange-500/30 hover:text-orange-500"
            >
              Open leaderboard
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  compact = false,
  tone = "base",
  unavailableText,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  compact?: boolean;
  tone?: "base" | "orange";
  unavailableText?: string;
}) {
  const empty = unavailableText != null && value === unavailableText;
  return (
    <div className={`rounded-[28px] border p-5 ${tone === "orange" ? "border-orange-500/20 bg-orange-500/10" : "border-border bg-surface"}`}>
      <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.22em] text-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`mt-4 ${compact ? "text-3xl" : "text-4xl"} font-bold tracking-tight ${empty ? "text-text-muted" : "text-text-primary"}`}>
        {value}
      </div>
    </div>
  );
}

function Panel({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section className="rounded-[28px] border border-border bg-surface p-6">
      <p className="text-xs font-mono uppercase tracking-[0.24em] text-text-muted">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-semibold">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function BreakdownRow({
  label,
  value,
  strong = false,
  mono = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/70 py-3 last:border-b-0">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className={`${mono ? "max-w-[12rem] break-all font-mono text-xs" : "text-sm"} ${strong ? "font-semibold text-text-primary" : "font-medium text-text-primary"}`}>
        {value}
      </span>
    </div>
  );
}

function Unavailable({ copy }: { copy: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-text-muted">
      {copy}
    </div>
  );
}

function formatUsd(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(6)}`;
}

function formatUsdNullable(value: number | null | undefined, fallback = "Not enough data yet"): string {
  return value == null ? fallback : `$${value.toFixed(6)}`;
}

function formatHours(value: number | null | undefined, fallback = "0.0000h"): string {
  return value == null ? fallback : `${value.toFixed(4)}h`;
}

function formatInt(value: number | undefined): string {
  return String(value ?? 0);
}
