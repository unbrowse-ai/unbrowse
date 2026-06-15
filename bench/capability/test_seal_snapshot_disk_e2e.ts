// Dominion: the REAL disk end-to-end through the actual orchestrator writeSkillSnapshot persist path
// (not the helper in isolation). With the flag ON, a snapshot written to disk must carry NO plaintext,
// and reloading it must still reveal the token. Run with an isolated HOME + flags (see runner below).
import { writeSkillSnapshot } from "../../src/orchestrator/index.ts";
import { resolveLocalStorageForReplay } from "../../src/values/storage-hole-bindings.ts";
import { fsSealedBlobStore } from "../../src/values/sealed-blob-store.ts";
import { deriveSealKey } from "../../src/values/signer.ts";
import { readFileSync } from "node:fs";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const SECRET = "localStorage-anti-bot-token-DO-NOT-LEAK-9z";
const sealing = process.env.UNBROWSE_SEAL_STORAGE_HOLES === "1";
const skill: any = {
  skill_id: "s", version: "1", schema_version: "1", name: "n", intent_signature: "i",
  domain: "x.example", description: "d", owner_type: "system", execution_type: "api", lifecycle: {}, endpoints: [],
  operation_graph: { operations: [{
    operation_id: "op1", endpoint_id: "ep1", method: "GET", url_template: "u",
    action_kind: "read", resource_kind: "d", requires: [], provides: [], confidence: 1,
    page_metadata: { localStorage: { abtoken: SECRET } },
  }], edges: [] },
};

const target = writeSkillSnapshot("global:seal-e2e:test", skill);
ok(!!target, "orchestrator persisted the snapshot to disk");
const raw = readFileSync(target!, "utf8");

if (sealing) {
  ok(!raw.includes(SECRET), "FLAG ON: the persisted snapshot file on disk has NO plaintext secret");
  ok(/[0-9a-f]{64}/.test(raw), "FLAG ON: persisted file carries a sha256 commitment");
  const node = JSON.parse(raw).operation_graph.operations[0];
  const revealed = resolveLocalStorageForReplay(node.page_metadata.localStorage, deriveSealKey(), fsSealedBlobStore());
  ok(revealed.abtoken === SECRET, "FLAG ON: reload from the PERSISTED snapshot + reveal restores the original token");
} else {
  ok(raw.includes(SECRET), "FLAG OFF (default): behaviour unchanged — plaintext persists as before");
}

console.log(fails === 0 ? "\nDISK E2E PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
