// Real-runtime falsifier for /v1/browse/go at conc=N pipeline completion.
//
// Existing tests/.bench-gate/parallel-isolation-falsifier.sh covers cross-tab
// BINDING isolation (probe A's tab doesn't render probe B's host) at N<=4.
// It does NOT verify "every concurrent go succeeds with a session_id" —
// the failure mode surfaced in MCP gate run 20260518T115632Z where 13+ of
// 58 probes returned `index.store.json.reason="go_failed"` at conc=6
// because /v1/browse/go itself returned non-200 / no session_id.
//
// This test fires N concurrent calls and asserts every one returns 200 +
// session_id within budget. Uses real getInProcessApp + real kuri broker
// (no mocks). Run via `bun test tests/browse-go-conc-pipeline.test.ts`.
//
// Stays under the verified-clean band documented in CLAUDE.md (N<=6) but
// pinned tighter: every concurrent call MUST succeed, not just "no tab
// cross-binding." If this falsifier breaks, the kuri broker allocation
// path has a race that conc-N production runs would hit.
import { describe, expect, it } from "bun:test";
import { getInProcessApp } from "../src/runtime/in-process-app.ts";

const app = await getInProcessApp();
const HDR = { "content-type": "application/json", "x-unbrowse-client-id": "conc-pipeline-test" };
const TARGET = "https://example.com/";

async function callGo(sessionId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/browse/go",
    headers: HDR,
    payload: JSON.stringify({ url: TARGET, session_id: sessionId }),
  });
  let body: any = {};
  try { body = JSON.parse(res.body); } catch { body = { _raw: res.body?.slice(0, 200) }; }
  return { status: res.statusCode, session_id: body.session_id, tab_id: body.tab_id, error: body.error ?? body.error_code ?? null };
}

// No afterAll cleanup: 11+ concurrent closes against real kuri brokers
// regularly exceed the 5-second default hook budget even in parallel
// (kuri's closeTab + broker shutdown is multi-second per call). The
// assertions are what matter; bun's process exit reaps the chrome
// processes and the test does not write any state outside ~/.unbrowse/.


describe("/v1/browse/go @ concurrent pipeline completion (gate run 20260518T115632Z)", () => {
  it("N=1 single go returns 200 + session_id", async () => {
    const sid = `conc-pipeline-N1-${Date.now()}`;
    const r = await callGo(sid);
    // session is intentionally not closed; bun's process exit reaps it.
    expect(r.status).toBe(200);
    expect(typeof r.session_id).toBe("string");
    expect(r.session_id?.length).toBeGreaterThan(0);
    expect(r.error).toBe(null);
  }, 60_000);

  it("N=4 concurrent gos all return 200 + distinct session_ids (verified-clean band)", async () => {
    const stamp = Date.now();
    const results = await Promise.all([
      callGo(`conc-pipeline-N4-A-${stamp}`),
      callGo(`conc-pipeline-N4-B-${stamp}`),
      callGo(`conc-pipeline-N4-C-${stamp}`),
      callGo(`conc-pipeline-N4-D-${stamp}`),
    ]);
    // sessions are intentionally not closed; bun's process exit reaps them.
    const failures = results.filter((r) => r.status !== 200 || !r.session_id);
    expect(failures).toEqual([]);
    const sids = results.map((r) => r.session_id);
    expect(new Set(sids).size).toBe(4);
  }, 120_000);

  it("N=6 concurrent gos all return 200 + distinct session_ids (the gate-run conc)", async () => {
    const stamp = Date.now();
    const results = await Promise.all([
      callGo(`conc-pipeline-N6-A-${stamp}`),
      callGo(`conc-pipeline-N6-B-${stamp}`),
      callGo(`conc-pipeline-N6-C-${stamp}`),
      callGo(`conc-pipeline-N6-D-${stamp}`),
      callGo(`conc-pipeline-N6-E-${stamp}`),
      callGo(`conc-pipeline-N6-F-${stamp}`),
    ]);
    // sessions are intentionally not closed; bun's process exit reaps them.
    const failures = results.filter((r) => r.status !== 200 || !r.session_id);
    if (failures.length > 0) {
      // surface the first failure verbatim so the agent reading the test
      // output sees exactly which kuri / broker error fired
      const sample = JSON.stringify(failures[0]);
      throw new Error(`N=6 conc pipeline regression: ${failures.length}/6 go() calls failed. First failure: ${sample}`);
    }
    expect(failures).toEqual([]);
    const sids = results.map((r) => r.session_id);
    expect(new Set(sids).size).toBe(6);
  }, 180_000);
});
