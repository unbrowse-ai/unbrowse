import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import * as gate from "../src/gate.js";
import { passMessage, signerOf, readPass, refusal, privyUser, MAX_PASS_AHEAD_S } from "../src/gate.js";

// Foundry's first test account, a public key pair, and a pass it signed with `cast wallet sign` (standard EIP-191).
const TEST_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const CAST_SIG = "0x7652984c75850825d098c6ff1118a1a7c454471324c79080c9dadfcbc4215380174dc4bc14bb8f5f98ad4a8319e1ade90166d4762cc98fa7ab6bf5ae54248a661b";

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function sign(message, key = TEST_KEY) {
  const body = new TextEncoder().encode(message);
  const all = new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`), ...body]);
  const s = secp256k1.sign(keccak_256(all), key);
  return "0x" + hex(s.toCompactRawBytes()) + (27 + s.recovery).toString(16);
}

test("a pass signed by standard EIP-191 tooling is read as its node's", () => {
  assert.equal(signerOf(passMessage("arc-testnet", 1900000000), CAST_SIG), TEST_ADDR);
  const p = readPass("arc-testnet", `${TEST_ADDR}.1900000000.${CAST_SIG}`, 1900000000 - 3600);
  assert.deepEqual(p, { node: TEST_ADDR });
});

test("a pass is good only for its network, its node and its day", () => {
  const now = 1_800_000_000;
  const exp = now + 86_400;
  const sig = sign(passMessage("arc-mainnet", exp));
  assert.equal(readPass("arc-mainnet", `${TEST_ADDR}.${exp}.${sig}`, now).node, TEST_ADDR);
  assert.match(readPass("arc-testnet", `${TEST_ADDR}.${exp}.${sig}`, now).why, /isn't signed by the node/, "another network");
  assert.match(readPass("arc-mainnet", `0x${"11".repeat(20)}.${exp}.${sig}`, now).why, /isn't signed by the node/, "another node named");
  assert.match(readPass("arc-mainnet", `${TEST_ADDR}.${exp}.${sig}`, exp).why, /ran out/, "expired");
  const far = now + MAX_PASS_AHEAD_S + 60;
  assert.match(readPass("arc-mainnet", `${TEST_ADDR}.${far}.${sign(passMessage("arc-mainnet", far))}`, now).why, /too far ahead/);
  assert.match(readPass("arc-mainnet", "nonsense", now).why, /a pass is/);
});

test("only the methods a node calls are relayed, and logs only over a node's window", () => {
  assert.equal(refusal({ method: "eth_call", params: [] }), null);
  assert.equal(refusal({ method: "eth_sendRawTransaction", params: ["0x00"] }), null);
  assert.match(refusal({ method: "debug_traceTransaction", params: [] }), /isn't relayed/);
  assert.match(refusal({ method: "eth_newBlockFilter", params: [] }), /isn't relayed/);
  assert.equal(refusal({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2710" }] }), null, "10,000 blocks");
  assert.match(refusal({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2711" }] }), /at most/, "10,001 blocks");
  assert.match(refusal({ method: "eth_getLogs", params: [{ fromBlock: "latest", toBlock: "latest" }] }), /numbered/);
  assert.equal(refusal({ method: "eth_getLogs", params: [{ blockHash: "0x" + "ab".repeat(32) }] }), null, "one block by hash");
});

// ---- Privy access tokens ----

const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function privyKey(kid) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pair, jwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, kid, alg: "ES256", use: "sig" } };
}
async function token(pair, kid, claims) {
  const head = b64url(Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid })));
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

test("a Privy access token names its user only when Privy signed it for this app and it hasn't run out", async () => {
  const now = 1_800_000_000;
  const app = "app-under-test";
  const { pair, jwk } = await privyKey("k1");
  const other = await privyKey("k1");
  const jwks = { keys: [jwk] };
  const good = { iss: "privy.io", aud: app, sub: "did:privy:abc", exp: now + 3600, iat: now };
  assert.deepEqual(await privyUser(await token(pair, "k1", good), jwks, app, now), { user: "did:privy:abc" });
  assert.match((await privyUser(await token(other.pair, "k1", good), jwks, app, now)).why, /signature/, "signed by a key Privy didn't publish");
  assert.match((await privyUser(await token(pair, "k1", { ...good, aud: "another-app" }), jwks, app, now)).why, /another Privy app/);
  assert.match((await privyUser(await token(pair, "k1", { ...good, iss: "elsewhere" }), jwks, app, now)).why, /not issued by Privy/);
  assert.match((await privyUser(await token(pair, "k1", { ...good, exp: now - 1 }), jwks, app, now)).why, /ran out/);
  assert.match((await privyUser(await token(pair, "k9", good), { keys: [jwk, (await privyKey("k2")).jwk] }, app, now)).why, /doesn't publish/);
  assert.match((await privyUser("a.b", jwks, app, now)).why, /not a token/);
});

// A node refused a moment before its owner signed in is served at once: a refusal is kept for seconds, a membership
// for minutes (seen 2026-11-18 on the production gateway, where a refusal was kept 5 minutes).
test("a refusal is kept for seconds, a membership for minutes", async () => {
  const { cachedMember, MEMBER_TTL_MS, NOT_MEMBER_TTL_MS } = await import("../src/gate.js");
  assert.ok(NOT_MEMBER_TTL_MS <= 15_000, "a refusal is asked again within seconds");
  assert.equal(cachedMember(undefined, 0), undefined);
  assert.equal(cachedMember({ at: 0, yes: false }, NOT_MEMBER_TTL_MS - 1), false);
  assert.equal(cachedMember({ at: 0, yes: false }, NOT_MEMBER_TTL_MS), undefined, "past it: the member list is asked again");
  assert.equal(cachedMember({ at: 0, yes: false }, 60_000), undefined, "a minute later the refusal is long gone");
  assert.equal(cachedMember({ at: 0, yes: true }, 60_000), true, "a member is still a member a minute later");
  assert.equal(cachedMember({ at: 0, yes: true }, MEMBER_TTL_MS), undefined);
});

test("a batch costs one unit of the rate limit per call", async () => {
  const spent = [];
  const limiter = (room) => ({ limit: async ({ key }) => (spent.push(key), { success: spent.length <= room }) });
  assert.equal(typeof gate.withinRate, "function");
  const calls = Array.from({ length: gate.MAX_BATCH }, (_, i) => ({ id: i }));
  assert.equal(await gate.withinRate(limiter(600), "0xnode", calls), true);
  assert.equal(spent.length, gate.MAX_BATCH, "one unit a call, not one a request");
  assert.deepEqual([...new Set(spent)], ["0xnode"]);
  spent.length = 0;
  assert.equal(await gate.withinRate(limiter(49), "0xnode", calls), false, "a batch the limit can't cover is refused");
  spent.length = 0;
  assert.equal(await gate.withinRate(limiter(5), "0xnode", [{ id: 1 }]), true, "a single call costs one");
});
