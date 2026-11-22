// The deployed gateway's gate: node unbrowse-rpc/gate.mjs <base url>. Prints RPC_GATE_OK when the Worker at that address
// answers, refuses a membership without a Privy token, refuses a well-signed pass from a node that isn't a member, and
// refuses a pass for one network on another. It needs no secret and joins no one, so it runs against production too.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { passMessage } from "./src/gate.js";

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: node unbrowse-rpc/gate.mjs <base url>");
  process.exit(2);
}

// A key nobody makes a member: Foundry's first public test account.
const KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NODE = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function pass(network) {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const body = new TextEncoder().encode(passMessage(network, expiry));
  const all = new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`), ...body]);
  const s = secp256k1.sign(keccak_256(all), KEY);
  return `${NODE}.${expiry}.0x${hex(s.toCompactRawBytes())}${(27 + s.recovery).toString(16)}`;
}
const call = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const fails = [];
const check = (ok, what) => (ok ? console.log(`ok   ${what}`) : (fails.push(what), console.log(`FAIL ${what}`)));

const root = await fetch(base + "/");
check(root.status === 200 && (await root.text()).includes("Arc JSON-RPC"), "the Worker answers at its address");

const noToken = await post("/members", { node: NODE });
check(noToken.status === 401, `a membership without a Privy token is refused (${noToken.status})`);

const outsider = await post(`/arc-testnet/${pass("arc-testnet")}`, call);
const outsiderBody = await outsider.json().catch(() => ({}));
check(outsider.status === 403 && /isn't a member/.test(outsiderBody?.error?.message || ""), `a well-signed pass from a non-member is refused (${outsider.status})`);

const crossed = await post(`/arc-mainnet/${pass("arc-testnet")}`, call);
check(crossed.status === 401, `a testnet pass on mainnet is refused (${crossed.status})`);

const nowhere = await post(`/arc-elsewhere/${pass("arc-testnet")}`, call);
check(nowhere.status === 404, `a network the gateway doesn't serve is refused (${nowhere.status})`);

if (fails.length) {
  console.log(`${fails.length} check(s) failed`);
  process.exit(1);
}
console.log("RPC_GATE_OK");
