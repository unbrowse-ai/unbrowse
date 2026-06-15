// The live lockstep — sealSkillSnapshotHoles (seal hook) + resolveLocalStorageForReplay (reveal hook).
// Golden + 2 edges + 1 adversarial + the FIX-B regression guard (sha256-shaped legacy token must pass
// through, not drop). Run: bun bench/capability/test_seal_replay_lockstep.ts
import { sealSkillSnapshotHoles, resolveLocalStorageForReplay, isHoleCommitment } from "../../src/values/storage-hole-bindings.ts";
import { fsSealedBlobStore } from "../../src/values/sealed-blob-store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const store = fsSealedBlobStore(mkdtempSync(join(tmpdir(), "lockstep-")));
const KEY = new Uint8Array(32); for (let i = 0; i < 32; i++) KEY[i] = (i * 17 + 4) & 0xff;
const CKEY = new Uint8Array(32); for (let i = 0; i < 32; i++) CKEY[i] = (i * 9 + 2) & 0xff;
const WRONG = new Uint8Array(32).fill(3);
const SECRET = "csrf-Xy9z-DO-NOT-LEAK";

function skillWithLs(ls: Record<string, string>): any {
  return { skill_id: "s1", operation_graph: { operations: [{
    operation_id: "op1", endpoint_id: "ep1", method: "GET", url_template: "u",
    action_kind: "read", resource_kind: "d", requires: [], provides: [], confidence: 1,
    page_metadata: { localStorage: ls },
  }], edges: [] } };
}

// GOLDEN: seal-at-persist → reveal-at-replay round-trips the value
const sealed = sealSkillSnapshotHoles(skillWithLs({ csrf: SECRET, theme: "dark" }), KEY, CKEY, store);
const sealedNode = sealed.operation_graph.operations[0];
ok(!JSON.stringify(sealed).includes(SECRET), "GOLDEN: sealed snapshot has NO plaintext secret");
ok(isHoleCommitment(sealedNode.page_metadata.localStorage.csrf), "GOLDEN: node localStorage is uhs1: commitments");
const replayed = resolveLocalStorageForReplay(sealedNode.page_metadata.localStorage, KEY, store);
ok(replayed.csrf === SECRET && replayed.theme === "dark", "GOLDEN: reveal-at-replay restores the originals");

// FIX B — a LEGACY plaintext token that is sha256-shaped (64 hex) must pass through, NOT be dropped
const sha256ShapedToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const legacy = resolveLocalStorageForReplay({ csrf: sha256ShapedToken, sid: "plain" }, KEY, store);
ok(legacy.csrf === sha256ShapedToken, "FIX B: a 64-hex LEGACY token passes through unchanged (no sentinel → not a commitment)");
ok(legacy.sid === "plain", "EDGE: ordinary legacy plaintext passes through");

// EDGE: commitment present but blob evicted → dropped, no crash
const orphan = resolveLocalStorageForReplay({ tok: "uhs1:" + "f".repeat(64) }, KEY, store);
ok(Object.keys(orphan).length === 0, "EDGE missing blob → dropped (graceful)");

// ADVERSARIAL: wrong key → cannot reveal → dropped, never leaks
const adversarial = resolveLocalStorageForReplay(sealedNode.page_metadata.localStorage, WRONG, store);
ok(!Object.values(adversarial).includes(SECRET) && Object.keys(adversarial).length === 0, "ADVERSARIAL: wrong key drops keys, secret never leaks");

// idempotency
const reSealed = sealSkillSnapshotHoles(sealed, KEY, CKEY, store);
ok(JSON.stringify(reSealed) === JSON.stringify(sealed), "idempotent: re-sealing an already-sealed skill is a no-op");

console.log(fails === 0 ? "\nALL LOCKSTEP WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
