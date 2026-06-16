// Witness: valueSetPointer is the value-side mirror of endpointContentHash — a Merkle-sensitive
// content pointer over the resolved bound VALUES (param-hole fills / prerequisite yields). Any
// value/key change → a new pointer (so a value change can cascade); no change → the same pointer
// (so a shape reused with the same values never spuriously invalidates). Order-independent and
// stable-empty. Proves the plan's "value pointer is first-class / Merkle sensitivity both directions"
// for the leaf primitive. Run: bun bench/capability/test_value_set_pointer.ts
import { valueSetPointer } from "../../src/values/content-address.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const base = { q: "shoes", page: 1, fresh: true };

// — shape of the pointer —
ok(valueSetPointer(base).startsWith("sha256:"), "pointer is a sha256:<hex> content pointer");

// — Merkle sensitivity: change ANY one value → a DIFFERENT pointer —
ok(valueSetPointer(base) !== valueSetPointer({ ...base, q: "boots" }), "a changed string value → different pointer");
ok(valueSetPointer(base) !== valueSetPointer({ ...base, page: 2 }), "a changed number value → different pointer");
ok(valueSetPointer(base) !== valueSetPointer({ ...base, fresh: false }), "a changed bool value → different pointer");
ok(valueSetPointer(base) !== valueSetPointer({ ...base, extra: "x" }), "an ADDED key → different pointer");
{ const { fresh, ...less } = base; void fresh; ok(valueSetPointer(base) !== valueSetPointer(less), "a REMOVED key → different pointer"); }

// — no change → the SAME pointer (reuse without spurious invalidation) —
ok(valueSetPointer(base) === valueSetPointer({ q: "shoes", page: 1, fresh: true }), "identical values → identical pointer (no spurious change)");

// — order-independence: same pairs in any insertion order → same pointer —
ok(valueSetPointer({ q: "shoes", page: 1, fresh: true }) === valueSetPointer({ fresh: true, page: 1, q: "shoes" }), "insertion order does not affect the pointer");

// — stable empty, distinct from non-empty —
ok(valueSetPointer({}) === valueSetPointer({}), "empty set → stable pointer");
ok(valueSetPointer({}) !== valueSetPointer({ q: "shoes" }), "empty set distinct from a non-empty set");

// — disambiguation: {a:'b=c'} vs {'a=b':'c'} must NOT collide (delimiter safety) —
ok(valueSetPointer({ a: "b", c: "d" }) !== valueSetPointer({ a: "b\nc=d" } as Record<string, string>), "key/value boundary is not ambiguous across pairs");

console.log(fails === 0 ? "\nVALUE-SET-POINTER WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
