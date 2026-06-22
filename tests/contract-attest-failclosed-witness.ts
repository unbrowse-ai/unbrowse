// Witness the FAIL-CLOSED claim of the CLI↔server bind: only the deployer machine sends attestation
// headers; every other install (no key / rotated key / garbage seed) returns null → no headers →
// the server admits the declare on the legacy-anonymous path. This is the NEGATIVE path of a
// security guard — asserted in the bind commit but previously unwitnessed (Decalogue cmd 9: a claim
// is false witness until it re-runs). Pure: injects the seed loader, never touches the real key.
import { buildSpawnAttestation, AIKO_DEPLOYER_ROOT_PUBKEY } from "../src/values/contract-attest.js";

const body = new TextEncoder().encode('{"plan":"failclosed","action":"t"}');
const checks: Array<[string, boolean]> = [];

// 1. No deployer key (the common case — every non-Lewis install) → null → legacy-anonymous.
checks.push(["no-key → null", buildSpawnAttestation(body, "t", () => null) === null]);

// 2. Rotated/wrong key (a 32-byte seed whose pubkey ≠ the pinned root) → null (fail-closed, would
//    otherwise 401 server-side). Zero-seed's Ed25519 pubkey is a fixed value ≠ e6837faf.
checks.push(["rotated/wrong-key → null", buildSpawnAttestation(body, "t", () => "00".repeat(32)) === null]);

// 3. Garbage / too-short seed → null (never throws into the declare path).
checks.push(["short-seed → null", buildSpawnAttestation(body, "t", () => "abcd") === null]);
checks.push(["non-hex seed → null", buildSpawnAttestation(body, "t", () => "not-hex-zzzz") === null]);

// 4. POSITIVE control: the SAME seam with the REAL deployer seed yields headers — proving the null
//    results above are the GUARD firing, not the seam being broken. SKIP if no key on this box.
import { defaultDeployerSeedHex } from "../src/values/contract-attest.js";
const real = defaultDeployerSeedHex();
if (real) {
  const att = buildSpawnAttestation(body, "t", () => real);
  checks.push(["real-key → headers (control)", att !== null && att["x-aiko-lineage-chain"].length > 0]);
} else {
  console.log("(positive control skipped — no deployer key on this box)");
}

let allOk = true;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log(`pinned root: ${AIKO_DEPLOYER_ROOT_PUBKEY.slice(0, 12)}…`);
if (allOk) {
  console.log("ATTEST_FAILCLOSED_OK — only the deployer key produces headers; every other case → legacy-anonymous");
  process.exit(0);
}
console.error("ATTEST_FAILCLOSED_FAIL");
process.exit(1);
