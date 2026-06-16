// Dominion: the WHOLE surface at once — buildSkillOperationGraph (DAG + producer→consumer edge) →
// writeSkillSnapshot (seal value off-graph) → reload + reveal. The integration question: does the DAG
// EDGE survive sealing while the value is sealed? Run with isolated HOME + flags (see runner).
import { buildSkillOperationGraph } from "../../src/lib/graph-core/index.ts";
import { writeSkillSnapshot } from "../../src/orchestrator/index.ts";
import { resolveLocalStorageForReplay } from "../../src/values/storage-hole-bindings.ts";
import { fsSealedBlobStore } from "../../src/values/sealed-blob-store.ts";
import { deriveSealKey } from "../../src/values/signer.ts";
import { readFileSync } from "node:fs";
// storage persist is gated by UNBROWSE_LOCAL_CACHES (read call-time); enable it for this disk e2e.
process.env.UNBROWSE_LOCAL_CACHES = "1";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

const SECRET = "anti-bot-session-token-DO-NOT-LEAK-q7";
const sealing = process.env.UNBROWSE_SEAL_STORAGE_HOLES === "1";

// 1. BUILD: a real graph from endpoints + captured localStorage → DAG with the login→feed edge
const endpoints: any = [
  { endpoint_id: "login", url_template: "https://x.example/login", method: "POST", semantic: {} },
  { endpoint_id: "feed", url_template: "https://x.example/feed", method: "GET", query: { sessionId: "{sessionId}" }, semantic: {} },
];
const graph = buildSkillOperationGraph(endpoints, { localStorage: { sessionId: SECRET } });
const builtEdge = (graph.edges ?? []).some((e: any) => e.from_operation_id === "login" && e.to_operation_id === "feed" && e.binding_key === "sessionId");
ok(builtEdge, "BUILD: producer→consumer edge (login→feed:sessionId) present in the freshly built graph");

const skill: any = {
  skill_id: "s", version: "1", schema_version: "1", name: "n", intent_signature: "i",
  domain: "x.example", description: "d", owner_type: "system", execution_type: "api", lifecycle: {}, endpoints,
  operation_graph: graph,
};

// 2. PERSIST: writeSkillSnapshot seals the value off-graph
const target = writeSkillSnapshot("global:ac3-seal-e2e", skill);
ok(!!target, "PERSIST: snapshot written to disk");
const raw = readFileSync(target!, "utf8");
const persisted = JSON.parse(raw);

// 3. THE INTEGRATION CHECK: the DAG edge SURVIVES sealing
const edgeSurvives = (persisted.operation_graph.edges ?? []).some((e: any) =>
  e.from_operation_id === "login" && e.to_operation_id === "feed" && e.binding_key === "sessionId");
ok(edgeSurvives, "INTEGRATION: the login→feed sessionId DAG edge SURVIVES the seal step");

if (sealing) {
  ok(!raw.includes(SECRET), "FLAG ON: no plaintext secret on the persisted snapshot (value sealed off-graph)");
  const feedNode = persisted.operation_graph.operations.find((o: any) => o.endpoint_id === "login") ?? persisted.operation_graph.operations[0];
  const lsVal = feedNode.page_metadata?.localStorage?.sessionId;
  ok(typeof lsVal === "string" && lsVal.startsWith("uhs1:"), "FLAG ON: node localStorage holds a keyed commitment, not plaintext");
  // 4. reveal round-trip
  const revealed = resolveLocalStorageForReplay(feedNode.page_metadata.localStorage, deriveSealKey(), fsSealedBlobStore());
  ok(revealed.sessionId === SECRET, "FLAG ON: reload + reveal restores the original token (edge structure shared, secret held by holder)");
} else {
  ok(raw.includes(SECRET), "FLAG OFF (default): plaintext persists as before (behaviour unchanged)");
}

console.log(fails === 0 ? "\nAC3+SEAL E2E PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
