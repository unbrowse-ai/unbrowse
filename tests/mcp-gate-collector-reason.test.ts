// Falsifier for Bug 1 in the 2026-05-18 MCP gate run `20260518T092341Z`:
// scripts/mcp-gate-parallel-collect.ts:105 used
//   reason: cb.indexed ? "indexed" : (cb.next_step ?? cb._go_failed ? "go_failed" : "capture_did_not_emit_skill_id")
// which JS parses as `(cb.next_step ?? cb._go_failed) ? "go_failed" : ...`.
// `cb.next_step` is ALWAYS truthy on a successful close (the close
// handler in src/api/routes.ts uses buildCheckpointNextStep to emit a
// prose hint), so the unindexed-but-go-succeeded path always rendered
// as "go_failed" — poisoning the verdict reasoning across 8 judges.
//
// The three honest close-body shapes after the fix:
//   indexed=true                                   -> "indexed"
//   indexed=false + _go_failed set                 -> "go_failed"
//   indexed=false + no _go_failed (next_step prose) -> "capture_did_not_emit_skill_id"
import { describe, expect, it } from "bun:test";
import { classifyReason, pickSkillId } from "../scripts/mcp-gate-parallel-classify.ts";

describe("classifyReason — collector reason precedence (Bug 1 / run 20260518T092341Z)", () => {
  it("indexed=true wins regardless of other fields", () => {
    expect(classifyReason({ indexed: true })).toBe("indexed");
    expect(classifyReason({ indexed: true, _go_failed: { status: 500 } } as any)).toBe("indexed");
  });

  it("_go_failed only fires when go did NOT return 200 (set at collect site L69)", () => {
    expect(classifyReason({ indexed: false, _go_failed: { status: 500, body: {} } } as any)).toBe("go_failed");
  });

  it("the bug case: close succeeded, snap landed, but indexed=false -> capture_did_not_emit_skill_id", () => {
    // Pre-fix this returned "go_failed" because close always populates next_step
    // with a prose hint from buildCheckpointNextStep. Real shape from run
    // 20260518T092341Z probe 002 npmjs / 003 crates.io / 010 dockerhub / etc.
    const realClosePayload = {
      ok: true,
      checkpointed: true,
      indexed: false,
      mode: "skipped_no_capture",
      endpoint_count: 0,
      request_count: 0,
      auth_saved: null,
      next_step: "Final checkpoint recorded, but no new capture was available to index or publish.",
    };
    expect(classifyReason(realClosePayload as any)).toBe("capture_did_not_emit_skill_id");
  });

  it("empty close body (e.g. unexpected error before close emitted any fields) -> capture_did_not_emit_skill_id", () => {
    expect(classifyReason({})).toBe("capture_did_not_emit_skill_id");
  });
});

describe("pickSkillId — cross-skill carry-over guard (Bug 3 / run 20260518T092341Z)", () => {
  it("close.skill_id wins regardless of resolve trace state", () => {
    const cb = { skill_id: "khTcB4neLqAQivzTwVyiP" };
    const post2 = { status: "no_match", trace: { skill_id: "SIBLING_LEAK_ID" } };
    const pre = { status: "no_match", trace: { skill_id: "ANOTHER_SIBLING" } };
    expect(pickSkillId(cb, post2, pre)).toBe("khTcB4neLqAQivzTwVyiP");
  });

  it("the bug case: post2 is no_match but carries a sibling probe's trace.skill_id -> reject", () => {
    // Real shape from run 20260518T092341Z probes 036 Gmail / 040 Drive.
    // src/orchestrator/index.ts:3743 emits `status: "no_match"` alongside
    // a `probeTrace` whose skill_id can be a sibling capture's id when
    // broker state crosses sessions. Borrowing it cross-binds skills.
    const cb = {};
    const post2NoMatchWithLeakedTrace = {
      status: "no_match",
      tried: ["http_probe"],
      ms: 421,
      next_step: "no usable endpoint — try unbrowse_go to capture",
      trace: { skill_id: "khTcB4neLqAQivzTwVyiP" }, // Google-Finance from probe 034
    };
    expect(pickSkillId(cb, post2NoMatchWithLeakedTrace, undefined)).toBe(null);
  });

  it("post2 matched (status != no_match) AND has trace.skill_id -> adopt it", () => {
    const cb = {};
    const post2Match = { status: "ok", trace: { skill_id: "REAL_SKILL_ID" } };
    expect(pickSkillId(cb, post2Match, undefined)).toBe("REAL_SKILL_ID");
  });

  it("post2 has no trace, pre has trace but is no_match -> null (no fallback to pre's leak)", () => {
    const cb = {};
    const post2NoMatchNoTrace = { status: "no_match" };
    const preNoMatchWithLeak = { status: "no_match", trace: { skill_id: "PRE_LEAK" } };
    expect(pickSkillId(cb, post2NoMatchNoTrace, preNoMatchWithLeak)).toBe(null);
  });

  it("pre matched (status != no_match) is honored when post2 has nothing", () => {
    const cb = {};
    const post2NoMatch = { status: "no_match" };
    const preMatch = { status: "ok", trace: { skill_id: "PRE_REAL" } };
    expect(pickSkillId(cb, post2NoMatch, preMatch)).toBe("PRE_REAL");
  });

  it("absent post2/pre bodies (e.g. resolve threw) -> null, no crash", () => {
    expect(pickSkillId({}, undefined, undefined)).toBe(null);
  });

  it("empty-string trace.skill_id is not adopted (treated as not declared)", () => {
    const post2 = { status: "ok", trace: { skill_id: "" } };
    expect(pickSkillId({}, post2, undefined)).toBe(null);
  });
});
