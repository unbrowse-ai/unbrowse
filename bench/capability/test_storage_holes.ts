// Witness: localStorage (and any credential/storage) values become SEALED nodes in the requires/yields
// DAG — the graph holds only a KEYED commitment (uhs1: + HMAC, brute-force/linkability resistant), the
// value is sealed off-graph, revealed only by the holder's key, and producer→consumer bindings link by
// value identity. Run: bun bench/capability/test_storage_holes.ts
import { createHash, createHmac } from "node:crypto";
import {
  sealStorageHoles, requiresStorageBinding, holeProducedBy,
  isSealedHoleBinding, revealStorageHole, storageBindingValueIdentity,
  bindSealedStorageHoles, isHoleCommitment,
} from "../../src/values/storage-hole-bindings.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const KEY = new Uint8Array(32); for (let i = 0; i < 32; i++) KEY[i] = (i * 7 + 3) & 0xff;   // seal key
const CKEY = new Uint8Array(32); for (let i = 0; i < 32; i++) CKEY[i] = (i * 3 + 5) & 0xff;  // commitment key
const CKEY2 = new Uint8Array(32).fill(99);                                                   // a different install's key
const WRONG = new Uint8Array(32); for (let i = 0; i < 32; i++) WRONG[i] = (i * 11 + 1) & 0xff;

const SECRET = "eyJhbGciOiJIUzI1NiJ9.session-token-DO-NOT-LEAK.sig";
const holes = sealStorageHoles({ authToken: SECRET, theme: "dark", empty: "", nope: undefined as unknown as string }, KEY, CKEY, "localStorage");

ok(holes.length === 2, `only sealable string values become holes (got ${holes.length})`);
const auth = holes.find((h) => h.binding.key === "authToken")!;
ok(auth.binding.type === "localStorage" && auth.binding.required === false, "yields binding: kind=localStorage, required:false");
ok(isHoleCommitment(auth.binding.commitment) && auth.binding.commitment!.startsWith("uhs1:"), "on-graph commitment carries the uhs1: sentinel");
ok(/^[0-9a-f]{64}$/.test(auth.commitment), "off-graph store key is the 64-hex HMAC");

// THE privacy invariant: secret never on the graph binding.
ok(!JSON.stringify(auth.binding).includes(SECRET), "SECRET value is NOT on the graph binding");
ok(isSealedHoleBinding(auth.binding) === true, "binding recognized as a sealed hole");

// FIX A — the commitment is a KEYED MAC, not a brute-forceable bare hash of a low-entropy value.
const lowEntropy = sealStorageHoles({ theme: "dark" }, KEY, CKEY)[0];
const bareSha = createHash("sha256").update("dark").digest("hex");
ok(!lowEntropy.binding.commitment!.includes(bareSha), "commitment of low-entropy 'dark' is NOT sha256('dark') — keyed, not brute-forceable");
ok(lowEntropy.commitment === createHmac("sha256", Buffer.from(CKEY)).update("dark").digest("hex"), "commitment = HMAC(commitmentKey, value)");
// linkability: same value, DIFFERENT install key → DIFFERENT commitment.
const otherInstall = sealStorageHoles({ theme: "dark" }, KEY, CKEY2)[0];
ok(otherInstall.binding.commitment !== lowEntropy.binding.commitment, "same value across installs → different commitment (no cross-install linkability)");

// reveal: holder's key opens it; wrong key stays sealed.
ok(revealStorageHole(auth.binding.commitment!, auth.sealed, KEY) === SECRET, "holder's key reveals the original value");
let stayedSealed = false;
try { revealStorageHole(auth.binding.commitment!, auth.sealed, WRONG); } catch { stayedSealed = true; }
ok(stayedSealed, "wrong key CANNOT reveal — stays sealed");

// producer YIELDS ↔ consumer REQUIRES link.
const consumerNeeds = requiresStorageBinding("authToken", "localStorage");
ok(!!holeProducedBy(consumerNeeds, holes.map((h) => h.binding)), "DAG links: REQUIRES authToken finds the op that YIELDS it");
ok(holeProducedBy(requiresStorageBinding("unrelated"), holes.map((h) => h.binding)) === undefined, "no false link for an unproduced key");

// node integration: seal + scrub.
const rawNode: any = {
  operation_id: "op1", endpoint_id: "ep1", method: "GET", url_template: "u",
  action_kind: "read", resource_kind: "data", requires: [], provides: [], confidence: 1,
  page_metadata: { localStorage: { authToken: SECRET, theme: "dark" } },
};
const { node: bound, sealed } = bindSealedStorageHoles(rawNode, KEY, CKEY);
ok(sealed.length === 2, "bind seals the node's localStorage entries");
ok(bound.provides.some((p: any) => p.key === "authToken" && isHoleCommitment(p.commitment)), "sealed yields-binding added to provides");
ok(!JSON.stringify(bound).includes(SECRET), "THE LEAK FIX: SECRET nowhere in the serialized node");
const boundAuth = sealed.find((s) => s.binding.key === "authToken")!;
ok(bound.page_metadata.localStorage.authToken === boundAuth.binding.commitment, "page_metadata.localStorage rewritten to the sentinel commitment");
ok(revealStorageHole(boundAuth.binding.commitment!, boundAuth.sealed, KEY) === SECRET, "value survives off-graph: revealable from the sealed blob via the key");

console.log(fails === 0 ? "\nALL STORAGE-HOLE WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
