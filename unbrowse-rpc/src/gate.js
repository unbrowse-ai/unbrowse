// What the gateway checks before it relays anything, kept apart from the Worker so the tests run it under plain node.
//
// A member is a node an owner signed in for with Privy: the link page posts the owner's Privy access token and the node's
// address (`/members`), and the gateway keeps the node under the Privy user the token names. A node then reaches the RPC
// with a pass it signs itself (`pass`), so nothing the gateway or the network sees can be replayed past a day.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

/** The Arc networks the gateway relays to, and the upstream each one goes to (the key is appended from a secret). */
export const NETWORKS = {
  "arc-mainnet": { chainId: 5042, upstream: "https://arc-mainnet.g.alchemy.com/v2/" },
  "arc-testnet": { chainId: 5042002, upstream: "https://arc-testnet.g.alchemy.com/v2/" },
};

/** The methods a node calls (`unbrowse-node/app/src/rpc.rs`, `proof.rs`, `chain/`), and nothing else: no filters,
 *  traces or debug methods, which a node never needs and which cost the most upstream. */
export const METHODS = new Set([
  "eth_chainId", "net_version", "eth_blockNumber", "eth_syncing",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBlockReceipts",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getTransactionCount",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_estimateGas",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getLogs", "eth_sendRawTransaction",
]);

/** The widest `eth_getLogs` a node asks for (`chain::gas::LOG_WINDOW`). */
export const MAX_LOG_SPAN = 10_000n;
/** The most calls one request may batch. */
export const MAX_BATCH = 50;
/** How far ahead a pass may run out: a node signs one a day (`rpc::gateway_pass`). */
export const MAX_PASS_AHEAD_S = 2 * 24 * 3600;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from((s.replace(/^0x/, "").match(/../g) || []).map((b) => parseInt(b, 16)));

/** The EIP-191 message a node signs for its pass: the network and the second it runs out. */
export function passMessage(network, expiry) {
  return `Unbrowse RPC pass\nnetwork: ${network}\nexpires: ${expiry}`;
}

function personalHash(message) {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak_256(all);
}

/** The address that signed `message` (EIP-191) with the 65-byte `signature` (r, s, v), or null. */
export function signerOf(message, signature) {
  const sig = unhex(signature);
  if (sig.length !== 65) return null;
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  if (v !== 0 && v !== 1) return null;
  try {
    const point = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(personalHash(message));
    return "0x" + hex(keccak_256(point.toRawBytes(false).slice(1)).slice(12));
  } catch {
    return null;
  }
}

/** A pass read from the path (`<node>.<expiry>.<signature>`): the node it is for, if its signature is that node's and it
 *  hasn't run out, else why not. */
export function readPass(network, pass, nowS) {
  const [node, expiryText, signature] = (pass || "").split(".");
  if (!/^0x[0-9a-fA-F]{40}$/.test(node || "") || !/^\d{1,12}$/.test(expiryText || "") || !signature) return { why: "a pass is <node>.<expiry>.<signature>" };
  const expiry = Number(expiryText);
  if (expiry <= nowS) return { why: "the pass ran out: the node signs a new one" };
  if (expiry > nowS + MAX_PASS_AHEAD_S) return { why: "the pass runs out too far ahead" };
  const signer = signerOf(passMessage(network, expiry), signature);
  if (!signer || signer !== node.toLowerCase()) return { why: "the pass isn't signed by the node it names" };
  return { node: signer };
}

/** Why a JSON-RPC call isn't relayed, or null when it is: a method a node never calls, or a log range wider than it
 *  asks for. */
export function refusal(call) {
  if (!call || typeof call.method !== "string") return "not a JSON-RPC call";
  if (!METHODS.has(call.method)) return `${call.method} isn't relayed: the gateway serves the methods a node calls`;
  if (call.method === "eth_getLogs") {
    const f = (call.params || [])[0] || {};
    if (f.blockHash) return null;
    const n = (v) => (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : null);
    const from = n(f.fromBlock), to = n(f.toBlock);
    if (from === null || to === null) return "eth_getLogs takes numbered fromBlock and toBlock here";
    if (to < from || to - from + 1n > MAX_LOG_SPAN) return `eth_getLogs spans at most ${MAX_LOG_SPAN} blocks here`;
  }
  return null;
}

// ---- Privy access tokens (ES256 JWTs), checked against the app's published keys ----

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** The Privy user (`sub`, a DID) an access token names, if it is signed by one of `jwks`' keys for `appId`, issued by
 *  Privy and not expired; else why not. `jwks` is `{ keys: [...] }` as Privy serves it. */
export async function privyUser(token, jwks, appId, nowS) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return { why: "not a token" };
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    return { why: "not a token" };
  }
  if (header.alg !== "ES256") return { why: "not a Privy token" };
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || ((jwks.keys || []).length === 1 ? jwks.keys[0] : null);
  if (!jwk) return { why: "signed by a key Privy doesn't publish" };
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return { why: "the token's signature doesn't hold" };
  if (claims.iss !== "privy.io") return { why: "not issued by Privy" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(appId)) return { why: "the token is for another Privy app" };
  if (typeof claims.exp !== "number" || claims.exp <= nowS) return { why: "the token ran out: sign in again" };
  if (typeof claims.sub !== "string" || !claims.sub) return { why: "the token names no user" };
  return { user: claims.sub };
}


/** How long a Worker keeps a node's membership before asking the member list again: a member for minutes, since members
 *  rarely leave; a refusal for seconds, so a node whose owner signs in a moment after it was refused is served at once.
 *  Until 2026-11-18 a refusal was kept as long as a membership (5 minutes), and a node linked right after it started
 *  stayed refused. */
export const MEMBER_TTL_MS = 5 * 60 * 1000;
export const NOT_MEMBER_TTL_MS = 10 * 1000;

/** The cached answer for a node still good at `now`, or undefined when the member list must be asked. */
export function cachedMember(hit, now) {
  if (!hit) return undefined;
  return now - hit.at < (hit.yes ? MEMBER_TTL_MS : NOT_MEMBER_TTL_MS) ? hit.yes : undefined;
}

/** Whether `node` may make `calls` now: the limiter (`limit({ key })`, one unit a use) is charged one unit a call, so a
 *  batch costs what the same calls sent one by one would. */
export async function withinRate(limiter, node, calls) {
  const results = await Promise.all(calls.map(() => limiter.limit({ key: node })));
  return results.every((r) => r.success);
}
