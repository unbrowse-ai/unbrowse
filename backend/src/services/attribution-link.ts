// Attribution-link layer — the thin reverse-index (the firmament) that re-binds the
// funnel's separated waters by install_id, WITHOUT re-pouring the retired session store:
//
//   attrib:token:<token_id> -> install_id   (written at install time)
//   attrib:agent:<agent_id> -> install_id   (written at agent registration)
//
// The keystone join `linkAgentViaToken` closes the break Step-1 found: agent registration
// stores the raw landing_token but never resolved which install it came from.
//
// TRUST INVARIANT (the load-bearing edge): bindings are FIRST-WRITE-WINS. A landing token
// seeds exactly one install; an agent originates from exactly one install. Re-binding either
// to a *different* install would silently mis-attribute revenue (token replay, re-register),
// so we refuse the overwrite. Honest: returns null when the chain can't close — never a
// fabricated link.
import { statsKV } from "./kv.js";
import type { Env } from "../types.js";

const TOKEN_INSTALL_PREFIX = "attrib:token:";
const AGENT_INSTALL_PREFIX = "attrib:agent:";

const clean = (s: string | undefined | null): string => (typeof s === "string" ? s.trim() : "");

/** Which install did this landing token seed? null if unknown. */
export async function resolveInstallForToken(env: Env, tokenId: string): Promise<string | null> {
  const t = clean(tokenId);
  if (!t) return null;
  return ((await statsKV(env).get(`${TOKEN_INSTALL_PREFIX}${t}`)) as string | null) || null;
}

/** Which install did this agent originate from? null if unlinked. */
export async function resolveInstallForAgent(env: Env, agentId: string): Promise<string | null> {
  const a = clean(agentId);
  if (!a) return null;
  return ((await statsKV(env).get(`${AGENT_INSTALL_PREFIX}${a}`)) as string | null) || null;
}

/** At install: bind the landing token id to the install_id. First-write-wins (replay-safe). */
export async function recordTokenInstall(env: Env, tokenId: string, installId: string): Promise<void> {
  const t = clean(tokenId);
  const i = clean(installId);
  if (!t || !i) return;
  if (await resolveInstallForToken(env, t)) return; // a token seeds exactly one install
  await statsKV(env).put(`${TOKEN_INSTALL_PREFIX}${t}`, i);
}

/** At registration: bind the agent to its origin install_id. First-write-wins (origin is fixed). */
export async function recordAgentInstall(env: Env, agentId: string, installId: string): Promise<void> {
  const a = clean(agentId);
  const i = clean(installId);
  if (!a || !i) return;
  if (await resolveInstallForAgent(env, a)) return; // an agent originates from one install
  await statsKV(env).put(`${AGENT_INSTALL_PREFIX}${a}`, i);
}

/**
 * The keystone join. Given a freshly-registered agent and the landing token id it carried,
 * bind agent->install. Idempotent: if the agent is already linked, returns that install
 * unchanged (re-registration is safe). Returns the install_id when the chain closes, else
 * null (no fabricated link).
 */
export async function linkAgentViaToken(env: Env, agentId: string, tokenId: string): Promise<string | null> {
  const a = clean(agentId);
  const t = clean(tokenId);
  if (!a || !t) return null;
  const already = await resolveInstallForAgent(env, a);
  if (already) return already; // idempotent / first-link-wins: an agent's origin is fixed
  const installId = await resolveInstallForToken(env, t);
  if (!installId) return null;
  await recordAgentInstall(env, a, installId);
  return installId;
}

/**
 * The funnel's trust signal (Gen 1:14 — a light to steer by): how many agents/tokens are
 * linked. The coverage RATE needs a total-agents denominator the backend doesn't yet keep
 * (a known gap) — so we surface the observable absolute counts honestly, not a fabricated rate.
 */
