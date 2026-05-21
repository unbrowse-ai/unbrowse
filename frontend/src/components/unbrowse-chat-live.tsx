"use client";

/**
 * Live, anonymous chat widget that demonstrates the Unbrowse resolve loop
 * against the public marketplace at beta-api.unbrowse.ai via POST /v1/search.
 *
 * Architecture decisions (live, not assumed):
 *  - Backend CORS is `origin: "*"` (see backend/src/index.ts), so the
 *    browser can call the worker directly. No proxy required.
 *  - POST /v1/search uses optionalAuth and admits anonymous callers
 *    (public website discovery path). POST /v1/search/domain is
 *    bearerAuth-gated, so this widget intentionally avoids it.
 *  - We pass `intent` to searchSkills() and filter the returned
 *    shortlist client-side by the user-supplied URL's domain so the
 *    "intent + URL" pairing the visitor entered is honored without
 *    needing an auth gate.
 *  - No keys, no payments, no wallet. The whole point is anonymous
 *    trial. The marketplace is currently sparse: when results come
 *    back empty we surface an honest "no match yet" state with a
 *    concrete next step (npx unbrowse setup).
 */

import { useId, useMemo, useState } from "react";
import { searchSkills, type SearchResult } from "@/lib/api";

const O = "#FF7A20";
const O_DIM = "rgba(255,122,32,0.40)";
const O_HI = "#FFB060";
const G = "#4ADE80";

type Status = "idle" | "loading" | "ok" | "empty" | "error";

interface ShortlistRow {
  id: number;
  score: number;
  name: string;
  domain: string;
  description: string;
  skillId: string;
}

function hostnameOf(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return trimmed.toLowerCase().split("/")[0]?.replace(/:\d+$/, "").replace(/^www\./, "") ?? "";
  }
}

function rowFrom(result: SearchResult): ShortlistRow {
  const meta = result.metadata ?? {};
  const name = String(meta.name ?? meta.intent_signature ?? "(unnamed skill)");
  const domain = String(meta.domain ?? meta.source_url ?? "");
  const description = String(meta.description ?? "");
  const skillId = String(meta.skill_id ?? "");
  return {
    id: result.id,
    score: result.score,
    name,
    domain: hostnameOf(domain),
    description,
    skillId,
  };
}

function filterByHost(rows: ShortlistRow[], host: string): ShortlistRow[] {
  if (!host) return rows;
  return rows.filter((r) => r.domain === host || r.domain.endsWith(`.${host}`) || host.endsWith(`.${r.domain}`));
}

export function UnbrowseChatLive() {
  const intentId = useId();
  const urlId = useId();
  const [intent, setIntent] = useState("");
  const [contextUrl, setContextUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ShortlistRow[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [searchedHost, setSearchedHost] = useState<string>("");

  const requestedHost = useMemo(() => hostnameOf(contextUrl), [contextUrl]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedIntent = intent.trim();
    if (!trimmedIntent) {
      setError("Tell us what you want to do.");
      setStatus("error");
      return;
    }
    setError(null);
    setStatus("loading");
    setRows([]);
    setLatencyMs(null);
    const host = requestedHost;
    setSearchedHost(host);

    const started = performance.now();
    try {
      const results = await searchSkills(trimmedIntent);
      const elapsed = Math.round(performance.now() - started);
      setLatencyMs(elapsed);
      const all = results.map(rowFrom);
      const filtered = filterByHost(all, host);
      const final = host ? filtered : all.slice(0, 6);
      setRows(final);
      setStatus(final.length === 0 ? "empty" : "ok");
    } catch (err) {
      setError((err as Error).message || "Request failed.");
      setStatus("error");
    }
  }

  return (
    <div
      className="relative w-full mx-auto rounded-md overflow-hidden"
      style={{
        background: "rgba(6,4,2,0.85)",
        border: `1px solid ${O_DIM}`,
        boxShadow: "0 0 0 1px rgba(255,122,32,0.08), 0 10px 60px -20px rgba(255,122,32,0.25)",
      }}
    >
      <div
        className="px-4 sm:px-5 py-2.5 flex items-center justify-between"
        style={{ borderBottom: `1px solid ${O_DIM}`, background: "rgba(255,122,32,0.04)" }}
      >
        <span className="text-[11px] font-mono uppercase tracking-[0.2em]" style={{ color: O }}>
          $ unbrowse resolve
        </span>
        <span className="text-[10px] font-mono" style={{ color: O_DIM }}>
          beta-api.unbrowse.ai/v1/search
        </span>
      </div>

      <form onSubmit={onSubmit} className="px-4 sm:px-5 py-4 sm:py-5 grid gap-3">
        <div className="grid sm:grid-cols-[1fr_280px] gap-3">
          <div className="grid gap-1.5">
            <label htmlFor={intentId} className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: O_DIM }}>
              what do you want?
            </label>
            <input
              id={intentId}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="search hacker news for AI"
              className="px-3 py-2 text-sm font-mono rounded-sm focus:outline-none"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: `1px solid ${O_DIM}`,
                color: O_HI,
                caretColor: O,
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={urlId} className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: O_DIM }}>
              on which site (optional)
            </label>
            <input
              id={urlId}
              value={contextUrl}
              onChange={(e) => setContextUrl(e.target.value)}
              placeholder="news.ycombinator.com"
              className="px-3 py-2 text-sm font-mono rounded-sm focus:outline-none"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: `1px solid ${O_DIM}`,
                color: O_HI,
                caretColor: O,
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={status === "loading"}
            className="px-4 py-2 text-xs font-mono uppercase tracking-[0.18em] rounded-sm transition-opacity disabled:opacity-50"
            style={{
              background: O,
              color: "#0c0500",
              border: `1px solid ${O}`,
              boxShadow: "0 0 12px rgba(255,122,32,0.35)",
            }}
          >
            {status === "loading" ? "resolving..." : "resolve"}
          </button>
          {latencyMs != null && status === "ok" && (
            <span className="text-[11px] font-mono" style={{ color: G }}>
              {`ok ${rows.length} match${rows.length === 1 ? "" : "es"} in ${latencyMs}ms`}
            </span>
          )}
          {status === "empty" && (
            <span className="text-[11px] font-mono" style={{ color: O_DIM }}>
              no match yet{searchedHost ? ` for ${searchedHost}` : ""}
            </span>
          )}
        </div>
      </form>

      <div className="px-4 sm:px-5 pb-5">
        {status === "idle" && <IdleHint />}
        {status === "loading" && <LoadingHint />}
        {status === "error" && error && <ErrorHint message={error} />}
        {status === "empty" && <EmptyHint host={searchedHost} />}
        {status === "ok" && <ShortlistPanel rows={rows} />}
      </div>
    </div>
  );
}

