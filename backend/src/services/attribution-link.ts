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
