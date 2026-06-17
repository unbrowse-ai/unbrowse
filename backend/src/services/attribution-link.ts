// Attribution-link layer — the thin reverse-index (the firmament) that re-binds the
// funnel's separated waters by install_id, WITHOUT re-pouring the retired session store:
//
//   attrib:token:<token_id> -> install_id   (written at install time)
//   attrib:agent:<agent_id> -> install_id   (written at agent registration)
//
// The keystone join `linkAgentViaToken` closes the break Step-1 found: agent registration
// stores the raw landing_token but never resolved which install it came from. Resolving
// token->install (written at install) lets us bind agent->install, so usage + revenue can
// later be re-attributed to the acquisition cohort. Honest: returns null when the chain
// does not close — never fabricates a link.
import { statsKV } from "./kv.js";
import type { Env } from "../types.js";

const TOKEN_INSTALL_PREFIX = "attrib:token:";
const AGENT_INSTALL_PREFIX = "attrib:agent:";

/** At install: bind the landing token id to the install_id. */
export async function recordTokenInstall(env: Env, tokenId: string, installId: string): Promise<void> {
  if (!tokenId || !installId) return;
  await statsKV(env).put(`${TOKEN_INSTALL_PREFIX}${tokenId}`, installId);
}

/** At registration: bind the agent to its origin install_id. */
export async function recordAgentInstall(env: Env, agentId: string, installId: string): Promise<void> {
  if (!agentId || !installId) return;
  await statsKV(env).put(`${AGENT_INSTALL_PREFIX}${agentId}`, installId);
}

/** Which install did this landing token seed? null if unknown. */
export async function resolveInstallForToken(env: Env, tokenId: string): Promise<string | null> {
  if (!tokenId) return null;
  return ((await statsKV(env).get(`${TOKEN_INSTALL_PREFIX}${tokenId}`)) as string | null) || null;
}

/** Which install did this agent originate from? null if unlinked. */
export async function resolveInstallForAgent(env: Env, agentId: string): Promise<string | null> {
  if (!agentId) return null;
  return ((await statsKV(env).get(`${AGENT_INSTALL_PREFIX}${agentId}`)) as string | null) || null;
}

/**
 * The keystone join. Given a freshly-registered agent and the landing token id it carried,
 * resolve the install the token seeded (recorded at install) and bind agent->install.
 * Returns the install_id when the chain closes, else null (no fabricated link).
 */
export async function linkAgentViaToken(env: Env, agentId: string, tokenId: string): Promise<string | null> {
  if (!agentId || !tokenId) return null;
  const installId = await resolveInstallForToken(env, tokenId);
  if (!installId) return null;
  await recordAgentInstall(env, agentId, installId);
  return installId;
}
