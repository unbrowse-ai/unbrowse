import { setSecret, getSecret, removeSecret } from "../src/values/keychain.js";
const S = "unbrowse-acl-churn-witness", A = "default", V = "ab".repeat(32);
removeSecret(S, A);
const t0 = Date.now();
const created = setSecret(S, A, V);
const readBack = getSecret(S, A);
const redundant = setSecret(S, A, V);     // SAME value → macSet read-first must SKIP the ACL write
const ms = Date.now() - t0;
removeSecret(S, A);
const roundtrip = readBack === V;
console.log(`created=${created} roundtrip=${roundtrip} redundant=${redundant} elapsed=${ms}ms`);
if (created && roundtrip && redundant && ms < 4000) { console.log("KEYCHAIN_ACL_IDEMPOTENT_OK"); process.exit(0); }
console.error("KEYCHAIN_ACL_WITNESS_FAIL"); process.exit(1);
