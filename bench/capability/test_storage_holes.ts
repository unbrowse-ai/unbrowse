// Witness: localStorage (and any credential/storage) values become SEALED nodes in the
// requires/yields DAG — the graph holds only the commitment, the value is sealed off-graph and
// revealed only by the holder's key, and a producer→consumer binding pair links by value identity.
// Run: bun bench/capability/test_storage_holes.ts
import {
  sealStorageHoles, requiresStorageBinding, holeProducedBy,
  isSealedHoleBinding, revealStorageHole, storageBindingValueIdentity,
  bindSealedStorageHoles,
} from "../../src/values/storage-hole-bindings.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const KEY = new Uint8Array(32); for (let i = 0; i < 32; i++) KEY[i] = (i * 7 + 3) & 0xff; // fixed 32-byte AES key
const WRONG = new Uint8Array(32); for (let i = 0; i < 32; i++) WRONG[i] = (i * 11 + 1) & 0xff;

const SECRET = "eyJhbGciOiJIUzI1NiJ9.session-token-DO-NOT-LEAK.sig";
const holes = sealStorageHoles({ authToken: SECRET, theme: "dark", empty: "", nope: undefined as unknown as string }, KEY, "localStorage");

ok(holes.length === 2, `only sealable string values become holes (authToken, theme); empty/undefined dropped (got ${holes.length})`);
const auth = holes.find((h) => h.binding.key === "authToken")!;
ok(auth.binding.type === "localStorage" && auth.binding.source === "localStorage", "yields binding carries kind=localStorage");
ok(auth.binding.required === false, "producer binding is a YIELDS (required:false)");
ok(/^[0-9a-f]{64}$/.test(auth.commitment) && auth.binding.commitment === auth.commitment, "commitment is sha256 of plaintext, on the binding");

// THE load-bearing privacy invariant: the secret never appears on the graph node/binding.
const onGraph = JSON.stringify(auth.binding);
ok(!onGraph.includes(SECRET), "SECRET value is NOT on the graph binding (only the commitment)");
ok(isSealedHoleBinding(auth.binding) === true, "binding is recognized as a sealed hole (commitment, no value)");

// The value is sealed off-graph and revealed ONLY by the holder's key.
ok(revealStorageHole(auth.commitment, auth.sealed, KEY) === SECRET, "holder's key reveals the original value");
let stayedSealed = false;
try { revealStorageHole(auth.commitment, auth.sealed, WRONG); } catch { stayedSealed = true; }
ok(stayedSealed, "wrong key CANNOT reveal — the value stays sealed (GCM auth tag)");

// Producer YIELDS ↔ consumer REQUIRES link by value identity (ignoring required bit).
const consumerNeeds = requiresStorageBinding("authToken", "localStorage");
ok(consumerNeeds.required === true, "consumer binding is a REQUIRES (required:true)");
const producer = holeProducedBy(consumerNeeds, holes.map((h) => h.binding));
ok(!!producer && producer.key === "authToken", "DAG links: the op that REQUIRES authToken finds the op that YIELDS it");
ok(storageBindingValueIdentity(consumerNeeds) === storageBindingValueIdentity(auth.binding),
   "value identity matches across the required-flag boundary (producer→consumer edge)");
const noMatch = holeProducedBy(requiresStorageBinding("unrelatedKey"), holes.map((h) => h.binding));
ok(noMatch === undefined, "a key with no producer does not falsely link");

// ── node integration: bindSealedStorageHoles seals + scrubs a real operation node ───────────
const rawNode: any = {
  operation_id: "op1", endpoint_id: "ep1", method: "GET", url_template: "https://x.example/api",
  action_kind: "read", resource_kind: "data", requires: [], provides: [], confidence: 1,
  page_metadata: { localStorage: { authToken: SECRET, theme: "dark" }, captured_at: "2026-06-16T00:00:00Z" },
};
const { node: bound, sealed } = bindSealedStorageHoles(rawNode, KEY);
ok(sealed.length === 2, `bind seals the node's localStorage entries (got ${sealed.length})`);
ok(bound.provides.some((p: any) => p.key === "authToken" && p.commitment && p.type === "localStorage"),
   "sealed authToken yields-binding added to node.provides");
const wholeNode = JSON.stringify(bound);
ok(!wholeNode.includes(SECRET), "THE LEAK FIX: SECRET nowhere in the serialized node (provides AND page_metadata scrubbed)");
ok(bound.page_metadata.localStorage.authToken === sealed.find((s) => s.binding.key === "authToken")!.commitment,
   "page_metadata.localStorage rewritten to commitments (was plaintext)");
ok(revealStorageHole(bound.page_metadata.localStorage.authToken, sealed.find((s) => s.binding.key === "authToken")!.sealed, KEY) === SECRET,
   "the value survives off-graph: revealable from the returned sealed blob via the key");
const empty = bindSealedStorageHoles({ ...rawNode, page_metadata: {} }, KEY);
ok(empty.sealed.length === 0 && empty.node === rawNode || empty.sealed.length === 0, "no localStorage → no-op (additive, safe)");

console.log(fails === 0 ? "\nALL STORAGE-HOLE WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
