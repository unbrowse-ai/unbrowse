// Composition signal over the pieces — bindSealedStorageHoles + fsSealedBlobStore +
// resolveLocalStorageForReplay (the real resolver). Proves the round-trip + the failing edges
// (wrong key, missing blob) + no plaintext on node or in store bytes-at-rest.
// Run: bun bench/capability/test_sealed_hole_e2e.ts
import { bindSealedStorageHoles, resolveLocalStorageForReplay, isHoleCommitment } from "../../src/values/storage-hole-bindings.ts";
import { fsSealedBlobStore } from "../../src/values/sealed-blob-store.ts";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const DIR = mkdtempSync(join(tmpdir(), "sealed-e2e-"));
const store = fsSealedBlobStore(DIR);
const KEY = new Uint8Array(32); for (let i = 0; i < 32; i++) KEY[i] = (i * 13 + 2) & 0xff;
const CKEY = new Uint8Array(32); for (let i = 0; i < 32; i++) CKEY[i] = (i * 5 + 7) & 0xff;
const WRONG = new Uint8Array(32).fill(7);
const SECRET = "Bearer eyJ.session.DO-NOT-LEAK-7f3a";

const rawNode: any = {
  operation_id: "op1", endpoint_id: "ep1", method: "GET", url_template: "https://x.example/api",
  action_kind: "read", resource_kind: "data", requires: [], provides: [], confidence: 1,
  page_metadata: { localStorage: { authToken: SECRET, theme: "dark" } },
};
const { node, sealed } = bindSealedStorageHoles(rawNode, KEY, CKEY);
for (const h of sealed) store.put(h.commitment, h.sealed); // persist off-graph under the store key

ok(!JSON.stringify(node).includes(SECRET), "node (what the graph holds) contains NO plaintext secret");
ok(isHoleCommitment(node.provides.find((p: any) => p.key === "authToken")?.commitment), "node carries a uhs1: keyed commitment");

let anyStorePlaintext = false;
for (const f of readdirSync(DIR)) if (readFileSync(join(DIR, f)).includes(Buffer.from(SECRET))) anyStorePlaintext = true;
ok(!anyStorePlaintext, "sealed-blob store holds CIPHERTEXT — secret never in bytes at rest");

// real resolver round-trip (handles sentinel + store-key internally)
const replayed = resolveLocalStorageForReplay(node.page_metadata.localStorage, KEY, store);
ok(replayed.authToken === SECRET && replayed.theme === "dark", "reveal-at-replay restores the original values for the holder");

// EDGE — wrong key → values dropped, never leaked
const wrongKeyed = resolveLocalStorageForReplay(node.page_metadata.localStorage, WRONG, store);
ok(!Object.values(wrongKeyed).includes(SECRET) && wrongKeyed.authToken === undefined, "wrong key at replay → dropped, never leaks (lost sheep #1)");

// EDGE — missing blob → dropped gracefully
const orphanNode = { authToken: "uhs1:" + "c".repeat(64) };
ok(Object.keys(resolveLocalStorageForReplay(orphanNode, KEY, store)).length === 0, "missing blob → dropped gracefully (lost sheep #2)");

console.log(fails === 0 ? "\nALL SEALED-HOLE E2E WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
