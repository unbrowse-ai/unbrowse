// Witness (jesus-loop): the pre-fetch unfilled-{hole} guard. An endpoint whose url_template carries
// an unbindable {hole} must BAIL with success:false error:"unfilled_url_hole" BEFORE any network —
// never leaking literal braces to the server. Behavioral (drives the real executeSkill, offline:
// the guard returns before any fetch) + structural, mutation-proven.
// Run: bun bench/capability/test_param_leak_guard.ts
import { readFileSync } from "node:fs";
import { executeSkill } from "../../src/execution/index.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

// A minimal plain-GET skill whose url_template has a hole no param fills. Resolution is upstream of
// executeSkill, so reaching execute with this hole models a genuine miss. No proven_recipe, no auth,
// no body → the call threads straight to interpolate() → the guard, with no network.
const skill: any = {
  skill_id: "sk_guard_test",
  domain: "api.example.test",
  endpoints: [{
    endpoint_id: "ep_holed",
    method: "GET",
    url_template: "https://api.example.test/users/{user_id}/orders/{order_id}",
    semantic: { provides: [], requires: [] },
  }],
};

async function main() {
  // ---- BEHAVIORAL: the guard bails before network ----
  const t0 = Date.now();
  let out: any;
  try {
    out = await executeSkill(skill, { endpoint_id: "ep_holed", intent: "list my orders" });
  } catch (e) {
    ok(false, `executeSkill threw instead of bailing cleanly: ${(e as Error).message}`);
  }
  const ms = Date.now() - t0;
  if (out) {
    ok(out?.trace?.success === false, "holed endpoint → trace.success === false (did NOT execute)");
    ok(out?.trace?.error === "unfilled_url_hole", `bail reason is unfilled_url_hole (got: ${out?.trace?.error})`);
    const unfilled = out?.result?.unfilled ?? [];
    ok(Array.isArray(unfilled) && unfilled.includes("user_id") && unfilled.includes("order_id"),
       `the unfilled holes are named (user_id, order_id) — got ${JSON.stringify(unfilled)}`);
    // The bail's result carries NO HTTP response shape (no status/data from a fetch) → proof the
    // request was never sent. (Timing is not used: local cookie-extraction precedes the guard.)
    ok(out?.result?.status === undefined && out?.trace?.status === undefined,
       "the bail result carries NO HTTP status → no literal-brace request reached the server");
  }

  // ---- STRUCTURAL: the guard is genuinely placed BEFORE the dispatch (recipe/probe) ----
  const src = readFileSync(new URL("../../src/execution/index.ts", import.meta.url), "utf8");
  const guardIdx = src.indexOf('error: "unfilled_url_hole"');
  const recipeIdx = src.indexOf("if (endpoint.proven_recipe && shouldReplayRecipe");
  const probeIdx = src.indexOf("if (!recipeMatched) {");
  ok(guardIdx >= 0, "the unfilled_url_hole guard exists in executeEndpoint");
  ok(guardIdx < recipeIdx && guardIdx < probeIdx, "the guard runs BEFORE the recipe-replay AND the probe ladder (no holed url is ever fetched)");
  ok(/url\.match\(\/\\\{\[a-z0-9_\]\+\\\}\/gi\)/.test(src), "the guard matches the same {hole} class the recipe-skip uses (no new false-positive class)");

  console.log(fails === 0 ? "\n{param}-LEAK GUARD WITNESS PASSES" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main();
