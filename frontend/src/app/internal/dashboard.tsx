"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, LockKeyhole, RefreshCw } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type CountRow = { key: string; count: number };
type UseCaseRow = CountRow & { key: string };

type InternalAnalytics = {
  generated_at: string;
  window_days: number;
  privacy?: {
    interpretation?: string;
    detailed_intents_available?: boolean;
    collected?: string;
    excluded?: string;
  };
  sources?: Record<string, { available: boolean }>;
  product?: {
    degraded?: string;
    engagement?: { dau?: number; wau?: number; mau?: number; dau_wau_ratio?: number; dau_mau_ratio?: number };
    retention?: { weighted?: Record<string, { rate: number; eligible_users: number; cohorts: number }> };
    user_split?: {
      registered_agents?: number;
      agent_creators?: number;
      agent_creator_share?: number;
      unclassified_non_creator_users?: number;
      acquisition_inferred_icp?: Array<{ value: string; sessions: number }>;
    };
    usage?: {
      sessions_30d?: { total_sessions_30d?: number; total_api_calls_30d?: number; unique_agents_30d?: number };
      cloud_service?: { requests?: number | null; errors?: number | null; error_rate?: number | null; window_days?: number; unavailable_reason?: string };
    };
  } | null;
  activity?: {
    total: number;
    active_installs: number;
    first_seen_at?: string | null;
    last_seen_at?: string | null;
    by_operation: CountRow[];
    by_use_case: UseCaseRow[];
    by_version: CountRow[];
    by_day: CountRow[];
    by_week: CountRow[];
    by_month: CountRow[];
    by_surface: CountRow[];
    by_execution_scope: CountRow[];
    telemetry_schema_coverage: number;
    operation_detail_coverage: number;
  } | null;
  issues?: {
    total: number;
    by_kind: CountRow[];
    by_surface: CountRow[];
    by_version: CountRow[];
  } | null;
  installs?: {
    totals?: {
      reported_installs?: number;
      invoked_installs?: number;
      uninvoked_installs?: number;
      registered_installs?: number;
      first_resolve_succeeded?: number;
    };
    hosts?: Array<{ host_type: string; installs: number; invoked: number; registered: number; first_resolve_succeeded: number }>;
  } | null;
  install_funnel?: {
    totals?: {
      installs?: number;
      cli_invoked?: number;
      setup_completed?: number;
      registrations?: number;
      first_resolve_succeeded?: number;
      second_success?: number;
      repeat_success?: number;
      power_users?: number;
      abandonment_24h?: number;
    };
    failures?: { total?: number; top_stages?: CountRow[]; top_reasons?: CountRow[] };
  } | null;
  install_churn?: {
    drop_off?: Array<{ stage: string; count: number; share: number }>;
  } | null;
  acquisition?: {
    totals?: { visitors?: number; sessions?: number; install_command_copies?: number; first_task_command_copies?: number };
    rates?: { install_copy_from_landing?: number; first_task_copy_from_install_copy?: number };
    top_referrers?: Array<{ referrer: string; sessions: number }>;
    dimensions?: { inferred_icp?: Array<{ value: string; sessions: number }> };
  } | null;
  growth?: {
    cumulative_users?: number;
    daily_new_users?: Array<{ date: string; value: number }>;
    last_7d_new_users?: number;
    new_user_growth_rate?: number;
  } | null;
  network?: {
    total_indexed_skills?: number;
    total_indexed_endpoints?: number;
    coverage_breadth?: number;
    indexed_skill_calls?: number;
    fresh_index_calls?: number;
    skill_reuse_rate?: number;
  } | null;
  bottleneck?: {
    cache_hit_rate?: number;
    marketplace_hit_rate?: number;
    live_capture_rate?: number;
    failure_rate?: number;
    resolve_latency_p50_ms?: number;
    resolve_latency_p95_ms?: number;
  } | null;
  economics?: {
    route_calls_30d?: number;
    discovery_queries_30d?: number;
    estimated_monthly_revenue_run_rate_usd?: number;
    brokered_compensation_usd_total?: number;
  } | null;
  activation?: {
    total_registered?: number;
    executed_once?: number;
    discovered_skill?: number;
    repeat_user?: number;
    power_user?: number;
    rates?: Record<string, number>;
  } | null;
  optimization_funnel?: {
    stages?: Array<{ key: string; label: string; users: number; eligible_users: number; conversion_from_previous: number; conversion_from_cohort: number }>;
  } | null;
  pricing?: {
    route_price_usd?: number;
    discovery_price_usd?: number;
    target_monthly_revenue_usd?: number;
  } | null;
  flywheel?: {
    credits?: { pool_remaining_uc?: number; agents_subsidized?: number; agents_self_sustaining?: number };
    index?: { new_endpoints_7d?: number; marketplace_hit_rate?: number };
    conversion?: { install_to_register?: number; register_to_first_resolve?: number; first_resolve_to_repeat?: number; overall_activation?: number };
  } | null;
  landing_funnel?: {
    experiment_id?: string;
    winner_variant_id?: string;
    variants?: Array<{ variant_id: string; label: string; status: string; landing_sessions: number; install_command_copies: number; first_resolve_succeeded: number; rates: { first_resolve_succeeded_from_landing: number } }>;
  } | null;
  attribution?: {
    rows?: Array<{ channel: string; campaign_id: string; landing_sessions: number; reported_installs: number; first_resolve_succeeded: number; session_success_rate: number }>;
  } | null;
};

