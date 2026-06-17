"use client";

/* Hallmark · macrostructure: Stat-Led · tone: utilitarian/technical · genre: modern-minimal
 * theme: project-system (warm-paper light · cyan spark) · component: ops-dashboard
 * pre-emit critique: P4 H5 E4 S5 R5 V4
 *
 * Internal-only ops dashboard (its own stratum — not in public nav): aggregates the
 * LIVE usage analytics (/v1/analytics/*) and the surface-error feed
 * (/v1/telemetry/issues — the "secret faults" users hit across CLI/FE/backend).
 * Access is gated at the EDGE (middleware HTTP Basic auth) before this page is
 * served, plus the admin Bearer key for the data. Honest: surfaces the feed's
 * error/reason when down — no fabricated "healthy".
 */

import { useCallback, useEffect, useState } from "react";

const DEFAULT_API = "https://beta-api.unbrowse.ai";

interface UsageData {
  total_sessions_30d?: number;
  unique_agents_30d?: number;
  api_calls_per_session?: number;
  repeat_usage_rate?: number;
  version_breakdown_30d?: { trace_version: string; sessions: number }[];
}
interface IssuesData {
  ok?: boolean;
  total?: number;
  days?: number;
  by_kind?: { key: string; count: number }[];
  by_surface?: { key: string; count: number }[];
  by_version?: { key: string; count: number }[];
  recent?: {
    created_at: string;
    surface: string;
    kind: string;
    message?: string;
    version?: string;
    context?: Record<string, unknown>;
  }[];
  error?: string;
  reason?: string;
}

const SURFACE_DOT: Record<string, string> = {
  cli: "var(--accent-spark)",
  frontend: "var(--text-secondary)",
  backend: "var(--border-strong)",
};

