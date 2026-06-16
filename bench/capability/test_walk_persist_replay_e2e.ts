// Witness (de-hatching residual #3, SOLVED not named): the REAL walkPrerequisiteChain persists a
// prerequisite's yield and REPLAYS it on a later walk — the multi-step cascade end-to-end, deterministic
// (no network: a counting fake execFn is injected via the test seam). Two separate walk invocations
// share the on-disk ledger; the in-memory `executed` Map is fresh each walk, so a replay can only come
// from the PERSISTENT cascade. Run: bun bench/capability/test_walk_persist_replay_e2e.ts
import { walkPrerequisiteChain } from "../../src/orchestrator/index.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

// Unique skill_id per run → an isolated ledger key (no stale cross-run collision).
const uniq = `e2e-walk-${process.pid}-${process.hrtime.bigint?.() ?? ""}`;
const skill: any = {
  skill_id: uniq,
  domain: "example.test",
  endpoints: [
    { endpoint_id: "prereq_a", method: "GET", url_template: "https://example.test/a",
      semantic: { auth_required: false, provides: [{ key: "author" }], requires: [] } },
    { endpoint_id: "target_b", method: "GET", url_template: "https://example.test/b/{author}",
      semantic: { auth_required: false, provides: [], requires: [{ key: "author", required: true }] } },
  ],
  operation_graph: {
    operations: [
      { operation_id: "op_a", endpoint_id: "prereq_a", provides: ["author"], requires: [] },
      { operation_id: "op_b", endpoint_id: "target_b", provides: [], requires: ["author"] },
    ],
    edges: [{ from_operation_id: "op_a", to_operation_id: "op_b", binding_key: "author" }],
  },
};

// Counting fake execution: returns a STABLE public yield (so the content pointer is stable → replayable).
let calls = 0;
const fakeExec: any = async (_sk: any, params: any) => {
  calls++;
  ok(params.endpoint_id === "prereq_a", `execFn runs the PREREQ (got ${params.endpoint_id})`);
  return { trace: { success: true }, result: { author: "Yours Truly" } };
};

async function main() {
  // The cascade is ON by default (prereqCacheTtlMs → 600000 unless UNBROWSE_STATELESS). Ensure not stateless.
  delete process.env.UNBROWSE_STATELESS;

  const steps1: any[] = [];
  const r1 = await walkPrerequisiteChain(skill, ["author"], ["prereq_a"], {}, "echo the author", undefined, { intent: "echo the author" } as any, steps1, "target_b", fakeExec);
  ok(r1.author === "Yours Truly", "walk 1 resolves target_b's {author} hole from prereq_a's yield");
  const after1 = calls;
  ok(after1 === 1, `walk 1 EXECUTED the prereq once (cold miss) — calls=${after1}`);

  // Walk 2: a fresh invocation (fresh in-memory `executed` Map) sharing the on-disk ledger.
  const steps2: any[] = [];
  const r2 = await walkPrerequisiteChain(skill, ["author"], ["prereq_a"], {}, "echo the author", undefined, { intent: "echo the author" } as any, steps2, "target_b", fakeExec);
  ok(r2.author === "Yours Truly", "walk 2 also resolves the hole (same value)");
  ok(calls === after1, `walk 2 did NOT re-execute the prereq — REPLAYED from the persistent ledger (calls still ${calls})`);

  console.log(fails === 0 ? "\nWALK PERSIST+REPLAY E2E WITNESS PASSES" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main();
