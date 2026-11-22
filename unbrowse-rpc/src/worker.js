// rpc.unbrowse.ai: Arc's JSON-RPC for the nodes of Privy-registered owners, relayed to the provider Unbrowse pays for.
//
//   POST /members                  the link page, with the owner's Privy access token and the node's address: the node
//                                  becomes a member under that Privy user (at most MAX_NODES_PER_USER of them)
//   POST /<network>/<pass>         a member node's JSON-RPC, one call or a batch; <pass> is <node>.<expiry>.<signature>,
//                                  signed by the node's own key (gate.js `passMessage`)
//
// A member node's gas is Unbrowse's: the first time it reads a network here holding less than drip.js LOW_WEI there, it
// is sent DRIP_WEI from the gas wallet (GAS_KEY), once a node a network, within a daily budget (drip.js).
//
// The provider's key is a secret (ALCHEMY_KEY), never in a URL a node sees. Nothing a request carries is logged.

import { DurableObject } from "cloudflare:workers";
import { NETWORKS, MAX_BATCH, privyUser, readPass, refusal, cachedMember, withinRate } from "./gate.js";
import { day, dripCost, feeCap, send, withheld } from "./drip.js";

/** How many nodes one Privy user may have as members. */
const MAX_NODES_PER_USER = 10;
/** How long a Worker keeps Privy's published keys before reading them again (a membership: gate.js `cachedMember`). */
const JWKS_TTL_MS = 10 * 60 * 1000;

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const rpcError = (id, code, message, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

/** The members: each node's address and the Privy user who signed it in. */
export class Members extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS members (node TEXT PRIMARY KEY, user TEXT NOT NULL, at INTEGER NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS members_user ON members (user)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS drips (node TEXT NOT NULL, network TEXT NOT NULL, tx TEXT, wei TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY (node, network))");
  }

  /** Gasses `node` on `network` when it is due (drip.js `withheld`): one send at a time, so the gas wallet's nonces never
   *  race, and recorded before it goes out, so a node is never sent two. What was done, or why not. */
  async gas(node, network, chainId, upstream) {
    if (!this.env.GAS_KEY) return { why: "no gas wallet" };
    return this.ctx.blockConcurrencyWhile(async () => {
      const today = day(Date.now());
      const sentBefore = this.sql.exec("SELECT 1 FROM drips WHERE node = ? AND network = ?", node, network).toArray().length > 0;
      const spentToday = this.sql
        .exec("SELECT wei FROM drips WHERE network = ? AND day = ?", network, today)
        .toArray()
        .reduce((sum, r) => sum + BigInt(r.wei), 0n);
      const rpc = async (method, params) => {
        const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const body = await r.json();
        if (body.error) throw new Error(`${method}: ${body.error.message}`);
        return body.result;
      };
      const balance = sentBefore ? 0n : BigInt(await rpc("eth_getBalance", [node, "latest"]));
      const fee = await feeCap(rpc);
      const cost = dripCost(fee);
      const why = withheld({ sentBefore, spentToday, balance, cost });
      if (why) return { why };
      this.sql.exec("INSERT INTO drips (node, network, tx, wei, day) VALUES (?, ?, NULL, ?, ?)", node, network, cost.toString(), today);
      try {
        const tx = await send(rpc, this.env.GAS_KEY, chainId, node, DRIP_WEI, fee);
        this.sql.exec("UPDATE drips SET tx = ? WHERE node = ? AND network = ?", tx, node, network);
        return { tx };
      } catch (e) {
        // Nothing went out: the node may be gassed on a later read.
        this.sql.exec("DELETE FROM drips WHERE node = ? AND network = ? AND tx IS NULL", node, network);
        return { why: String(e.message || e) };
      }
    });
  }

  /** Whether `node` is a member. */
  async has(node) {
    return this.sql.exec("SELECT 1 FROM members WHERE node = ?", node).toArray().length > 0;
  }

  /** Makes `node` a member under `user`, unless that user has the most nodes already. A node signed in again by
   *  another user moves to them. */
  async join(node, user, at) {
    const mine = this.sql.exec("SELECT node FROM members WHERE user = ?", user).toArray().map((r) => r.node);
    if (!mine.includes(node) && mine.length >= MAX_NODES_PER_USER) return { ok: false, why: `a Privy account has at most ${MAX_NODES_PER_USER} nodes` };
    this.sql.exec("INSERT INTO members (node, user, at) VALUES (?, ?, ?) ON CONFLICT(node) DO UPDATE SET user = excluded.user, at = excluded.at", node, user, at);
    return { ok: true };
  }
}

