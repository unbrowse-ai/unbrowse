// Witness (de-hatching): the per-prereq principal folds COOKIES, not headers alone — closing cold
// audit finding B (a cookie-authed yield must never partition as "anon" and leak cross-principal).
// Run: bun bench/capability/test_cookie_principal.ts
import { credentialFromAuthContext, principalScope } from "../../src/runtime/principal-scope.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const ck = (n: string, v: string) => ({ name: n, value: v });

// 1) genuinely public (no headers, no cookies) → undefined → shared "anon" scope (unchanged).
ok(credentialFromAuthContext(undefined, null) === undefined, "no auth context → undefined (shared anon)");
ok(principalScope(credentialFromAuthContext(undefined, null)) === "anon", "→ anon scope");

// 2) THE FIX: a cookie-authed context is NOT anon — two different cookie sets → different principals.
const alice = credentialFromAuthContext(undefined, [ck("session", "ALICE")]);
const bob = credentialFromAuthContext(undefined, [ck("session", "BOB")]);
ok(alice !== undefined && bob !== undefined, "a cookie-authed context yields a non-undefined credential");
ok(alice !== bob, "alice's cookies and bob's cookies → DIFFERENT credentials (no shared partition)");
ok(principalScope(alice) !== principalScope(bob), "→ DIFFERENT principal scopes (no cross-principal replay)");
ok(principalScope(alice) !== "anon" && principalScope(bob) !== "anon", "a cookie-authed yield is NEVER the anon partition (finding B closed)");

// 3) order-independence: cookie order can't fork the partition.
const a1 = credentialFromAuthContext(undefined, [ck("a", "1"), ck("b", "2")]);
const a2 = credentialFromAuthContext(undefined, [ck("b", "2"), ck("a", "1")]);
ok(a1 === a2, "cookie order does not change the credential (sorted)");

// 4) headers AND cookies both fold in; changing either changes the partition.
const hc = credentialFromAuthContext({ authorization: "Bearer X" }, [ck("session", "S")]);
const hOnly = credentialFromAuthContext({ authorization: "Bearer X" }, null);
const cOnly = credentialFromAuthContext(undefined, [ck("session", "S")]);
ok(hc !== hOnly && hc !== cOnly, "header+cookie credential differs from header-only and cookie-only (both fold in)");
ok(credentialFromAuthContext({ authorization: "Bearer X" }, [ck("session", "S")]) === hc, "same context → same credential (deterministic)");

// 5) injectivity at the header/cookie boundary: a cookie value can't be confused with a header.
const boundaryA = credentialFromAuthContext({ authorization: "A" }, [ck("x", "B")]);
const boundaryB = credentialFromAuthContext({ authorization: "A;x=B" }, null);
ok(boundaryA !== boundaryB, "cookie half can't be forged from the header half (JSON-injective boundary)");

console.log(fails === 0 ? "\nCOOKIE-PRINCIPAL WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
