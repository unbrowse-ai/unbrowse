/**
 * domain-stats — per-domain observability across the three lifecycle verbs:
 *
 *   indexed  — the domain has live skills/endpoints in the marketplace index
 *   queried  — agents asked for the domain (resolve/domain search), hit or miss
 *   used     — executions ran against the domain's endpoints
 *
 * PRIVACY (MECHANICAL): everything here is aggregated BY DOMAIN. No agent id,
 * wallet, intent text, or any other caller-identifying value is ever written
 * to the query counters or served from the stats surface — a reader learns
 * "domain X was queried N times", never WHO queried it or WHAT they asked.
 * Misses are first-class: a domain agents keep asking for that is NOT indexed
 * is exactly the demand signal worth monitoring.
 */
import type { Env } from "../types.js";
import { skillsKV, statsKV } from "./kv.js";

/** Aggregate query counters for one domain (statsKV `qdom:<domain>`). */
interface DomainQueryCounters {
  queries: number;
  misses: number;
  last_queried_at: string;
}

/** One row of the merged per-domain stats surface. */
export interface DomainStatsRow {
  domain: string;
  indexed: boolean;
  skills: number;
  endpoints: number;
  executions: number;
  successful_executions: number;
  queries: number;
  misses: number;
  last_queried_at: string | null;
}

export interface DomainStatsSummary {
  totals: {
    domains: number;
    domains_indexed: number;
    domains_queried: number;
    domains_used: number;
    /** Demand gap: domains agents queried that have nothing indexed. */
    domains_queried_not_indexed: number;
    queries: number;
    query_misses: number;
    executions: number;
  };
  domains: DomainStatsRow[];
}

const QDOM_PREFIX = "qdom:";
/** Keep query counters bounded: idle domains age out after 90 days. */
const QDOM_TTL_SECONDS = 90 * 86400;

function normalizeDomain(domain: string): string | null {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!d || d.length > 253 || !/^[a-z0-9.-]+$/.test(d)) return null;
  return d;
}

/**
 * Record one query for a domain (resolve / domain-search), off the hot path.
 * `hit` = the query returned at least one result. Aggregate-only by design:
 * the caller's identity/intent MUST NOT be passed in — the signature cannot
 * carry it, which is the point.
 */
export async function recordDomainQuery(env: Env, domain: string, hit: boolean): Promise<void> {
  const d = normalizeDomain(domain);
  if (!d) return;
  try {
    const kv = statsKV(env);
    const key = `${QDOM_PREFIX}${d}`;
    let counters: DomainQueryCounters = { queries: 0, misses: 0, last_queried_at: "" };
    try {
      const prev = (await kv.get(key, "json")) as DomainQueryCounters | null;
      if (prev && typeof prev.queries === "number") counters = prev;
    } catch {}
    counters.queries += 1;
    if (!hit) counters.misses += 1;
    counters.last_queried_at = new Date().toISOString();
    await kv.put(key, JSON.stringify(counters), { expirationTtl: QDOM_TTL_SECONDS });
  } catch {
    // stats are best-effort telemetry; never fail the query they observe
  }
}

/**
 * The merged per-domain view: every domain that is indexed, used, or queried
 * for appears exactly once, with its counters from all three sources.
 */
export async function getDomainStats(env: Env): Promise<DomainStatsSummary> {
  const [skillEntries, qdomEntries, execEntries] = await Promise.all([
    skillsKV(env).listWithValues("skill:"),
    statsKV(env).listWithValues(QDOM_PREFIX),
    statsKV(env).listWithValues("stats:"),
  ]);
  const statEntries = [...qdomEntries, ...execEntries];

  const rows = new Map<string, DomainStatsRow>();
  const row = (domain: string): DomainStatsRow => {
    let r = rows.get(domain);
    if (!r) {
      r = {
        domain,
        indexed: false,
        skills: 0,
        endpoints: 0,
        executions: 0,
        successful_executions: 0,
        queries: 0,
        misses: 0,
        last_queried_at: null,
      };
      rows.set(domain, r);
    }
    return r;
  };

  // indexed — live skills per domain, plus the skill_id → domain join for executions
  const skillDomain = new Map<string, string>();
  for (const { value } of skillEntries) {
    try {
      const s = JSON.parse(value) as {
        skill_id?: string;
        domain?: string;
        lifecycle?: string;
        endpoints?: unknown[];
      };
      if (!s.domain || s.lifecycle === "deprecated" || s.lifecycle === "disabled") continue;
      const d = normalizeDomain(s.domain);
      if (!d) continue;
      const r = row(d);
      r.indexed = true;
      r.skills += 1;
      r.endpoints += s.endpoints?.length ?? 0;
      if (s.skill_id) skillDomain.set(s.skill_id, d);
    } catch {}
  }

  // used + queried — one statsKV pass covers both key families
  for (const { key, value } of statEntries) {
    try {
      if (key.startsWith(QDOM_PREFIX)) {
        const q = JSON.parse(value) as DomainQueryCounters;
        const r = row(key.slice(QDOM_PREFIX.length));
        r.queries += q.queries ?? 0;
        r.misses += q.misses ?? 0;
        if (q.last_queried_at && (!r.last_queried_at || q.last_queried_at > r.last_queried_at)) {
          r.last_queried_at = q.last_queried_at;
        }
      } else if (key.startsWith("stats:")) {
        // stats:<skill_id>--<endpoint_id> (scoring.ts statsKey) → executions,
        // joined to the skill's domain
        const skillId = key.slice("stats:".length).split("--")[0];
        const d = skillId ? skillDomain.get(skillId) : undefined;
        if (!d) continue;
        const s = JSON.parse(value) as { total_executions?: number; successful_executions?: number };
        const r = row(d);
        r.executions += s.total_executions ?? 0;
        r.successful_executions += s.successful_executions ?? 0;
      }
    } catch {}
  }

  const domains = [...rows.values()].sort(
    (a, b) => b.queries + b.executions - (a.queries + a.executions) || a.domain.localeCompare(b.domain),
  );

  return {
    totals: {
      domains: domains.length,
      domains_indexed: domains.filter((d) => d.indexed).length,
      domains_queried: domains.filter((d) => d.queries > 0).length,
      domains_used: domains.filter((d) => d.executions > 0).length,
      domains_queried_not_indexed: domains.filter((d) => d.queries > 0 && !d.indexed).length,
      queries: domains.reduce((n, d) => n + d.queries, 0),
      query_misses: domains.reduce((n, d) => n + d.misses, 0),
      executions: domains.reduce((n, d) => n + d.executions, 0),
    },
    domains,
  };
}
