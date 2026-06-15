// Luminary for the Step-3 seed: a DIRECT sign that operation_graph reaches the POST body of the rank
// request — not a tsc inference. Stubs global fetch, captures the body rankEndpointsRemote sends.
// Run: bun bench/capability/test_rank_remote_operation_graph.ts
process.env.UNBROWSE_LOCAL_ONLY = "0"; // force the remote path (else rankEndpointsRemote returns null early)
process.env.UNBROWSE_API_KEY = process.env.UNBROWSE_API_KEY || "test-key-witness";
import { rankEndpointsRemote } from "../../src/client/index.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

let captured: any = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: any, init: any) => {
  captured = init?.body ? JSON.parse(init.body as string) : null;
  return new Response(JSON.stringify({ ranked: [], degraded: false }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}) as any;

const eps = [{ endpoint_id: "feed", method: "GET", url_template: "https://x.example/feed" }];
const graph = { operations: [{ endpoint_id: "feed" }], edges: [] };

try {
  // 1. WITH a graph → the body carries operation_graph (the seed reaches the wire)
  captured = null;
  await rankEndpointsRemote("list my feed", eps, "x.example", undefined, graph);
  ok(!!captured, "remote path issued a request (body captured)");
  ok(!!captured?.operation_graph && Array.isArray(captured.operation_graph.operations),
     `body CARRIES operation_graph when sent (operations present)`);

  // 2. WITHOUT a graph → no operation_graph key (additive; older servers / no-graph skills unaffected)
  captured = null;
  await rankEndpointsRemote("list my feed", eps, "x.example");
  ok(!!captured && !("operation_graph" in captured), "body OMITS operation_graph when not sent (additive, non-regressive)");

  // 3. the always-present fields are still there (we didn't break the existing body)
  ok(captured && "endpoints" in captured && "skill_domain" in captured && "intent" in captured,
     "body still carries the existing fields (intent/endpoints/skill_domain)");
} finally {
  globalThis.fetch = realFetch;
}

console.log(fails === 0 ? "\nRANK-REMOTE OPERATION_GRAPH WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
