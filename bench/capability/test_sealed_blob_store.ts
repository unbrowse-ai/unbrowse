// Witness: fsSealedBlobStore persists sealed bytes off-graph, byte-exact, across instances, and a
// value sealed → stored → revealed from a FRESH store round-trips to the original (the off-graph
// half of "render the structure to all, seal the value to the holder"). Path-traversal guarded.
// Run: bun bench/capability/test_sealed_blob_store.ts
import { fsSealedBlobStore, memSealedBlobStore, defaultSealedBlobDir } from "../../src/values/sealed-blob-store.ts";
import { sealValue, revealValue } from "../../src/values/wallet-seal.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const DIR = mkdtempSync(join(tmpdir(), "sealed-blob-"));
const HASH = "a".repeat(64); // valid sha256-hex shape
const BAD = "../../etc/passwd";

// binary payload exercising all byte values (proves no utf8 corruption)
const payload = new Uint8Array(256); for (let i = 0; i < 256; i++) payload[i] = i;

// 1. persistence ACROSS INSTANCES (the whole point — not in-memory)
fsSealedBlobStore(DIR).put(HASH, payload);
const fresh = fsSealedBlobStore(DIR); // brand-new store object, same dir
const got = fresh.get(HASH);
ok(!!got && got.length === 256, "sealed bytes survive across store instances (persistent on disk)");
ok(!!got && got.every((b, i) => b === i), "bytes are BYTE-EXACT across the disk round-trip (no utf8 corruption)");
ok(fresh.has(HASH) === true, "has() true for a persisted blob");
ok(fsSealedBlobStore(DIR).get("b".repeat(64)) === undefined, "absent hash → undefined");

// 2. path-traversal guard (a hostile commitment cannot escape the dir)
ok(fsSealedBlobStore(DIR).get(BAD) === undefined, "non-sha256 key (../traversal) → undefined, never reads outside dir");
let threw = false; try { fsSealedBlobStore(DIR).put(BAD, payload); } catch { threw = true; }
ok(threw, "put() with a non-sha256 key throws (fail-closed)");

// 3. FULL seal → store → reveal-from-fresh-store round-trip (the real use)
const KEY = new Uint8Array(32); for (let i = 0; i < 32; i++) KEY[i] = (i * 5 + 1) & 0xff;
const SECRET = new TextEncoder().encode("session-token-DO-NOT-LEAK-42");
const { hash, sealed } = sealValue(SECRET, KEY);
fsSealedBlobStore(DIR).put(hash, sealed);
const reSealed = fsSealedBlobStore(DIR).get(hash)!;            // retrieved from a fresh store
const revealed = revealValue(hash, reSealed, KEY);
ok(new TextDecoder().decode(revealed) === "session-token-DO-NOT-LEAK-42",
   "seal → persist → reveal from a FRESH store returns the original secret");
const wrong = new Uint8Array(32).fill(9);
let stayedSealed = false; try { revealValue(hash, reSealed, wrong); } catch { stayedSealed = true; }
ok(stayedSealed, "wrong key cannot reveal the persisted blob (stays sealed)");

// 4. mem variant honors the same interface + key guard
const mem = memSealedBlobStore();
mem.put(HASH, payload);
ok(mem.has(HASH) && mem.get(HASH)?.length === 256, "memSealedBlobStore round-trips");
let memThrew = false; try { mem.put(BAD, payload); } catch { memThrew = true; }
ok(memThrew, "mem variant also fail-closed on bad key");

// 5. default dir is under the unbrowse home (not cwd)
ok(defaultSealedBlobDir().includes(".unbrowse") && defaultSealedBlobDir().includes("sealed-blobs"),
   "default dir is ~/.unbrowse/sealed-blobs");

console.log(fails === 0 ? "\nALL SEALED-BLOB-STORE WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