function IdleHint() {
  return (
    <div
      className="text-[11px] font-mono leading-relaxed px-3 py-2.5 rounded-sm"
      style={{ background: "rgba(255,122,32,0.04)", border: `1px solid ${O_DIM}`, color: O_DIM }}
    >
      Type an intent and a site, then hit resolve. We will call the public marketplace at
      <span style={{ color: O_HI }}> POST /v1/search</span> and rank skills against your intent.
    </div>
  );
}

function LoadingHint() {
  return (
    <div className="text-[11px] font-mono" style={{ color: O_DIM }}>
      <span style={{ color: O }}>$</span> querying marketplace<span className="animate-pulse">...</span>
    </div>
  );
}

function ErrorHint({ message }: { message: string }) {
  return (
    <div
      className="text-[11px] font-mono leading-relaxed px-3 py-2.5 rounded-sm"
      style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.35)", color: "#fca5a5" }}
    >
      <span style={{ color: "#f87171" }}>error:</span> {message}
    </div>
  );
}

function EmptyHint({ host }: { host: string }) {
  return (
    <div
      className="text-[11px] font-mono leading-relaxed px-3 py-2.5 rounded-sm grid gap-2"
      style={{ background: "rgba(255,122,32,0.04)", border: `1px solid ${O_DIM}`, color: O_DIM }}
    >
      <p>
        <span style={{ color: O_HI }}>no marketplace skill</span> matches that intent{host ? <> on <span style={{ color: O_HI }}>{host}</span></> : null} yet.
      </p>
      <p>
        That is the whole point of Unbrowse: install locally, browse once, the route gets indexed, every agent on the network can call it next time.
      </p>
      <code className="text-[11px] block px-2 py-1.5 rounded-sm" style={{ background: "#0a0a0a", color: O, border: `1px solid ${O_DIM}` }}>
        $ npx @unbrowse/sdk@latest
      </code>
    </div>
  );
}

function ShortlistPanel({ rows }: { rows: ShortlistRow[] }) {
  return (
    <ol className="grid gap-2">
      {rows.map((row, idx) => (
        <li
          key={`${row.id}-${row.skillId || idx}`}
          className="px-3 py-2.5 rounded-sm grid gap-1"
          style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${O_DIM}` }}
        >
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[10px] font-mono" style={{ color: O_DIM }}>{`#${idx + 1}`}</span>
            <span className="text-sm font-mono font-medium" style={{ color: O_HI }}>{row.name}</span>
            {row.domain && (
              <span className="text-[11px] font-mono" style={{ color: O }}>{row.domain}</span>
            )}
            <span className="ml-auto text-[10px] font-mono" style={{ color: G }}>
              {`score ${row.score.toFixed(3)}`}
            </span>
          </div>
          {row.description && (
            <p className="text-[12px] leading-relaxed" style={{ color: "rgba(255,176,96,0.7)" }}>
              {row.description}
            </p>
          )}
          {row.skillId && (
            <p className="text-[10px] font-mono" style={{ color: O_DIM }}>
              {`skill_id ${row.skillId}`}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
