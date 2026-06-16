// Witness (jesus-ralph residuals): the persistent cascade persists ONLY safe prereq yields.
// Closes the two cold-audit findings:
//   (A) one-time/auth-bearing yields (token/nonce/csrf/session/...) are NEVER persisted → no stale replay.
//   (B) auth-backed endpoints' yields are NEVER persisted → no cookie-authed user data under anon.
// Run: bun bench/capability/test_yield_safety.ts
import { isPersistableYield, isOneTimeYieldKey, endpointIsAuthBacked } from "../../src/values/yield-safety.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const pub = { semantic: { auth_required: false } }; // a public endpoint
const skill = {};

// GOLDEN: a public, non-token yield IS persistable.
ok(isPersistableYield(true, { city: "London", id: "42" }, pub, skill), "public non-token yield → persistable");

// (A) one-time / auth-bearing KEYS are rejected.
for (const k of ["csrf_token", "xsrf", "nonce", "session_id", "sessionId", "jwt", "auth", "bearer", "signature", "sig", "otp", "expires", "password", "api_token", "access_token", "state", "verifier"]) {
  ok(isOneTimeYieldKey(k), `one-time key detected: ${k}`);
  ok(!isPersistableYield(true, { [k]: "x", other: "ok" }, pub, skill), `yield containing '${k}' → NOT persisted (finding A)`);
}
// non-token keys are NOT falsely flagged (no over-rejection of normal data).
for (const k of ["city", "id", "name", "price", "user_id", "order_id", "title", "count", "status_label"]) {
  ok(!isOneTimeYieldKey(k), `normal key NOT flagged: ${k}`);
}

// (B) auth-backed endpoints' yields are rejected even if the keys look benign.
ok(endpointIsAuthBacked({ semantic: { auth_required: true } }, skill), "auth_required endpoint is auth-backed");
ok(endpointIsAuthBacked({ auth_profile_ref: "site-session" }, skill), "endpoint with auth_profile_ref is auth-backed");
ok(endpointIsAuthBacked(pub, { auth_profile_ref: "skill-session" }), "skill-level auth_profile_ref makes it auth-backed");
ok(!isPersistableYield(true, { balance: "1234.56" }, { semantic: { auth_required: true } }, skill),
   "auth-backed endpoint's benign-looking yield (balance) → NOT persisted (finding B — no cookie-authed data under anon)");
ok(!isPersistableYield(true, { feed: "items" }, { auth_profile_ref: "x-session" }, skill),
   "auth_profile_ref endpoint's yield → NOT persisted (finding B)");

// edge: empty / error → never persistable (unchanged contract).
ok(!isPersistableYield(false, { city: "London" }, pub, skill), "ok=false → not persistable");
ok(!isPersistableYield(true, {}, pub, skill), "empty yields → not persistable");

console.log(fails === 0 ? "\nYIELD-SAFETY WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
