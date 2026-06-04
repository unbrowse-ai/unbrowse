"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { PopularSkillSummary, StatsPerf } from "@/lib/api";

const EXAMPLES = ["top stories on hacker news", "questions on stackoverflow", "search beatsaver maps"];
const nf = new Intl.NumberFormat("en-US");

/** Tokenize an intent / skill record into lowercased word stems for overlap scoring. */
function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 1) ?? [];
}

/** Rank the REAL popular-skill records against the typed intent by token overlap.
 *  The web search vector index returns opaque ids with no public metadata, so the
 *  honest "show real data" path is to rank the genuine indexed routes the registry
 *  already exposes. Score = matched-token coverage, biased toward real usage. */
function rank(intent: string, pool: PopularSkillSummary[]): { skill: PopularSkillSummary; matched: number } | null {
  const qt = tokens(intent);
  if (qt.length === 0) return null;
  let best: { skill: PopularSkillSummary; matched: number; score: number } | null = null;
  for (const skill of pool) {
    const hay = new Set(tokens(`${skill.name} ${skill.domain} ${skill.description}`));
    let matched = 0;
    for (const t of qt) if (hay.has(t)) matched += 1;
    if (matched === 0) continue;
    // Coverage of the query, then break ties by real execution volume.
    const score = matched / qt.length + Math.min(skill.total_executions, 1000) / 1e6;
    if (!best || score > best.score) best = { skill, matched, score };
  }
  return best ? { skill: best.skill, matched: best.matched } : null;
}

type Resolved = { skill: PopularSkillSummary; matched: number; intent: string };

/** Hero — a live resolve, not a paragraph. Type an intent, hit enter, and see a
 *  REAL ranked indexed route come back (real domain, real route count, real call
 *  volume) with a speed badge built from the registry's REAL measured deltas. No
 *  signup wall before the first result. */
export function RegistrySearch({
  pool = [],
  perf,
}: {
  pool?: PopularSkillSummary[];
  perf?: StatsPerf | null;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [miss, setMiss] = useState<string | null>(null);

  // Real speed delta from /v1/stats/summary perf: indexed route (1 call) vs a
  // cold browser session. Only shown when both real numbers are present.
  const speedup = useMemo(() => {
    if (!perf?.avg_resolve_ms || !perf?.avg_marketplace_ms) return null;
    const x = perf.avg_resolve_ms / perf.avg_marketplace_ms;
    return x >= 2 ? Math.round(x) : null;
  }, [perf]);

  function resolve(intent: string) {
    const v = intent.trim();
    if (!v) return;
    setQ(v);
    setMiss(null);
    setResolved(null);
    setResolving(true);
    // The pool is the real indexed registry already loaded on the page; ranking is
    // instant. The short delay makes the "resolving" status visible (Nielsen) without
    // faking latency — it mirrors a real sub-second marketplace hit.
    window.setTimeout(() => {
      const hit = pool.length > 0 ? rank(v, pool) : null;
      if (hit) setResolved({ ...hit, intent: v });
      else setMiss(v);
      setResolving(false);
    }, 220);
  }

  const quality = resolved ? Math.round((resolved.skill.avg_reliability_score || 0) * 100) : 0;
  const favicon = resolved
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(resolved.skill.domain)}&sz=64`
    : "";

  return (
    <div className="w-full max-w-2xl mx-auto">
      <form
        onSubmit={(e) => { e.preventDefault(); resolve(q); }}
        className="flex items-center gap-2 rounded-2xl px-4 py-3"
        style={{ background: "var(--surface-raised)", border: "1px solid var(--border-strong, rgba(255,82,0,0.32))", boxShadow: "0 8px 40px -20px var(--glow, rgba(255,82,0,0.45))" }}
      >
        <span aria-hidden style={{ color: "var(--text-muted)" }}>⌕</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type an intent — “top stories on hacker news”"
          aria-label="Resolve an intent to an indexed route"
          className="flex-1 bg-transparent focus:outline-none text-[15px]"
          style={{ color: "var(--text-primary)", caretColor: "var(--orange-500)" }}
        />
        <button type="submit" disabled={resolving} className="px-4 py-1.5 rounded-xl text-[13px] font-medium disabled:opacity-60" style={{ background: "var(--orange-500, #FF5200)", color: "#0c0500" }}>
          {resolving ? "Resolving…" : "Resolve"}
        </button>
      </form>

      {/* Live status / result — the show, not the tell. */}
      {resolving && (
        <div className="mt-3 flex items-center justify-center gap-2 text-[13px] text-text-muted" aria-live="polite">
          <span className="inline-block h-3 w-3 rounded-full border-2 animate-spin" style={{ borderColor: "var(--orange-500)", borderTopColor: "transparent" }} />
          Resolving “{q}” against the indexed registry…
        </div>
      )}

      {resolved && !resolving && (
        <div className="mt-3 text-left" aria-live="polite">
          <Link
            href={`/skill/${encodeURIComponent(resolved.skill.skill_id)}`}
            className="group block rounded-2xl border p-5 transition-colors"
            style={{ background: "var(--surface-raised)", borderColor: "var(--border-strong, rgba(255,82,0,0.32))" }}
          >
            <div className="mb-2 flex items-center gap-2 text-[11px]">
              <span className="px-2 py-0.5 rounded-full font-mono" style={{ color: "var(--orange-400, #FF6A00)", border: "1px solid var(--border)" }}>
                resolved in 1 call{speedup ? ` · ~${speedup}× faster than a browser session` : ""}
              </span>
              {!speedup && (
                <span className="text-text-muted">{resolved.skill.endpoint_count} indexed routes</span>
              )}
            </div>
            <div className="flex items-start gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={favicon} alt="" width={36} height={36} className="rounded-lg shrink-0" style={{ background: "var(--surface-sunken)" }} />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[15px] font-semibold text-text-primary">{resolved.skill.name}</h3>
                <p className="truncate text-[12px] font-mono text-text-muted">{resolved.skill.domain}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-border pt-3 text-[11px] font-mono text-text-muted">
              <span title="Real total calls run through this route">▸ {nf.format(resolved.skill.total_executions || 0)} real calls</span>
              <span title="Reliability score">★ {quality}</span>
              <span title="Indexed routes on this domain">⛓ {nf.format(resolved.skill.endpoint_count || 0)} routes</span>
              {resolved.skill.last_execution_at && (
                <span title="Last real execution">last run {new Date(resolved.skill.last_execution_at).toLocaleDateString()}</span>
              )}
            </div>
            <p className="mt-3 text-[13px] text-text-secondary group-hover:text-text-primary transition-colors">
              Open this route → execute it for real data, or wire it into your agent.
            </p>
          </Link>
        </div>
      )}

      {miss && !resolving && (
        <div className="mt-3 rounded-2xl border border-border bg-surface-raised p-5 text-center text-[13px] text-text-muted">
          No indexed route for “{miss}” yet — <Link href={`/search?q=${encodeURIComponent(miss)}`} className="underline">search the full registry</Link> or <Link href="/aiko" className="underline">ask Aiko</Link> to capture it live.
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2 justify-center">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" onClick={() => resolve(e)} className="px-3 py-1.5 rounded-full text-[12px]" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
            {e}
          </button>
        ))}
        <a href="/aiko" className="px-3 py-1.5 rounded-full text-[12px]" style={{ border: "1px solid var(--border)", color: "var(--orange-400, #FF6A00)" }}>
          ✦ or ask Aiko →
        </a>
      </div>
    </div>
  );
}