const USE_CASES: Record<string, { label: string; description: string }> = {
  research_retrieval: { label: "Research & retrieval", description: "Get, search, extract, map, crawl and read web data" },
  browser_interaction: { label: "Browser interaction", description: "Navigate, click, fill, select, submit and scroll" },
  capture_replay: { label: "Capture & replay", description: "Learn routes, execute known capabilities and sync them" },
  auth_sessions: { label: "Auth & sessions", description: "Login, cookie, browser and session continuity work" },
  build_publish: { label: "Build & publish", description: "Create, review and publish reusable skills" },
  diagnostics: { label: "Diagnostics", description: "Status, trace, explain, schema and feedback checks" },
  account_platform: { label: "Account & platform", description: "Dashboard, earnings, account and host operations" },
  other: { label: "Unclassified", description: "Older telemetry or a category outside the allowlist" },
};

const CHART_TOOLTIP = {
  background: "var(--surface-raised)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text-primary)",
  fontSize: 12,
};

function formatInteger(value: number | null | undefined): string {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 1000) / 10}%`;
}

function formatLatency(value: number | null | undefined): string {
  if (value == null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll(":", " · ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function InternalDashboard() {
  const [days, setDays] = useState(90);
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState<InternalAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/internal/api?days=${days}`, { cache: "no-store", signal });
      const body = await response.json().catch(() => null) as InternalAnalytics | { error?: string } | null;
      if (!response.ok) throw new Error(body && "error" in body && body.error ? body.error : `HTTP ${response.status}`);
      setData(body as InternalAnalytics);
    } catch (cause) {
      if ((cause as { name?: string }).name !== "AbortError") {
        setError(cause instanceof Error ? cause.message : "Internal analytics unavailable");
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  const activity = data?.activity;
  const funnel = data?.install_funnel?.totals;
  const useCases = activity?.by_use_case ?? [];
  const maxUseCase = Math.max(1, ...useCases.map((row) => row.count));
  const funnelRows = useMemo(() => [
    { label: "Installed", value: funnel?.installs ?? 0 },
    { label: "CLI opened", value: funnel?.cli_invoked ?? 0 },
    { label: "Setup complete", value: funnel?.setup_completed ?? 0 },
    { label: "Registered", value: funnel?.registrations ?? 0 },
    { label: "First task done", value: funnel?.first_resolve_succeeded ?? 0 },
    { label: "Returned 5+ times", value: funnel?.repeat_success ?? 0 },
  ], [funnel]);
  const maxFunnel = Math.max(1, funnelRows[0]?.value ?? 0);
  const unavailableSources = Object.entries(data?.sources ?? {}).filter(([, value]) => !value.available).map(([key]) => key);
  const trend = (activity?.by_week ?? []).map((row) => ({ week: row.key.slice(5), actions: row.count }));
  const growthTrend = (data?.growth?.daily_new_users ?? []).map((row) => ({ day: row.date.slice(5), users: row.value }));

  return (
    <div className="min-h-screen bg-surface text-text-primary">
      <div className="mx-auto max-w-[92rem] px-4 pb-20 pt-28 sm:px-7 lg:px-10">
        <header className="border-y border-border py-5 sm:flex sm:items-end sm:justify-between sm:gap-8">
          <div>
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
              <LockKeyhole className="h-3.5 w-3.5 text-[var(--accent-spark)]" aria-hidden="true" />
              Private / aggregate-only
            </div>
            <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">What Unbrowse is doing in the wild</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary sm:text-base">
              A rolling ledger of observed work: which jobs people run, where they run them, what reaches first value, and where the system breaks.
            </p>
          </div>
          <div className="mt-5 flex items-center gap-2 sm:mt-0">
            <label className="sr-only" htmlFor="analytics-window">Analytics window</label>
            <select
              id="analytics-window"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              className="h-10 border border-border bg-surface-raised px-3 font-mono text-xs text-text-primary"
            >
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
            </select>
            <button
              type="button"
              onClick={() => setRefreshKey((value) => value + 1)}
              disabled={loading}
              className="inline-flex h-10 items-center gap-2 border border-border bg-surface-raised px-3 font-mono text-xs text-text-primary hover:border-border-strong disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </header>

        <div className="flex min-h-10 items-center justify-between gap-4 border-b border-border py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted" aria-live="polite">
          <span>{loading && !data ? "Reading private telemetry…" : data ? `Window ${data.window_days}d · generated ${new Date(data.generated_at).toLocaleString()}` : "No report loaded"}</span>
          <span className="hidden sm:inline">Observed minimum · opt-outs remain invisible</span>
        </div>

        {error && (
          <div className="my-6 border-l-2 border-red-500 bg-surface-sunken px-4 py-3 text-sm text-text-secondary">
            <strong className="text-text-primary">Couldn&apos;t load the signal room.</strong> {error}
          </div>
        )}
        {data?.product?.degraded && (
          <div className="my-6 border-l-2 border-amber-500 bg-surface-sunken px-4 py-3 text-sm text-text-secondary">
            Detailed store reads are degraded. Counts shown from fallback witnesses may be partial.
          </div>
        )}
        {unavailableSources.length > 0 && (
          <div className="my-6 border-l-2 border-amber-500 bg-surface-sunken px-4 py-3 text-sm text-text-secondary">
            Unavailable sources: {unavailableSources.join(", ")}. Other panels remain live.
          </div>
        )}

        <section className="grid grid-cols-2 border-b border-border md:grid-cols-3 xl:grid-cols-6" aria-label="Headline metrics">
          <Metric label={`Observed actions · ${days}d`} value={formatInteger(activity?.total)} note={`${formatInteger(activity?.active_installs)} active installs`} />
          <Metric label={`Reported installs · ${days}d`} value={formatInteger(data?.installs?.totals?.reported_installs)} note={`${formatInteger(data?.installs?.totals?.uninvoked_installs)} never opened`} />
          <Metric label="First tasks completed" value={formatInteger(funnel?.first_resolve_succeeded)} note={`${formatPercent((funnel?.first_resolve_succeeded ?? 0) / Math.max(1, funnel?.installs ?? 0))} of installs`} />
          <Metric label="Sessions · 30d" value={formatInteger(data?.product?.usage?.sessions_30d?.total_sessions_30d)} note={`${formatInteger(data?.product?.usage?.sessions_30d?.unique_agents_30d)} observed agents`} />
          <Metric label="Monthly active" value={formatInteger(data?.product?.engagement?.mau)} note={`DAU / MAU ${formatPercent(data?.product?.engagement?.dau_mau_ratio)}`} />
          <Metric label="Indexed coverage" value={formatInteger(data?.network?.total_indexed_endpoints)} note={`${formatInteger(data?.network?.coverage_breadth)} domains`} />
        </section>

        <section className="border-b border-border py-9">
          <SectionHeading eyebrow="Primary question" title="What people use Unbrowse for" detail="Counts are actions, not people. Categories are derived from fixed command and tool names; task text and URLs never leave the machine." />
          <div className="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1.65fr)_minmax(18rem,0.75fr)]">
            <div className="border-t border-border">
              {useCases.length > 0 ? useCases.map((row, index) => {
                const copy = USE_CASES[row.key] ?? USE_CASES.other;
                const share = activity?.total ? row.count / activity.total : 0;
                return (
                  <div key={row.key} className="grid grid-cols-[2rem_minmax(0,1fr)_4.5rem] gap-3 border-b border-border py-4 sm:grid-cols-[2.5rem_13rem_minmax(0,1fr)_5rem] sm:items-center">
                    <span className="font-mono text-xs text-text-muted">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <div className="text-sm font-medium text-text-primary">{copy.label}</div>
                      <div className="mt-0.5 text-xs leading-5 text-text-muted sm:hidden">{copy.description}</div>
                    </div>
                    <div className="col-span-2 col-start-2 sm:col-span-1 sm:col-start-auto">
                      <div className="mb-1.5 hidden text-xs text-text-muted sm:block">{copy.description}</div>
                      <div className="h-1.5 bg-surface-sunken" aria-hidden="true">
                        <div className="h-full bg-[var(--accent-spark)]" style={{ width: `${Math.max(2, (row.count / maxUseCase) * 100)}%` }} />
                      </div>
                    </div>
                    <div className="text-right font-mono text-sm tabular-nums">
                      {formatInteger(row.count)} <span className="block text-[10px] text-text-muted">{formatPercent(share)}</span>
                    </div>
                  </div>
                );
              }) : <EmptyState>No operation-level actions have landed in this window.</EmptyState>}
            </div>
            <RankedList title="Top operations" rows={activity?.by_operation} />
          </div>
        </section>

        <section className="grid border-b border-border lg:grid-cols-2">
          <Panel title={`Observed activity · weekly · ${days}d`}>
            {trend.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={trend} margin={{ top: 8, right: 6, left: -24, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="week" tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP} />
                  <Area type="monotone" dataKey="actions" stroke="var(--accent-spark)" fill="color-mix(in oklab, var(--accent-spark) 16%, transparent)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <EmptyState>No weekly action history in this window.</EmptyState>}
          </Panel>
          <Panel title={`New registered users · ${days}d`}>
            {growthTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={growthTrend} margin={{ top: 8, right: 6, left: -24, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} minTickGap={22} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP} />
                  <Bar dataKey="users" fill="var(--text-primary)" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyState>No registration trend available.</EmptyState>}
          </Panel>
        </section>

        <section className="grid border-b border-border xl:grid-cols-[1.2fr_0.8fr]">
          <Panel title="Install → first value">
            <div className="space-y-4">
              {funnelRows.map((row) => (
                <div key={row.label} className="grid grid-cols-[8.5rem_minmax(0,1fr)_3rem] items-center gap-3">
                  <span className="text-xs text-text-secondary">{row.label}</span>
                  <div className="h-5 bg-surface-sunken">
                    <div className="h-full bg-text-primary/85" style={{ width: `${Math.max(row.value ? 2 : 0, (row.value / maxFunnel) * 100)}%` }} />
                  </div>
                  <span className="text-right font-mono text-xs tabular-nums text-text-primary">{formatInteger(row.value)}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 grid grid-cols-3 gap-px bg-border border border-border">
              <SmallStat label="2nd success" value={formatInteger(funnel?.second_success)} />
              <SmallStat label="Power users" value={formatInteger(funnel?.power_users)} />
              <SmallStat label="24h abandon" value={formatInteger(funnel?.abandonment_24h)} />
            </div>
          </Panel>
          <Panel title="Where the work runs">
            <div className="grid gap-7 sm:grid-cols-2">
              <RankedList title="Surface" rows={activity?.by_surface} compact />
              <RankedList title="Execution scope" rows={activity?.by_execution_scope} compact />
              <RankedList title="Client version" rows={activity?.by_version} compact />
              <RankedList
                title="Install host"
                rows={data?.installs?.hosts?.map((row) => ({ key: row.host_type, count: row.installs }))}
                compact
              />
            </div>
          </Panel>
        </section>

        <section className="grid border-b border-border lg:grid-cols-3">
          <Panel title="Route engine">
            <SignalRow label="Skill reuse rate" value={formatPercent(data?.network?.skill_reuse_rate)} />
            <SignalRow label="Cache hit rate" value={formatPercent(data?.bottleneck?.cache_hit_rate)} />
            <SignalRow label="Marketplace hit rate" value={formatPercent(data?.bottleneck?.marketplace_hit_rate)} />
            <SignalRow label="Live capture rate" value={formatPercent(data?.bottleneck?.live_capture_rate)} />
            <SignalRow label="Failure rate" value={formatPercent(data?.bottleneck?.failure_rate)} />
            <SignalRow label="Resolve p50 / p95" value={`${formatLatency(data?.bottleneck?.resolve_latency_p50_ms)} / ${formatLatency(data?.bottleneck?.resolve_latency_p95_ms)}`} />
          </Panel>
          <Panel title={`Faults · ${days}d`}>
            <div className="mb-5 flex items-baseline justify-between border-b border-border pb-3">
              <span className="text-xs text-text-muted">Reported surface errors</span>
              <span className="font-mono text-3xl tabular-nums">{formatInteger(data?.issues?.total)}</span>
            </div>
            <RankedList title="Top error classes" rows={data?.issues?.by_kind} compact />
          </Panel>
          <Panel title={`Acquisition · ${days}d`}>
            <SignalRow label="Website sessions" value={formatInteger(data?.acquisition?.totals?.sessions)} />
            <SignalRow label="Install copies" value={formatInteger(data?.acquisition?.totals?.install_command_copies)} />
            <SignalRow label="First-task copies" value={formatInteger(data?.acquisition?.totals?.first_task_command_copies)} />
            <SignalRow label="Landing → install copy" value={formatPercent(data?.acquisition?.rates?.install_copy_from_landing)} />
            <div className="mt-5">
              <RankedList title="Top referrers" rows={data?.acquisition?.top_referrers?.map((row) => ({ key: row.referrer, count: row.sessions }))} compact />
            </div>
          </Panel>
        </section>

        <section className="grid border-b border-border lg:grid-cols-3">
          <Panel title="Retention checkpoints">
            {Object.entries(data?.product?.retention?.weighted ?? {}).length > 0 ? Object.entries(data?.product?.retention?.weighted ?? {}).map(([checkpoint, value]) => (
              <SignalRow key={checkpoint} label={`${checkpoint.toUpperCase()} retained · ${formatInteger(value.eligible_users)} eligible`} value={formatPercent(value.rate)} />
            )) : <EmptyState>No eligible retention cohorts yet.</EmptyState>}
            <div className="mt-6 border-t border-border pt-4">
              <SignalRow label="Registered identities" value={formatInteger(data?.product?.user_split?.registered_agents)} />
              <SignalRow label="Skill creators" value={formatInteger(data?.product?.user_split?.agent_creators)} />
              <SignalRow label="Creator share" value={formatPercent(data?.product?.user_split?.agent_creator_share)} />
            </div>
          </Panel>
          <Panel title="Registered-user activation">
            <SignalRow label="Registered" value={formatInteger(data?.activation?.total_registered)} />
            <SignalRow label="Executed once" value={formatInteger(data?.activation?.executed_once)} />
            <SignalRow label="Discovered a skill" value={formatInteger(data?.activation?.discovered_skill)} />
            <SignalRow label="Repeat users · 5+" value={formatInteger(data?.activation?.repeat_user)} />
            <SignalRow label="Power users · 20+" value={formatInteger(data?.activation?.power_user)} />
            <div className="mt-5">
              <RankedList
                title="Inferred audience · sessions"
                rows={data?.product?.user_split?.acquisition_inferred_icp?.map((row) => ({ key: row.value, count: row.sessions }))}
                compact
              />
            </div>
          </Panel>
          <Panel title="Landing experiments">
            <div className="mb-5 text-xs leading-5 text-text-muted">
              Experiment <span className="font-mono text-text-secondary">{data?.landing_funnel?.experiment_id ?? "—"}</span>
              {data?.landing_funnel?.winner_variant_id ? ` · winner ${data.landing_funnel.winner_variant_id}` : " · no winner yet"}
            </div>
            <RankedList
              title="Variants · first tasks completed"
              rows={data?.landing_funnel?.variants?.map((variant) => ({ key: `${variant.label} (${variant.status})`, count: variant.first_resolve_succeeded }))}
              compact
            />
            <div className="mt-5">
              <RankedList
                title="Campaigns · first tasks completed"
                rows={data?.attribution?.rows?.map((row) => ({ key: `${row.channel} / ${row.campaign_id}`, count: row.first_resolve_succeeded }))}
                compact
              />
            </div>
          </Panel>
        </section>

        <section className="grid border-b border-border lg:grid-cols-3">
          <Panel title="Commercial signal">
            <SignalRow label="Route calls · 30d" value={formatInteger(data?.economics?.route_calls_30d)} />
            <SignalRow label="Discovery queries · 30d" value={formatInteger(data?.economics?.discovery_queries_30d)} />
            <SignalRow label="Monthly run-rate" value={data?.economics?.estimated_monthly_revenue_run_rate_usd == null ? "—" : `$${data.economics.estimated_monthly_revenue_run_rate_usd.toFixed(2)}`} />
            <SignalRow label="Brokered revenue · lifetime" value={data?.economics?.brokered_compensation_usd_total == null ? "—" : `$${data.economics.brokered_compensation_usd_total.toFixed(4)}`} />
            <div className="mt-5 border-t border-border pt-3">
              <SignalRow label="Route price" value={data?.pricing?.route_price_usd == null ? "—" : `$${data.pricing.route_price_usd}`} />
              <SignalRow label="Discovery price" value={data?.pricing?.discovery_price_usd == null ? "—" : `$${data.pricing.discovery_price_usd}`} />
              <SignalRow label="Subsidized agents" value={formatInteger(data?.flywheel?.credits?.agents_subsidized)} />
              <SignalRow label="Self-sustaining agents" value={formatInteger(data?.flywheel?.credits?.agents_self_sustaining)} />
            </div>
          </Panel>
          <Panel title="Independent cloud witness">
            <SignalRow label={`Worker requests · ${data?.product?.usage?.cloud_service?.window_days ?? 30}d`} value={formatInteger(data?.product?.usage?.cloud_service?.requests)} />
            <SignalRow label="Worker errors" value={formatInteger(data?.product?.usage?.cloud_service?.errors)} />
            <SignalRow label="Worker error rate" value={formatPercent(data?.product?.usage?.cloud_service?.error_rate)} />
            {data?.product?.usage?.cloud_service?.unavailable_reason && (
              <p className="mt-4 text-xs leading-5 text-text-muted">Cloudflare Analytics: {humanize(data.product.usage.cloud_service.unavailable_reason)}.</p>
            )}
          </Panel>
          <Panel title="Telemetry fidelity">
            <SignalRow label="Schema-tagged actions" value={formatPercent(activity?.telemetry_schema_coverage)} />
            <SignalRow label="Operation-level detail" value={formatPercent(activity?.operation_detail_coverage)} />
            <SignalRow label="First observed" value={activity?.first_seen_at ? new Date(activity.first_seen_at).toLocaleDateString() : "—"} />
            <SignalRow label="Last observed" value={activity?.last_seen_at ? new Date(activity.last_seen_at).toLocaleString() : "—"} />
          </Panel>
        </section>

        <footer className="mt-8 grid gap-4 border border-border bg-surface-sunken p-5 sm:grid-cols-[auto_1fr] sm:items-start">
          <Activity className="h-5 w-5 text-[var(--accent-spark)]" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-medium">How to read this</h2>
            <p className="mt-1 max-w-5xl text-xs leading-5 text-text-muted">
              This is a privacy-safe observed minimum, not a billing ledger. Telemetry can be disabled, old clients report less detail, and one product action can make zero or many Worker requests. We retain fixed operation categories—not raw prompts, URLs, arguments, credentials, response bodies, or user-level activity rows. Operation detail improves as schema v2 clients roll out.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-h-32 border-l border-border px-4 py-5 first:border-l-0 md:px-5">
      <div className="font-mono text-2xl font-medium tracking-[-0.035em] tabular-nums sm:text-3xl">{value}</div>
      <div className="mt-2 text-xs font-medium text-text-secondary">{label}</div>
      <div className="mt-1 font-mono text-[10px] text-text-muted">{note}</div>
    </div>
  );
}

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_1fr] lg:items-end">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--accent-spark)]">{eyebrow}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">{title}</h2>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-text-muted lg:justify-self-end">{detail}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-l border-border px-4 py-7 first:border-l-0 sm:px-6 lg:min-h-[22rem]">
      <h2 className="mb-6 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">{title}</h2>
      {children}
    </div>
  );
}

function RankedList({ title, rows, compact = false }: { title: string; rows?: CountRow[]; compact?: boolean }) {
  const shown = (rows ?? []).slice(0, compact ? 5 : 10);
  const max = Math.max(1, ...shown.map((row) => row.count));
  return (
    <div>
      <div className="mb-3 text-xs text-text-muted">{title}</div>
      {shown.length === 0 ? <div className="border-t border-border py-4 text-xs text-text-muted">No data</div> : (
        <div className="border-t border-border">
          {shown.map((row) => (
            <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_3rem] gap-3 border-b border-border py-2.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px] text-text-secondary" title={row.key}>{humanize(row.key)}</div>
                <div className="mt-1 h-1 bg-surface-sunken"><div className="h-full bg-text-primary/75" style={{ width: `${Math.max(3, (row.count / max) * 100)}%` }} /></div>
              </div>
              <span className="text-right font-mono text-xs tabular-nums text-text-primary">{formatInteger(row.count)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-3 first:pt-0">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-right font-mono text-sm tabular-nums text-text-primary">{value}</span>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return <div className="bg-surface-sunken p-3 text-center"><div className="font-mono text-lg tabular-nums">{value}</div><div className="mt-1 text-[10px] text-text-muted">{label}</div></div>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-40 items-center justify-center border-b border-border px-4 text-center text-sm text-text-muted">{children}</div>;
}
