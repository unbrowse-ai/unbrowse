"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import {
  getTelemetryRecentFailures,
  type TelemetryFailureRow,
} from "@/lib/api";

type GroupKey = "error_class" | "last_tool" | "mcp_version" | "platform";

const GROUP_OPTIONS: Array<{ key: GroupKey; label: string }> = [
  { key: "error_class", label: "error_class" },
  { key: "last_tool", label: "last_tool" },
  { key: "mcp_version", label: "mcp_version" },
  { key: "platform", label: "platform" },
];

interface GroupBucket {
  key: string;
  count: number;
  sample: TelemetryFailureRow[];
}

function bucketBy(rows: TelemetryFailureRow[], key: GroupKey): GroupBucket[] {
  const map = new Map<string, GroupBucket>();
  for (const row of rows) {
    const value = (row[key] ?? "(none)") as string;
    const cur = map.get(value) ?? { key: value, count: 0, sample: [] };
    cur.count += 1;
    if (cur.sample.length < 3) cur.sample.push(row);
    map.set(value, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function FunnelFailuresLoader() {
  const { isAuthenticated, logout } = useAuth();
  const [rows, setRows] = useState<TelemetryFailureRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupKey>("error_class");
  const [limit, setLimit] = useState(200);
  const [sinceHours, setSinceHours] = useState(24);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setForbidden(false);

    const sinceIsoUtc = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    getTelemetryRecentFailures({ limit, sinceIsoUtc })
      .then((body) => {
        if (cancelled) return;
        setRows(body.failures ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = (err as Error).message ?? "";
        // The backend returns 403 with body { error: "Admin only" } when the
        // caller isn't admin; surface that as a dedicated state, not a raw
        // error chip. authApi throws Errors carrying the body status text.
        if (/403|admin/i.test(message)) {
          setForbidden(true);
        } else {
          setError(message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, limit, sinceHours]);

  const buckets = useMemo(() => {
    if (!rows) return [];
    return bucketBy(rows, groupBy);
  }, [rows, groupBy]);

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-2xl px-6 pb-20 pt-32">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
          ##  Ops · Funnel failures
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
          Sign in to view recent failures
        </h1>
        <p className="mt-3 text-sm text-text-secondary leading-relaxed">
          Admin-only. Backend returns 403 for any non-admin caller.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-orange-500 text-white font-mono font-medium text-sm w-full sm:w-auto hover:bg-orange-600 active:translate-y-px transition-all cursor-pointer"
          >
            <span>[ Sign in with email ]</span>
          </Link>
        </div>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl px-6 pb-20 pt-32">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-3">
          ##  Ops · Funnel failures
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance text-text-primary">
          Admin only
        </h1>
        <p className="mt-3 text-sm text-text-secondary leading-relaxed">
          Your account isn&apos;t the marketplace admin. The funnel-failure ledger is gated to the admin agent only.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-orange-500 text-white font-mono font-medium text-sm w-full sm:w-auto hover:bg-orange-600 active:translate-y-px transition-all cursor-pointer"
          >
            <span>[ Back to dashboard ]</span>
          </Link>
          <button
            onClick={logout}
            className="inline-flex items-center justify-center gap-2 px-7 py-2.5 bg-[#0c0804] border border-[rgba(255,122,32,0.4)] text-[rgba(255,176,96,0.9)] text-sm font-mono w-full sm:w-auto hover:bg-[rgba(255,122,32,0.1)] hover:border-[rgba(255,122,32,0.65)] active:translate-y-px transition-all cursor-pointer"
          >
            <span>[ Switch account ]</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 pb-20 pt-32 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[rgba(255,122,32,0.55)] mb-2">
            ##  Ops · Funnel failures
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-text-primary">
            Recent failed sessions ({rows?.length ?? 0})
          </h1>
          <p className="mt-2 text-sm text-text-secondary max-w-2xl">
            Reads <code>/v1/telemetry/recent-failures</code>. Groups by the chosen
            dimension and surfaces the top failing buckets so triage can pick the
            next bug class to fix.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm font-mono">
          <label className="flex items-center gap-2 text-text-muted">
            group by
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupKey)}
              className="bg-[#060402] border border-[rgba(255,122,32,0.25)] rounded-sm px-2 py-1 text-text-primary"
            >
              {GROUP_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-text-muted">
            since (h)
            <input
              type="number"
              min={1}
              max={168}
              value={sinceHours}
              onChange={(e) => setSinceHours(Math.max(1, Math.min(168, parseInt(e.target.value, 10) || 24)))}
              className="bg-[#060402] border border-[rgba(255,122,32,0.25)] rounded-sm px-2 py-1 w-16 text-text-primary"
            />
          </label>
          <label className="flex items-center gap-2 text-text-muted">
            limit
            <input
              type="number"
              min={1}
              max={1000}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 200)))}
              className="bg-[#060402] border border-[rgba(255,122,32,0.25)] rounded-sm px-2 py-1 w-20 text-text-primary"
            />
          </label>
        </div>
      </div>

      {loading && (
        <p className="text-sm text-text-muted font-mono">Loading...</p>
      )}

      {error && (
        <div className="rounded-2xl border border-border bg-surface-sunken p-5 text-sm text-text-primary">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-text-muted mb-1">
            Couldn&apos;t load failures
          </div>
          <div className="text-text-secondary">{error}</div>
        </div>
      )}

      {!loading && !error && rows && rows.length === 0 && (
        <p className="text-sm text-text-muted font-mono">
          No failed sessions in the last {sinceHours}h. The corpus feeder has nothing to chew on.
        </p>
      )}

      {!loading && !error && buckets.length > 0 && (
        <div className="space-y-3">
          {buckets.map((b) => (
            <div
              key={b.key}
              className="border border-[rgba(255,122,32,0.22)] bg-[#070503]/85 rounded-sm p-4 font-mono text-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-text-primary truncate">
                  <span className="text-[rgba(255,176,96,0.85)]">{groupBy}=</span>
                  <span className="text-orange-500">{b.key}</span>
                </div>
                <div className="text-text-muted text-xs">
                  {b.count} session{b.count === 1 ? "" : "s"}
                </div>
              </div>
              <ul className="mt-3 space-y-1.5 text-xs text-text-secondary">
                {b.sample.map((row) => (
                  <li key={row.session_id} className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="text-text-muted">{new Date(row.received_at).toLocaleString()}</span>
                    {row.intent && <span>intent=<span className="text-text-primary">{row.intent.slice(0, 60)}</span></span>}
                    {row.url && <span>url=<span className="text-text-primary">{row.url.slice(0, 60)}</span></span>}
                    {row.last_tool && groupBy !== "last_tool" && <span>tool=<span className="text-text-primary">{row.last_tool}</span></span>}
                    {row.error_class && groupBy !== "error_class" && <span>err=<span className="text-text-primary">{row.error_class}</span></span>}
                    {row.platform && groupBy !== "platform" && <span>platform=<span className="text-text-primary">{row.platform}</span></span>}
                    {row.mcp_version && groupBy !== "mcp_version" && <span>v=<span className="text-text-primary">{row.mcp_version}</span></span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