let jwksCache = { at: 0, keys: null };
/** The nodes this Worker has asked the member list to gas, a network each: the list itself decides (once a node). */
const gassed = new Set();
const memberCache = new Map();

async function jwks(env) {
  if (jwksCache.keys && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const r = await fetch(`https://auth.privy.io/api/v1/apps/${env.PRIVY_APP_ID}/jwks.json`);
  if (!r.ok) throw new Error(`Privy's keys: HTTP ${r.status}`);
  jwksCache = { at: Date.now(), keys: await r.json() };
  return jwksCache.keys;
}

const members = (env) => env.MEMBERS.get(env.MEMBERS.idFromName("members"));

async function isMember(env, node) {
  const known = cachedMember(memberCache.get(node), Date.now());
  if (known !== undefined) return known;
  const yes = await members(env).has(node);
  memberCache.set(node, { at: Date.now(), yes });
  return yes;
}

function cors(env, request) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.SITE_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin)
    ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type, authorization", vary: "origin" }
    : {};
}

async function join(request, env) {
  const headers = cors(env, request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ error: "POST" }, 405, headers);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "a JSON body with the node's address" }, 400, headers);
  }
  const node = String(body.node || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(node)) return json({ error: "a node address" }, 400, headers);
  const who = await privyUser(token, await jwks(env), env.PRIVY_APP_ID, Math.floor(Date.now() / 1000));
  if (!who.user) return json({ error: who.why }, 401, headers);
  const done = await members(env).join(node, who.user, Math.floor(Date.now() / 1000));
  if (!done.ok) return json({ error: done.why }, 403, headers);
  memberCache.set(node, { at: Date.now(), yes: true });
  return json({ member: node }, 200, headers);
}

async function relay(request, env, ctx, network, pass) {
  const net = NETWORKS[network];
  if (!net) return rpcError(null, -32601, `no network ${network}: arc-mainnet or arc-testnet`, 404);
  if (request.method !== "POST") return rpcError(null, -32600, "JSON-RPC is POSTed", 405);
  const p = readPass(network, pass, Math.floor(Date.now() / 1000));
  if (!p.node) return rpcError(null, -32001, `not a member's pass: ${p.why}`, 401);
  if (!(await isMember(env, p.node))) return rpcError(null, -32001, "this node isn't a member: its owner signs in with Privy on unbrowse.ai first", 403);
  // Its gas, once a network, beside the call rather than before it: the call never waits on a send.
  if (env.GAS_KEY && !gassed.has(`${p.node}/${network}`)) {
    gassed.add(`${p.node}/${network}`);
    ctx.waitUntil(members(env).gas(p.node, network, net.chainId, net.upstream + env.ALCHEMY_KEY).catch(() => gassed.delete(`${p.node}/${network}`)));
  }
  // One unit before the body is read, so a request that never parses still costs one; the batch's other calls after.
  if (env.PER_NODE && !(await withinRate(env.PER_NODE, p.node, [null]))) return rpcError(null, -32005, "rate limit exceeded", 429);
  let body;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "parse error", 400);
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) return rpcError(null, -32600, `1 to ${MAX_BATCH} calls a request`, 400);
  if (env.PER_NODE && !(await withinRate(env.PER_NODE, p.node, calls.slice(1)))) return rpcError(null, -32005, "rate limit exceeded", 429);
  for (const c of calls) {
    const why = refusal(c);
    if (why) return rpcError(c && c.id, -32601, why);
  }
  const up = await fetch(net.upstream + env.ALCHEMY_KEY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return new Response(up.body, { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] === "members") return join(request, env);
    if (parts.length === 2) return relay(request, env, ctx, parts[0], parts[1]);
    if (parts.length === 0) return new Response("Arc JSON-RPC for Unbrowse nodes whose owners signed in on unbrowse.ai.\n", { headers: { "content-type": "text/plain" } });
    return json({ error: "not found" }, 404);
  },
};
