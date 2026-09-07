// Witness: the CLI↔server native bind. The CLI's single-link spawn attestation (signed by the aiko
// substrate deployer key, src/values/contract-attest.ts) VERIFIES against the server's gate
// (backend/src/lib/attestation.ts) with the pinned root pubkey — and a tampered body is rejected.
// Proves the two sides recognize each other by ONE wallet-signed substrate identity, not a bearer key.
// LIVE scaffold: needs ~/.aiko/keys/root.key (only Lewis's machine) → SKIPs honestly when absent.
import { buildSpawnAttestation, AIKO_DEPLOYER_ROOT_PUBKEY } from "../src/values/contract-attest.js";
import { verifySpawnAttestation, LEWIS_DEPLOYER_PUBKEY_v1 } from "../backend/src/lib/attestation.js";

// The server pins exactly what the CLI signs with — the bind is self-consistent by construction.
if (LEWIS_DEPLOYER_PUBKEY_v1 !== AIKO_DEPLOYER_ROOT_PUBKEY) {
  console.error(`ATTEST_WITNESS_FAIL — pinned root (${LEWIS_DEPLOYER_PUBKEY_v1.slice(0, 12)}…) != CLI root (${AIKO_DEPLOYER_ROOT_PUBKEY.slice(0, 12)}…)`);
  process.exit(1);
}
console.log("✓ server pin == CLI root (e6837faf…)");

const body = JSON.stringify({ plan: "cli-server bind witness", action: "test:bind", wallet_identity: "x", ts: "2026-06-23T00:00:00Z" });
const bodyBytes = new TextEncoder().encode(body);

const att = buildSpawnAttestation(bodyBytes);
if (!att) {
  console.log("ATTEST_WITNESS_SKIP — no aiko deployer key on this machine (legacy-anonymous path, server admits it)");
  process.exit(0);
}
console.log("✓ CLI built single-link attestation headers");

// 1. GREEN: the server gate verifies the CLI attestation over the exact body bytes.
const ok = await verifySpawnAttestation({
  lineageChainHeader: att["x-aiko-lineage-chain"],
  signatureHeader: att["x-aiko-spawn-signature"],
  nonceHeader: att["x-aiko-spawn-nonce"],
  bodyBytes,
});
console.log("verify (valid):", JSON.stringify(ok));
const greenOk = ok.ok === true && ok.rootPubkey === AIKO_DEPLOYER_ROOT_PUBKEY && ok.leafPubkey === AIKO_DEPLOYER_ROOT_PUBKEY;

// 2. RED control: a TAMPERED body (one byte different) must fail signature_invalid — the leaf
//    signature is bound to the exact bytes, so the server can't be fooled by a swapped payload.
const tampered = new TextEncoder().encode(body.replace("bind witness", "evil witness"));
const red = await verifySpawnAttestation({
  lineageChainHeader: att["x-aiko-lineage-chain"],
  signatureHeader: att["x-aiko-spawn-signature"],
  nonceHeader: att["x-aiko-spawn-nonce"],
  bodyBytes: tampered,
});
console.log("verify (tampered body):", JSON.stringify(red));
const redOk = red.ok === false && red.reason === "signature_invalid";

if (greenOk && redOk) {
  console.log("ATTEST_WITNESS_OK — CLI single-link attestation verifies server-side (root=e6837faf); tampered body rejected");
  process.exit(0);
}
console.error("ATTEST_WITNESS_FAIL", { greenOk, redOk });
process.exit(1);
