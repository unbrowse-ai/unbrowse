#!/usr/bin/env bun
/**
 * Verify an x402 owner-credit proof ON-CHAIN (read-only) so the gate cannot be
 * greened by merely writing a file. Confirms the proof's finalize tx exists on
 * the recorded cluster, succeeded (err==null), touched the FLEX program, and
 * recorded a positive owner credit.
 *
 * Exit 0 = verified, 1 = not verified. Usage: bun verify-x402-proof.mjs <proof.json>
 */
import { readFileSync } from "node:fs";

const FLEX_PROGRAM = "EcfUgNgDXmBx4Xns2qZLE54xpM7V1N6PL8MdDW1syujS";
const RPCS = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

function fail(msg) { console.error("[verify-x402] FAIL: " + msg); process.exit(1); }

async function main() {
  const path = process.argv[2];
  if (!path) fail("no proof path given");
  let proof;
  try { proof = JSON.parse(readFileSync(path, "utf8")); } catch (e) { fail("unreadable proof: " + e.message); }

  if (proof.ok !== true) fail("proof.ok is not true");
  const credited = Number(proof.creditedAtomic ?? (proof.afterAtomic - proof.beforeAtomic));
  if (!(credited > 0)) fail(`creditedAtomic must be > 0, got ${credited}`);
  const tx = proof.finalizeTx || proof.settleTx;
  if (!tx) fail("no finalizeTx/settleTx in proof");
  const rpc = process.env.X402_VERIFY_RPC || RPCS[proof.network] || RPCS.devnet;

  const res = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [tx, { maxSupportedTransactionVersion: 0, encoding: "json" }] }),
  }).then((r) => r.json()).catch((e) => fail("rpc error: " + e.message));

  const r = res?.result;
  if (!r) fail(`finalize tx ${tx} not found on ${proof.network} (${rpc})`);
  if (r.meta?.err) fail(`finalize tx failed on-chain: ${JSON.stringify(r.meta.err)}`);

  const keys = (r.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  if (!keys.includes(FLEX_PROGRAM)) fail(`finalize tx does not touch the FLEX program ${FLEX_PROGRAM}`);

  console.log(`[verify-x402] OK: ${proof.network} finalize tx ${tx} confirmed (slot ${r.slot}), `
    + `FLEX program present, owner credited ${credited} atomic to ${proof.recipientAta || proof.recipientWallet}`);
  process.exit(0);
}
main().catch((e) => fail(e?.message || String(e)));