export async function getAttributionStats(env: Env): Promise<{ linked_agents: number; linked_tokens: number }> {
  const kv = statsKV(env);
  const [agents, tokens] = await Promise.all([
    kv.listWithValues(AGENT_INSTALL_PREFIX),
    kv.listWithValues(TOKEN_INSTALL_PREFIX),
  ]);
  return { linked_agents: agents.length, linked_tokens: tokens.length };
}

// KV prefixes owned elsewhere (kept as literals to avoid a circular import; the source of
// truth is install-telemetry.ts INSTALL_EVENT_PREFIX + metrics.ts SESSION_PREFIX).
const INSTALL_EVENT_PREFIX = "install-event:";
const SESSION_PREFIX = "analytics:session:";

export interface CohortRow {
  variant: string;
  installs: number;
  registered: number;
  active: number;
  registration_rate: number;
  activation_rate: number;
}
export interface CohortFunnel {
  days: number;
  totals: { installs: number; registered: number; active: number };
  by_variant: CohortRow[];
}

const rate = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);

/**
 * The dominion view (break ③): join installs -> registered agents -> active usage by
 * acquisition cohort (landing variant). Closes the chain the attribution-link layer binds —
 * revenue can now be read per-cohort, not just per-agent. Pure listWithValues join.
 */
export async function getCohortFunnel(env: Env, days: number): Promise<CohortFunnel> {
  const clampedDays = Math.max(1, Math.min(365, Math.trunc(Number.isFinite(days) ? days : 30)));
  const cutoffMs = Date.now() - clampedDays * 86_400_000;
  const kv = statsKV(env);
  const [installEntries, agentEntries, sessionEntries] = await Promise.all([
    kv.listWithValues(INSTALL_EVENT_PREFIX),
    kv.listWithValues(AGENT_INSTALL_PREFIX),
    kv.listWithValues(SESSION_PREFIX),
  ]);

  // install_id -> variant (windowed by install created_at)
  const installVariant = new Map<string, string>();
  const variantInstalls = new Map<string, Set<string>>();
  for (const e of installEntries) {
    try {
      const ev = JSON.parse(e.value) as { install_id?: string; landing_variant_id?: string; created_at?: string };
      if (!ev.install_id) continue;
      if (ev.created_at && Date.parse(ev.created_at) < cutoffMs) continue;
      const v = ev.landing_variant_id || "(unattributed)";
      installVariant.set(ev.install_id, v);
      (variantInstalls.get(v) ?? variantInstalls.set(v, new Set()).get(v)!).add(ev.install_id);
    } catch {
      /* skip */
    }
  }

  // registered: attrib:agent value is the install_id
  const variantRegistered = new Map<string, Set<string>>();
  for (const a of agentEntries) {
    const installId = (a.value || "").trim();
    const v = installVariant.get(installId);
    if (!v) continue;
    (variantRegistered.get(v) ?? variantRegistered.set(v, new Set()).get(v)!).add(installId);
  }

  // active: sessions carrying install_id
  const variantActive = new Map<string, Set<string>>();
  for (const s of sessionEntries) {
    try {
      const ss = JSON.parse(s.value) as { install_id?: string };
      const v = ss.install_id ? installVariant.get(ss.install_id) : undefined;
      if (!v || !ss.install_id) continue;
      (variantActive.get(v) ?? variantActive.set(v, new Set()).get(v)!).add(ss.install_id);
    } catch {
      /* skip */
    }
  }

  const by_variant: CohortRow[] = Array.from(variantInstalls.entries())
    .map(([variant, set]) => {
      const installs = set.size;
      const registered = variantRegistered.get(variant)?.size ?? 0;
      const active = variantActive.get(variant)?.size ?? 0;
      return { variant, installs, registered, active, registration_rate: rate(registered, installs), activation_rate: rate(active, installs) };
    })
    .sort((a, b) => b.installs - a.installs);

  const totals = by_variant.reduce(
    (acc, r) => ({ installs: acc.installs + r.installs, registered: acc.registered + r.registered, active: acc.active + r.active }),
    { installs: 0, registered: 0, active: 0 },
  );
  return { days: clampedDays, totals, by_variant };
}
