// Witness: the values-ledger pointer→pointer cascade. A cached resolution folds the content
// pointers of the values it CONSUMED (dependsOn); when a dependency's pointer changes, the entry
// re-keys → cache miss → recompute (cascade-invalidate). Unchanged dependency → served. This is the
// TRUE home of "values ledger contract, pointer pointer invalidate on change" — the composite
// value_id was inert at the pre-walk read (Step 5 lost sheep). Run:
// bun bench/capability/test_value_ledger_dependency_cascade.ts
import { cachedResolution, keyWithDeps } from "../../src/values/cached-resolution.ts";
import { rmSync } from "node:fs";

const dir = `/tmp/value-ledger-dep-${process.pid}`;
const TTL = 60_000;
let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

// A counting recompute so we can tell a HIT (no recompute) from a MISS (recompute).
function counter(label: string) {
  let n = 0;
  return { fn: async () => `${label}#${++n}`, calls: () => n };
}
const cacheable = () => true;
async function resolve(key: string, dependsOn: string[] | undefined, c: { fn: () => Promise<string> }) {
  return cachedResolution<string>({ key, ttlMs: TTL, recompute: c.fn, cacheable, dir, dependsOn });
}

(async () => {
  const A1 = "sha256:aaa1", A2 = "sha256:aaa2"; // A's content pointer before / after a value change

  // — golden: a leaf resolution caches; re-read serves (pointer surfaced) —
  const b = counter("B");
  const r1 = await resolve("intent:B", [A1], b);
  ok(r1.cached === false && r1.value === "B#1", "first call: miss + recompute");
  ok(typeof r1.pointer === "string" && r1.pointer!.startsWith("sha256:"), "result pointer is surfaced (for a dependent to fold)");
  const r2 = await resolve("intent:B", [A1], b);
  ok(r2.cached === true && r2.value === "B#1", "GOLDEN: same key + UNCHANGED dependency → HIT (served, no recompute)");
  ok(b.calls() === 1, "no recompute on the dependency-unchanged hit");

  // — edge 1: the dependency's pointer CHANGES → cascade-invalidate (miss + recompute) —
  const r3 = await resolve("intent:B", [A2], b);
  ok(r3.cached === false && r3.value === "B#2", "CASCADE: a changed dependency pointer (A1→A2) → MISS + recompute");
  ok(b.calls() === 2, "recompute fired because the dependency changed");

  // — edge 2: no dependsOn (leaf) keys independently — distinct from the dep-bearing entry —
  const c2 = counter("L");
  const l1 = await resolve("intent:B", undefined, c2);
  ok(l1.cached === false, "no-deps entry is a DISTINCT key from the dep-bearing one (not a false hit)");
  const l2 = await resolve("intent:B", undefined, c2);
  ok(l2.cached === true, "back-compat: leaf resolution (no deps) still caches by key alone");

  // — edge 3: order-independence — same dependency set, any order → same key → hit —
  const c3 = counter("M");
  await resolve("intent:M", ["sha256:x", "sha256:y"], c3);
  const m2 = await resolve("intent:M", ["sha256:y", "sha256:x"], c3);
  ok(m2.cached === true, "dependency order does not matter (sorted) → same key → hit");

  // — adversarial: a dependency value that mimics the fold delimiter must NOT collide —
  ok(keyWithDeps("intent:Z", ["sha256:a"]) !== keyWithDeps("intent:Z", ["sha256:a,sha256:b"]),
     "one dep 'a,b' (comma inside) does not collide with two deps [a,b]");
  // THE LOST SHEEP (Day 5): the true comma-ambiguity — one dep literally "p1,p2" vs two deps
  // ["p1","p2"] folded IDENTICALLY under the old bare comma-join. JSON-encoding makes it injective.
  // (latent today — deps are hex pointers — but the content-addressing contract must hold for any
  // future caller that folds non-hash value keys.) Mutation-proven against the bare comma-join.
  ok(keyWithDeps("intent:W", ["p1,p2"]) !== keyWithDeps("intent:W", ["p1", "p2"]),
     "one dep 'p1,p2' (comma INSIDE the value) does NOT collide with two deps ['p1','p2'] — injective");
  ok(keyWithDeps("intent:W", ["aaa", "bbb"]) === keyWithDeps("intent:W", ["bbb", "aaa"]),
     "deps remain order-independent (sorted) after the injectivity fix");
  ok(keyWithDeps("intent:Z", undefined) === "intent:Z", "no deps → bare key unchanged (back-compat)");
  // a key that literally contains 'deps:[' must not be forgeable into a dep-bearing key
  ok(keyWithDeps("intent:Zdeps:[sha256:a]", undefined) !== keyWithDeps("intent:Z", ["sha256:a"]),
     "a key containing the deps marker is not confusable with a real dependency fold");

  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(fails === 0 ? "\nVALUE-LEDGER DEPENDENCY-CASCADE WITNESS PASSES" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
