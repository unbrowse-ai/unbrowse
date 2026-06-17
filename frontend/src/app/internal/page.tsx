"use client";

// Internal-only ops dashboard (its own stratum — not linked from the public nav):
// aggregates the LIVE usage analytics (/v1/analytics/*) and the surface-error
// feed (/v1/telemetry/issues — the "secret faults" users hit across CLI/FE/backend)
// into one view. Admin-key gated; the key is pasted + kept in localStorage only
// (never bundled). Honest: shows raw aggregates, renders the error reason when a
// feed is down — no fabricated "healthy".

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

export default function InternalDashboard() {
  const [apiBase, setApiBase] = useState(DEFAULT_API);
  const [key, setKey] = useState("");
  const [days, setDays] = useState(7);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [issues, setIssues] = useState<IssuesData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    }
  }, [apiBase, key, days]);

  return (
    <main className="mx-auto max-w-5xl p-6 font-mono text-sm">
      <h1 className="text-xl font-bold mb-1">unbrowse · internal ops</h1>
      <p className="text-gray-500 mb-4">usage + the secret faults users hit (CLI / FE / backend)</p>

      <div className="flex flex-wrap gap-2 items-center mb-6">
        <input
          className="border px-2 py-1 rounded w-64" placeholder="admin Bearer key (ubr_…)"
          type="password" value={key} onChange={(e) => setKey(e.target.value)}
        />
        <input
          className="border px-2 py-1 rounded w-64" placeholder="api base" value={apiBase}
          onChange={(e) => setApiBase(e.target.value)}
        />
        <select className="border px-2 py-1 rounded" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>1d</option><option value={7}>7d</option><option value={30}>30d</option>
        </select>
        <button className="bg-black text-white px-3 py-1 rounded" onClick={load} disabled={loading || !key}>
          {loading ? "loading…" : "load"}
        </button>
      </div>

      {err && <div className="bg-red-50 text-red-700 border border-red-200 rounded p-2 mb-4">⚠ {err}</div>}

      {usage && (
        <section className="mb-6">
          <h2 className="font-bold mb-2">usage (30d)</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="sessions" value={usage.total_sessions_30d} />
            <Stat label="unique agents" value={usage.unique_agents_30d} />
            <Stat label="calls / session" value={usage.api_calls_per_session} />
            <Stat label="repeat rate" value={usage.repeat_usage_rate} />
          </div>
          {usage.version_breakdown_30d && usage.version_breakdown_30d.length > 0 && (
            <div className="mt-3 text-xs text-gray-600">
              versions: {usage.version_breakdown_30d.map((v) => `${v.trace_version.slice(0, 12)} (${v.sessions})`).join(" · ")}
            </div>
          )}
        </section>
      )}

      {issues && issues.ok !== false && (
        <section>
          <h2 className="font-bold mb-2">issues — {issues.total ?? 0} in {issues.days ?? days}d</h2>
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <Bars title="by kind" rows={issues.by_kind} />
            <Bars title="by surface" rows={issues.by_surface} />
          </div>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-1 pr-2">when</th><th className="pr-2">surface</th><th className="pr-2">kind</th><th className="pr-2">ver</th><th>message</th>
              </tr>
            </thead>
            <tbody>
              {(issues.recent ?? []).map((e, idx) => (
                <tr key={idx} className="border-b border-gray-100">
                  <td className="py-1 pr-2 whitespace-nowrap text-gray-500">{e.created_at?.slice(5, 16).replace("T", " ")}</td>
                  <td className="pr-2">{e.surface}</td>
                  <td className="pr-2 font-semibold">{e.kind}</td>
                  <td className="pr-2 text-gray-400">{(e.version ?? "").slice(0, 8)}</td>
                  <td className="text-gray-700">{e.message ?? JSON.stringify(e.context ?? {}).slice(0, 80)}</td>
                </tr>
              ))}
              {(!issues.recent || issues.recent.length === 0) && (
                <tr><td colSpan={5} className="py-2 text-gray-400">no issues in window — either healthy or the CLI/FE haven&apos;t emitted yet</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="border rounded p-2">
      <div className="text-2xl font-bold">{value ?? "–"}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function Bars({ title, rows }: { title: string; rows?: { key: string; count: number }[] }) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.count));
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{title}</div>
      {(rows ?? []).slice(0, 8).map((r) => (
        <div key={r.key} className="flex items-center gap-2 mb-0.5">
          <span className="w-32 truncate">{r.key}</span>
          <span className="bg-black/80 h-3 rounded" style={{ width: `${(r.count / max) * 100}%`, minWidth: 4 }} />
          <span className="text-gray-500">{r.count}</span>
        </div>
      ))}
      {(!rows || rows.length === 0) && <div className="text-gray-400 text-xs">none</div>}
    </div>
  );
}
