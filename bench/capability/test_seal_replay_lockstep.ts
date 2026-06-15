// Creatures: the live lockstep under real behavior — sealSkillSnapshotHoles (the writeSkillSnapshot
// seal hook) + resolveLocalStorageForReplay (the execution:196 reveal hook). Golden path + 2 edges +
// 1 adversarial (Luke 15:4: chase the failing one). Run: bun bench/capability/test_seal_replay_lockstep.ts
import { sealSkillSnapshotHoles, resolveLocalStorageForReplay } from "../../src/values/storage-hole-bindings.ts";
import { fsSealedBlobStore } from "../../src/values/sealed-blob-store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const store = fsSealedBlobStore(mkdtempSync(join(tmpdir(), "lockstep-")));
const KEY = new Uint8Array(32); for (let i = 0; i < 32; i++) KEY[i] = (i * 17 + 4) & 0xff;
const WRONG = new Uint8Array(32).fill(3);
const SECRET = "csrf-Xy9z-DO-NOT-LEAK";

function skillWithLs(ls: Record<string, string>): any {
  return {
    skill_id: "s1", operation_graph: {
      operations: [{
        operation_id: "op1", endpoint_id: "ep1", method: "GET", url_template: "u",
        action_kind: "read", resource_kind: "d", requires: [], provides: [], confidence: 1,
        page_metadata: { localStorage: ls },
      }],
      edges: [],
    },
  };
}

// ── GOLDEN: seal-at-persist → reveal-at-replay round-trips the real value ──
const sealed = sealSkillSnapshotHoles(skillWithLs({ csrf: SECRET, theme: "dark" }), KEY, store);
const sealedNode = sealed.operation_graph.operations[0];
ok(!JSON.stringify(sealed).includes(SECRET), "GOLDEN: sealed skill snapshot has NO plaintext secret");
ok(/^[0-9a-f]{64}$/.test(sealedNode.page_metadata.localStorage.csrf), "GOLDEN: node localStorage is commitments");
const replayed = resolveLocalStorageForReplay(sealedNode.page_metadata.localStorage, KEY, store);
ok(replayed.csrf === SECRET && replayed.theme === "dark", "GOLDEN: reveal-at-replay restores the original values");

// ── EDGE 1: legacy plaintext node (flag was never on) passes through unchanged ──
const legacy = resolveLocalStorageForReplay({ sessionid: "plain-legacy-value" }, KEY, store);
ok(legacy.sessionid === "plain-legacy-value", "EDGE legacy plaintext passes through unchanged (backward compat)");

// ── EDGE 2: commitment present but blob missing (evicted) → dropped, no crash ──
const orphan = resolveLocalStorageForReplay({ tok: "f".repeat(64) }, KEY, store);
ok(Object.keys(orphan).length === 0, "EDGE missing blob → key dropped (replay degrades gracefully)");

// ── ADVERSARIAL: wrong key at replay → cannot reveal → dropped (no leak, no crash) ──
const adversarial = resolveLocalStorageForReplay(sealedNode.page_metadata.localStorage, WRONG, store);
ok(!Object.values(adversarial).includes(SECRET), "ADVERSARIAL: wrong key cannot reveal — secret never leaks");
ok(Object.keys(adversarial).length === 0, "ADVERSARIAL: wrong-key reveal drops the keys (stays sealed)");

// ── idempotency + no-op safety ──
const reSealed = sealSkillSnapshotHoles(sealed, KEY, store); // already sealed
ok(JSON.stringify(reSealed) === JSON.stringify(sealed), "idempotent: re-sealing an already-sealed skill is a no-op");
const noLs = sealSkillSnapshotHoles({ skill_id: "x", operation_graph: { operations: [], edges: [] } } as any, KEY, store);
ok(!!noLs, "no-localStorage skill seals to a no-op (safe)");

console.log(fails === 0 ? "\nALL LOCKSTEP WITNESSES PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
