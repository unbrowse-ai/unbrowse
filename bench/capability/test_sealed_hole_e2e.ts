// Luminary: the COMPOSITION signal over the two shipped pieces — bindSealedStorageHoles (seal+scrub
// node) + fsSealedBlobStore (persist off-graph) + revealStorageHole (unseal at replay). This is the
// seam Step 5's capture/replay production will stand on; the storm tests it first (Matt 7:25). Chases
// the failing edges (Luke 15:4): wrong key, missing blob, and ANY plaintext leak on node or in store.
// Run: bun bench/capability/test_sealed_hole_e2e.ts
import { bindSealedStorageHoles, revealStorageHole } from "../../src/values/storage-hole-bindings.ts";
import { fsSealedBlobStore } from "../../src/values/sealed-blob-store.ts";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const DIR = mkdtempSync(join(tmpdir(), "sealed-e2e-"));
const store = fsSealedBlobStore(DIR);
const KEY = new Uint8Array(32); for (let i = 0; i < 32; i++) KEY[i] = (i * 13 + 2) & 0xff;
const WRONG = new Uint8Array(32).fill(7);
const SECRET = "Bearer eyJ.session.DO-NOT-LEAK-7f3a";

// ── the full pipeline a capture would run: bind (seal+scrub) → persist blobs off-graph ──
const rawNode: any = {
  operation_id: "op1", endpoint_id: "ep1", method: "GET", url_template: "https://x.example/api",
  action_kind: "read", resource_kind: "data", requires: [], provides: [], confidence: 1,
  page_metadata: { localStorage: { authToken: SECRET, theme: "dark" } },
};
const { node, sealed } = bindSealedStorageHoles(rawNode, KEY);
for (const h of sealed) store.put(h.commitment, h.sealed); // persist off-graph

// 1. node carries only commitments; the persisted graph is value-blind
const nodeJson = JSON.stringify(node);
ok(!nodeJson.includes(SECRET), "node (what the global graph holds) contains NO plaintext secret");
const authProvide = node.provides.find((p: any) => p.key === "authToken");
ok(!!authProvide?.commitment && /^[0-9a-f]{64}$/.test(authProvide.commitment), "node carries the commitment only");

// 2. the store holds CIPHERTEXT, not plaintext — even the bytes at rest never reveal the secret
let anyStorePlaintext = false;
for (const f of readdirSync(DIR)) {
  const bytes = readFileSync(join(DIR, f));
  if (bytes.includes(Buffer.from(SECRET))) anyStorePlaintext = true;
}
ok(!anyStorePlaintext, "sealed-blob store holds CIPHERTEXT — the secret never appears in bytes at rest");

// 3. replay round-trip: commitment on node → store.get → reveal → original (the agent gets the value)
const commitment = authProvide!.commitment!;
const blob = store.get(commitment)!;
ok(!!blob, "replay finds the sealed blob by the node's commitment");
ok(revealStorageHole(commitment, blob, KEY) === SECRET, "reveal-at-replay returns the original secret to the holder");

// 4. EDGE — wrong key at replay: stays sealed (no leak, no crash → caller skips injection)
let stayedSealed = false; try { revealStorageHole(commitment, blob, WRONG); } catch { stayedSealed = true; }
ok(stayedSealed, "wrong key at replay → stays sealed (the lost sheep #1)");

// 5. EDGE — missing blob (commitment on graph but blob evicted): graceful undefined, no crash/leak
ok(store.get("c".repeat(64)) === undefined, "missing blob → undefined (replay degrades gracefully, the lost sheep #2)");

console.log(fails === 0 ? "\nALL SEALED-HOLE E2E WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
