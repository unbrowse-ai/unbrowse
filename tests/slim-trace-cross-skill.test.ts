/**
 * slim-trace-cross-skill.test — the CLI's slimTrace allowlist must pass through the
 * cross-skill DAG suggestion (else the CLI agent never sees "run skill B first").
 */
import { describe, expect, it } from "bun:test";
import { slimTrace } from "../src/cli.js";

describe("slimTrace preserves cross_skill_producers", () => {
  it("passes the suggestion through (non-empty)", () => {
    const out = slimTrace({
      trace: { trace_id: "t", success: false },
      result: { error: "missing_param" },
      cross_skill_producers: [{ hole: "postId", producers: [{ skill_id: "blog", endpoint_id: "create_post" }] }],
    });
    expect(out.cross_skill_producers).toEqual([
      { hole: "postId", producers: [{ skill_id: "blog", endpoint_id: "create_post" }] },
    ]);
  });
  it("omits it when empty/absent", () => {
    expect("cross_skill_producers" in slimTrace({ trace: { trace_id: "t" } })).toBe(false);
    expect("cross_skill_producers" in slimTrace({ trace: { trace_id: "t" }, cross_skill_producers: [] })).toBe(false);
  });
});