export default function InternalDashboard() {
  const [apiBase, setApiBase] = useState(DEFAULT_API);
  const [key, setKey] = useState("");
  const [days, setDays] = useState(7);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [issues, setIssues] = useState<IssuesData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    const k = localStorage.getItem("unbrowse_admin_key");
    if (k) setKey(k);
    const b = localStorage.getItem("unbrowse_api_base");
    if (b) setApiBase(b);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      localStorage.setItem("unbrowse_admin_key", key);
      localStorage.setItem("unbrowse_api_base", apiBase);
      const base = apiBase.replace(/\/+$/, "");
      const auth = { authorization: `Bearer ${key}` };
      const [u, i] = (await Promise.all([
        fetch(`${base}/v1/analytics/usage`, { headers: auth }).then((r) => r.json()).catch(() => null),
        fetch(`${base}/v1/telemetry/issues?days=${days}`, { headers: auth }).then((r) => r.json()).catch(() => null),
      ])) as [UsageData | null, IssuesData | null];
      setUsage(u);
      setIssues(i);
      if (i && i.ok === false) setErr(i.error || i.reason || "issues feed error");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [apiBase, key, days]);

  const fmt = (v: number | undefined, suffix = "") =>
    v === undefined || v === null ? "—" : `${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : v}${suffix}`;

  return (
    <main className="min-h-screen bg-surface text-text-primary">
      <div className="mx-auto max-w-6xl px-5 sm:px-6 py-10">
        {/* Header + toolbar */}
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between mb-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ background: "var(--accent-spark)", boxShadow: "0 0 0 3px color-mix(in oklab, var(--accent-spark) 18%, transparent)" }}
              />
              <h1 className="text-2xl font-semibold tracking-[-0.01em]">Internal ops</h1>
            </div>
            <p className="text-text-muted text-sm mt-1.5 leading-relaxed">
              Usage at a glance, and the errors users actually hit — CLI · frontend · backend.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              className="h-9 w-44 rounded-lg border border-border bg-surface-raised px-3 text-sm text-text-primary placeholder:text-text-muted/70 outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-[var(--accent-spark)]/25 transition-colors"
              type="password" placeholder="admin key" value={key} onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && key) void load(); }}
            />
            <select
              className="h-9 rounded-lg border border-border bg-surface-raised px-2.5 text-sm text-text-secondary outline-none focus-visible:border-border-strong transition-colors"
              value={days} onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={1}>24h</option><option value={7}>7 days</option><option value={30}>30 days</option>
            </select>
            <button
              className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-surface transition-[opacity,transform] hover:opacity-90 active:translate-y-px disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => void load()} disabled={loading || !key}
            >
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
        </header>

        {err && (
          <div className="mb-8 flex items-start gap-2.5 rounded-xl border border-border-strong bg-surface-sunken px-4 py-3 text-sm text-text-secondary">
            <span className="mt-0.5 text-text-primary">⚠</span>
            <span>{err}</span>
          </div>
        )}

        {/* Usage */}
        {usage && (
          <section className="mb-12">
            <SectionLabel>Usage · last 30 days</SectionLabel>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Metric label="Sessions" value={fmt(usage.total_sessions_30d)} />
              <Metric label="Unique agents" value={fmt(usage.unique_agents_30d)} />
              <Metric label="Calls / session" value={fmt(usage.api_calls_per_session)} />
              <Metric label="Repeat rate" value={fmt(usage.repeat_usage_rate)} />
            </div>
            {usage.version_breakdown_30d && usage.version_breakdown_30d.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {usage.version_breakdown_30d.map((v) => (
                  <span key={v.trace_version} className="rounded-md border border-border bg-surface-raised px-2 py-1 font-mono text-[11px] text-text-muted">
                    {v.trace_version.slice(0, 14)} · {v.sessions}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Issues */}
        {issues && issues.ok !== false && (
          <section>
            <SectionLabel>
              Issues · last {issues.days ?? days}d
              <span className="ml-2 font-mono text-text-primary">{issues.total ?? 0}</span>
            </SectionLabel>
            <div className="grid gap-3 md:grid-cols-2 mb-3">
              <BarsCard title="By kind" rows={issues.by_kind} />
              <BarsCard title="By surface" rows={issues.by_surface} />
            </div>

            <div className="overflow-x-auto rounded-2xl border border-border bg-surface-sunken">
              <div className="min-w-[34rem]">
              <div className="grid grid-cols-[7rem_5.5rem_minmax(0,1fr)_5rem] gap-3 border-b border-border px-4 py-2.5 text-[11px] uppercase tracking-wide text-text-muted">
                <span>When</span><span>Surface</span><span>Kind · message</span><span className="text-right">Version</span>
              </div>
              <div className="divide-y divide-border/60">
                {(issues.recent ?? []).map((e, idx) => (
                  <div key={idx} className="grid grid-cols-[7rem_5.5rem_minmax(0,1fr)_5rem] items-baseline gap-3 px-4 py-2.5 text-sm">
                    <span className="font-mono text-xs text-text-muted whitespace-nowrap">{e.created_at?.slice(5, 16).replace("T", " ")}</span>
                    <span className="flex items-center gap-1.5 text-text-secondary text-xs">
                      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: SURFACE_DOT[e.surface] ?? "var(--text-muted)" }} />
                      {e.surface}
                    </span>
                    <span className="min-w-0">
                      <span className="font-mono text-xs text-text-primary">{e.kind}</span>
                      {(e.message || e.context) && (
                        <span className="ml-2 text-text-muted truncate inline-block max-w-full align-bottom">
                          {e.message ?? JSON.stringify(e.context ?? {}).slice(0, 80)}
                        </span>
                      )}
                    </span>
                    <span className="text-right font-mono text-[11px] text-text-muted">{(e.version ?? "").slice(0, 8)}</span>
                  </div>
                ))}
                {(!issues.recent || issues.recent.length === 0) && (
                  <div className="px-4 py-10 text-center text-sm text-text-muted">
                    No issues in this window — healthy, or nothing emitted yet.
                  </div>
                )}
              </div>
              </div>
            </div>
          </section>
        )}

        {/* Initial / empty state */}
        {!loading && !loadedOnce && (
          <div className="rounded-2xl border border-dashed border-border bg-surface-sunken px-6 py-16 text-center">
            <p className="text-text-primary font-medium">Enter an admin key and load.</p>
            <p className="text-text-muted text-sm mt-1.5">Usage from <span className="font-mono text-xs">/v1/analytics</span>, issues from <span className="font-mono text-xs">/v1/telemetry/issues</span>.</p>
          </div>
        )}
      </div>
    </main>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-4 text-sm font-medium text-text-secondary flex items-center">{children}</h2>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface-sunken p-4">
      <div className="font-mono text-3xl font-semibold tracking-[-0.02em] text-text-primary tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-text-muted">{label}</div>
    </div>
  );
}

function BarsCard({ title, rows }: { title: string; rows?: { key: string; count: number }[] }) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.count));
  return (
    <div className="rounded-2xl border border-border bg-surface-sunken p-4">
      <div className="mb-3 text-xs text-text-muted">{title}</div>
      {(rows ?? []).length === 0 && <div className="text-text-muted/70 text-sm">none</div>}
      <div className="space-y-2">
        {(rows ?? []).slice(0, 8).map((r) => (
          <div key={r.key} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate font-mono text-xs text-text-secondary">{r.key}</span>
            <span className="relative h-2 flex-1 rounded-full bg-surface overflow-hidden">
              <span className="absolute inset-y-0 left-0 rounded-full bg-text-primary/85" style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} />
            </span>
            <span className="w-8 shrink-0 text-right font-mono text-xs text-text-muted tabular-nums">{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
