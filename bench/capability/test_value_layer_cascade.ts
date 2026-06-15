// Witness (node 5): the value/resolution layer ALREADY cascades by construction — content-addressed
// pointers + a hash-chain where each record folds prev. A value change re-keys (contentPointer) and
// propagates up the chain (recordHash), so a stale serve is structurally impossible. This confirms
// the layer the plan says is already-correct; it does NOT modify it. Run:
// bun bench/capability/test_value_layer_cascade.ts
import { GENESIS, contentPointer, recordHash } from "../../src/values/content-address.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

// ── contentPointer: the key IS the value's hash → a value change re-keys (old pointer orphaned) ──
ok(contentPointer("v1") === contentPointer("v1"), "contentPointer: deterministic (same value → same key)");
ok(contentPointer("v1") !== contentPointer("v2"), "contentPointer: a value change → a DIFFERENT key (stale serve structurally impossible — you fetch by content)");
ok(contentPointer("v1").startsWith("sha256:"), "contentPointer: content-addressed (sha256:)");

// ── recordHash hash-chain: each record folds prev → a LEAF change cascades up to dependents ──
const h1 = recordHash({ intent: "login", prev: GENESIS, result: contentPointer("tok-A"), seq: 0 });
const h2 = recordHash({ intent: "feed", prev: h1, result: contentPointer("feed-A"), seq: 1 });
const h3 = recordHash({ intent: "top", prev: h2, result: contentPointer("top-A"), seq: 2 });

// tamper the LEAF (record 0)'s value → its hash changes
const h1prime = recordHash({ intent: "login", prev: GENESIS, result: contentPointer("tok-TAMPERED"), seq: 0 });
ok(h1prime !== h1, "chain: a leaf value change → the leaf record hash changes");

// CASCADE: recomputing the dependent record with the new prev yields a different hash — the change
// propagated UP the chain (the dependent can no longer match its stored prev).
const h2recomputed = recordHash({ intent: "feed", prev: h1prime, result: contentPointer("feed-A"), seq: 1 });
ok(h2recomputed !== h2, "CASCADE: the leaf change propagates to the DEPENDENT record's hash (prev fold)");
const h3recomputed = recordHash({ intent: "top", prev: h2recomputed, result: contentPointer("top-A"), seq: 2 });
ok(h3recomputed !== h3, "CASCADE multi-level: the leaf change reaches the TOP record (transitive, Merkle)");

// determinism: an untouched chain recomputes identically (no spurious invalidation)
ok(recordHash({ intent: "feed", prev: h1, result: contentPointer("feed-A"), seq: 1 }) === h2, "no-change → same hash (no spurious invalidation)");

console.log(fails === 0 ? "\nVALUE-LAYER CASCADE WITNESS PASSES (already-correct, content-addressed + hash-chained)" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
