"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Coins, Clock3, KeyRound, LogOut, SearchCheck, Trophy } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { getMyDashboard, type DashboardData } from "@/lib/api";

export default function DashboardPage() {
  const router = useRouter();
  const { isAuthenticated, agentName, logout, apiKey, agentId } = useAuth();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
      return;
    }
    getMyDashboard()
      .then(setDashboard)
      .catch((err) => setError((err as Error).message));
  }, [isAuthenticated, router]);

  if (!isAuthenticated) return null;

  return (
    <div className="relative overflow-hidden px-6 pt-28 pb-20">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,109,0,0.16),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(255,109,0,0.08),transparent_28%)]" />
      <div className="relative mx-auto max-w-7xl">
        <div className="flex flex-col gap-5 rounded-[32px] border border-border bg-surface-raised p-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.24em] text-text-muted">Economics Surface</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">{dashboard?.profile.name ?? agentName ?? "Agent dashboard"}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
              Ledger-backed spend, earnings, savings, and contribution rank. Missing fields stay unavailable until the runtime reports real telemetry.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/leaderboard"
              className="inline-flex items-center gap-2 rounded-2xl border border-orange-500/20 bg-orange-500/10 px-4 py-2.5 text-sm font-medium text-orange-500 transition-colors hover:border-orange-500/40"
            >
              View leaderboard
              <ArrowUpRight className="h-4 w-4" />
            </Link>
            <button
              onClick={() => {
                logout();
                router.push("/login");
              }}
              className="inline-flex items-center gap-2 rounded-2xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-red-500/30 hover:text-red-400"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={<Coins className="h-4 w-4" />} label="Money earned" value={formatUsd(dashboard?.economics.total_earned_usd)} tone="orange" />
          <MetricCard icon={<SearchCheck className="h-4 w-4" />} label="Money spent" value={formatUsd(dashboard?.economics.spent_usd)} />
          <MetricCard icon={<Clock3 className="h-4 w-4" />} label="Time saved" value={formatHours(dashboard?.savings.time_saved_hours, "Not enough data yet")} unavailableText="Not enough data yet" />
          <MetricCard icon={<Trophy className="h-4 w-4" />} label="Cost saved" value={formatUsdNullable(dashboard?.savings.cost_saved_usd)} unavailableText="Not enough data yet" />
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <MetricCard label="Skills discovered" value={formatInt(dashboard?.activity.skills_discovered)} compact />
          <MetricCard label="Executions" value={formatInt(dashboard?.activity.total_executions)} compact />
          <MetricCard label="Feedback" value={formatInt(dashboard?.activity.total_feedback_given)} compact />
        </div>

        <div className="mt-8 grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <section className="grid gap-6">
            <Panel title="Earnings" eyebrow="Money in">
              <BreakdownRow label="Creator payouts" value={formatUsd(dashboard?.economics.creator_earned_usd)} />
              <BreakdownRow label="Attribution credits" value={formatUsd(dashboard?.economics.attribution_earned_usd)} />
              <BreakdownRow label="Total earned" value={formatUsd(dashboard?.economics.total_earned_usd)} strong />
            </Panel>

            <Panel title="Spending" eyebrow="Money out">
              <BreakdownRow label="Skill spend" value={formatUsd(dashboard?.economics.skill_spend_usd)} />
              <BreakdownRow label="Graph / search fees" value={formatUsd(dashboard?.economics.graph_fees_paid_usd)} />
              <BreakdownRow label="Platform fees paid" value={formatUsd(dashboard?.economics.platform_fees_paid_usd)} />
              <BreakdownRow label="Tracked paid execution" value={formatUsd(dashboard?.economics.paid_execution_usd)} />
              <BreakdownRow label="Total spent" value={formatUsd(dashboard?.economics.spent_usd)} strong />
            </Panel>

            <Panel title="Recent activity" eyebrow="Ledger events">
              {dashboard?.recent_transactions.length ? (
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
                            platform fee {formatUsd(transaction.platform_fee_usd)}
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
            <Panel title="Rank" eyebrow="Contribution">
              <div className="rounded-3xl border border-orange-500/20 bg-orange-500/10 p-5">
                <p className="text-xs font-mono uppercase tracking-[0.24em] text-orange-500">All-time score</p>
                <p className="mt-3 text-4xl font-bold gradient-text">{(dashboard?.rank.contribution_score ?? 0).toFixed(4)}</p>
                <p className="mt-3 text-sm text-text-secondary">
                  {dashboard?.rank.position != null
                    ? `Position #${dashboard.rank.position} on the public board.`
                    : "No public rank yet. Earn, execute, or discover to enter the board."}
                </p>
              </div>
              <Link
                href="/leaderboard"
                className="inline-flex items-center justify-between rounded-2xl border border-border px-4 py-3 text-sm font-medium text-text-primary transition-colors hover:border-orange-500/30 hover:text-orange-500"
              >
                Open leaderboard
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Panel>

            <Panel title="Savings telemetry" eyebrow="Truth only">
              <BreakdownRow label="Time saved" value={formatHours(dashboard?.savings.time_saved_hours, "Not enough data yet")} />
              <BreakdownRow label="Cost saved" value={formatUsdNullable(dashboard?.savings.cost_saved_usd, "Not enough data yet")} />
              <p className="mt-4 text-sm leading-6 text-text-secondary">
                These values stay blank until the runtime reports real baselines. No guessed savings, no placeholders.
              </p>
            </Panel>

            <Panel title="Settings" eyebrow="Account">
              <div className="space-y-4 text-sm">
                <SettingsRow label="Agent name" value={dashboard?.profile.name ?? agentName ?? "Unknown"} />
                <SettingsRow label="Agent ID" value={dashboard?.profile.agent_id ?? agentId ?? "Unknown"} mono />
                <SettingsRow
                  label="Registered"
                  value={dashboard?.profile.created_at ? new Date(dashboard.profile.created_at).toLocaleDateString() : "Unknown"}
                />
                <SettingsRow label="API key status" value={apiKey ? "Connected" : "Missing"} />
                <SettingsRow label="API key preview" value={apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : "Unavailable"} mono />
                <div className="pt-2">
                  <button
                    onClick={() => {
                      logout();
                      router.push("/login");
                    }}
                    className="inline-flex items-center gap-2 rounded-2xl border border-border px-4 py-2.5 font-medium text-text-secondary transition-colors hover:border-red-500/30 hover:text-red-400"
                  >
                    <KeyRound className="h-4 w-4" />
                    Disconnect this browser
                  </button>
                </div>
              </div>
            </Panel>
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

function BreakdownRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/70 py-3 last:border-b-0">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className={`text-sm ${strong ? "font-semibold text-text-primary" : "font-medium text-text-primary"}`}>{value}</span>
    </div>
  );
}

function SettingsRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-text-muted">{label}</span>
      <span className={`${mono ? "font-mono text-xs sm:max-w-[16rem]" : ""} break-all text-text-primary`}>{value}</span>
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
