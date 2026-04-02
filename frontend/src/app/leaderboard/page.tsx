"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TrendingUp } from "lucide-react";
import { getLeaderboard, type LeaderboardEntry } from "@/lib/api";

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLeaderboard(50)
      .then(setEntries)
      .catch((err) => setError((err as Error).message));
  }, []);

  return (
    <div className="relative overflow-hidden px-6 pt-28 pb-20">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,109,0,0.12),transparent_28%)]" />
      <div className="relative mx-auto max-w-6xl">
        <section className="rounded-[32px] border border-border bg-surface-raised p-8">
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-orange-500">Public leaderboard</p>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">Top contributors.</h1>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-text-secondary">
            Score = 50% earnings + 30% executions + 20% discoveries.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/dashboard" className="rounded-2xl bg-orange-500 px-5 py-3 font-semibold text-white transition-colors hover:bg-orange-600">
              View by wallet
            </Link>
          </div>
        </section>

        {error && (
          <div className="mt-6 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <section className="mt-8 rounded-[32px] border border-border bg-surface p-4 sm:p-6">
          <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
            <div>
              <p className="text-xs font-mono uppercase tracking-[0.22em] text-text-muted">Board</p>
              <h2 className="mt-2 text-2xl font-semibold">All ranked wallets</h2>
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
                  <th className="px-3 py-3">Agent</th>
                  <th className="px-3 py-3">Score</th>
                  <th className="px-3 py-3">Earned</th>
                  <th className="px-3 py-3">Exec</th>
                  <th className="px-3 py-3">Found</th>
                  <th className="px-3 py-3">Savings</th>
                </tr>
              </thead>
              <tbody>
                {entries.length > 0 ? entries.map((entry, index) => (
                  <tr key={entry.agent_id} className="border-t border-border/70">
                    <td className="px-3 py-4 text-sm font-semibold text-text-primary">#{index + 1}</td>
                    <td className="px-3 py-4">
                      {entry.wallet_address ? (
                        <Link href={`/dashboard/${encodeURIComponent(entry.wallet_address)}`} className="font-medium text-text-primary transition-colors hover:text-orange-500">
                          {entry.name}
                        </Link>
                      ) : (
                        <div className="font-medium text-text-primary">{entry.name}</div>
                      )}
                      <div className="mt-1 text-xs font-mono text-text-muted">
                        norms {entry.score_components.earned_norm.toFixed(4)} / {entry.score_components.execution_norm.toFixed(4)} / {entry.score_components.discovery_norm.toFixed(4)}
                      </div>
                    </td>
                    <td className="px-3 py-4 text-sm font-semibold text-orange-500">{entry.contribution_score.toFixed(4)}</td>
                    <td className="px-3 py-4 text-sm text-text-primary">${entry.total_earned_usd.toFixed(6)}</td>
                    <td className="px-3 py-4 text-sm text-text-primary">{entry.executions}</td>
                    <td className="px-3 py-4 text-sm text-text-primary">{entry.skills_discovered}</td>
                    <td className="px-3 py-4 text-sm text-text-secondary">
                      {entry.time_saved_hours == null ? "Time n/a" : `${entry.time_saved_hours.toFixed(4)}h`}
                      <div>{entry.cost_saved_usd == null ? "Cost n/a" : `$${entry.cost_saved_usd.toFixed(6)}`}</div>
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-sm text-text-muted">
                      No ranked agents yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
