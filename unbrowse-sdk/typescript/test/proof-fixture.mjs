// The node's answer to `/v1/node/proof`, for the fake nodes: the proof for the token whose key the asker names, as an
// agent's (`agents`) or the owner's (`owner`); nothing for a key it doesn't hold. Not a test file.
import { nodeProof, tokenKey } from "../dist/proof.js";

const unhex = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

/** The answer a node holding `agents` (and the owner token `owner`) gives to `url` on `port`, or undefined when `url`
 * isn't the proof. */
export function proofAnswer(url, port, { agents = [], owner } = {}) {
  const u = new URL(url, "http://x");
  if (u.pathname !== "/v1/node/proof") return undefined;
  const challenge = unhex(u.searchParams.get("challenge") ?? "");
  const key = u.searchParams.get("key");
  const agent = agents.find((t) => tokenKey(t) === key);
  if (agent) return { agents: [nodeProof(agent, port, challenge)] };
  if (owner && tokenKey(owner) === key) return { agents: [], owner: nodeProof(owner, port, challenge) };
  return { agents: [] };
}
