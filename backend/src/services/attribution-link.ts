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

// Cohort funnel — KV-NATIVE counters (point get/put + a tiny variant registry), NOT a
// scan. Each stage increments a fixed per-variant counter at write time, deduped per
// install so the count is distinct-installs (not events). Reading the funnel is O(variants)
// keyed gets — it scales, unlike the listWithValues-and-join scan that timed out on prod.
//   cohort:c:<variant>:<stage>  -> count        (installs|registered|active)
//   cohort:iv:<install_id>      -> variant       (so register/session resolve their variant)
//   cohort:seen:<stage>:<id>    -> "1"           (distinct-count guard; point-access, never scanned)
//   cohort:variants             -> JSON string[] (the small registry the read enumerates)
const COHORT_COUNTER_PREFIX = "cohort:c:";
const COHORT_IV_PREFIX = "cohort:iv:";
const COHORT_SEEN_PREFIX = "cohort:seen:";
const COHORT_VARIANTS_KEY = "cohort:variants";
const UNATTRIBUTED = "(unattributed)";

export type CohortStage = "installs" | "registered" | "active";

export interface CohortRow {
  variant: string;
  installs: number;
  registered: number;
  active: number;
  registration_rate: number;
  activation_rate: number;
}
export interface CohortFunnel {
  totals: { installs: number; registered: number; active: number };
  by_variant: CohortRow[];
}

// A funnel conversion rate is bounded [0,1] by definition. Clamp the upper end:
// `active`/`registered` are deduped against their OWN install_id pings, but many
// activity flows bump "active" under the UNATTRIBUTED variant without ever having
// recorded an "installs" ping for that install_id — so active can exceed installs
// and the raw ratio blows past 1 (the dashboard's "2200%"). Clamping keeps the
// rate honest; the raw installs/registered/active counts still surface the
// attribution gap (active >> installs ⇒ install attribution is under-recorded).
const rate = (n: number, d: number): number => (d > 0 ? Math.min(1, Math.round((n / d) * 1000) / 1000) : 0);

/** At install: remember which variant seeded an install, so register/session can resolve it. */
export async function recordInstallVariant(env: Env, installId: string, variant: string): Promise<void> {
  const i = clean(installId);
  if (!i) return;
  await statsKV(env).put(`${COHORT_IV_PREFIX}${i}`, clean(variant) || UNATTRIBUTED);
}

export async function variantForInstall(env: Env, installId: string): Promise<string | null> {
  const i = clean(installId);
  if (!i) return null;
  return ((await statsKV(env).get(`${COHORT_IV_PREFIX}${i}`)) as string | null) || null;
}

async function registerVariant(env: Env, variant: string): Promise<void> {
  const kv = statsKV(env);
  const raw = (await kv.get(COHORT_VARIANTS_KEY)) as string | null;
  let list: string[];
  try {
    list = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    list = [];
  }
  if (!list.includes(variant)) {
    list.push(variant);
    await kv.put(COHORT_VARIANTS_KEY, JSON.stringify(list.slice(0, 500)));
  }
}

/**
 * Bump a funnel stage for a variant, deduped per install (distinct-install count, not events).
 * Best-effort + idempotent; KV INCR is read-modify-write (not atomic) — fine for analytics,
 * an occasional lost increment is noise, never a correctness/billing path.
 */
export async function bumpCohortStage(env: Env, variant: string, stage: CohortStage, dedupeId: string): Promise<void> {
  const v = clean(variant) || UNATTRIBUTED;
  const d = clean(dedupeId);
  if (!d) return;
  const kv = statsKV(env);
  const seenKey = `${COHORT_SEEN_PREFIX}${stage}:${d}`;
  if (await kv.get(seenKey)) return; // already counted this install at this stage
  await kv.put(seenKey, "1");
  const cKey = `${COHORT_COUNTER_PREFIX}${v}:${stage}`;
  const cur = Number((await kv.get(cKey)) as string | null) || 0;
  await kv.put(cKey, String(cur + 1));
  await registerVariant(env, v);
}

/**
 * The dominion view (break ③) — read the per-variant funnel from the counters. O(variants)
 * point-gets via the small `cohort:variants` registry; no scan, so it serves inline cheaply.
 */
export async function getCohortFunnel(env: Env): Promise<CohortFunnel> {
  const kv = statsKV(env);
  const raw = (await kv.get(COHORT_VARIANTS_KEY)) as string | null;
  let variants: string[];
  try {
    variants = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    variants = [];
  }
  const by_variant: CohortRow[] = [];
  for (const variant of variants) {
    const [i, r, a] = await Promise.all([
      kv.get(`${COHORT_COUNTER_PREFIX}${variant}:installs`),
      kv.get(`${COHORT_COUNTER_PREFIX}${variant}:registered`),
      kv.get(`${COHORT_COUNTER_PREFIX}${variant}:active`),
    ]);
    const installs = Number(i as string | null) || 0;
    const registered = Number(r as string | null) || 0;
    const active = Number(a as string | null) || 0;
    by_variant.push({ variant, installs, registered, active, registration_rate: rate(registered, installs), activation_rate: rate(active, installs) });
  }
  by_variant.sort((x, y) => y.installs - x.installs);
  const totals = by_variant.reduce(
    (acc, r) => ({ installs: acc.installs + r.installs, registered: acc.registered + r.registered, active: acc.active + r.active }),
    { installs: 0, registered: 0, active: 0 },
  );
  return { totals, by_variant };
}
