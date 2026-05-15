import { describe, expect, test } from "bun:test";
import { addResolveMissGuidance } from "../src/mcp.js";

// Regression probe: orchestrator/index.ts (lines 3651, 3681, ~3551) returns
// `result.status = "no_match"` on its real cold-resolve miss path, but
// addResolveMissGuidance in src/mcp.ts only branches on "no_cached_match".
// The result: MCP agents calling unbrowse_resolve against a brand-new
// public URL get back a CLI-shaped `next_step.command: "unbrowse capture
// --url ..."` and NO root-level `next_action`. They have no MCP-dispatchable
// hint and have to guess the equivalent (`unbrowse_resolve` with
// `force_capture:true` or `unbrowse_go`).
//
// Live probe that found this (arxiv.org/abs/2305.07759):
//   unbrowse_resolve -> {"result":{"status":"no_match", ...,
//     "next_step":{"command":"unbrowse capture --url \"...\" --intent \"...\"",
//                  "est_ms":8000,"creates_skill":true}, ...},
//     ... }
// No `next_action` at the response root. Agent has to invent the next move.
//
// Acceptance: addResolveMissGuidance must treat "no_match" and "not_found"
// as miss statuses too, and emit `next_action: { command: "unbrowse_go", ...}`
// when a `url` is present in args or in the nested result.

describe("addResolveMissGuidance — orchestrator no_match status", () => {
  test("status: 'no_match' with url emits unbrowse_go next_action", () => {
    const out = addResolveMissGuidance(
      {
        result: {
          status: "no_match",
          tried: ["marketplace", "probe"],
          ms: 42,
          next_step: {
            command: 'unbrowse capture --url "https://arxiv.org/abs/2305.07759" --intent "get paper"',
            est_ms: 8000,
            creates_skill: true,
          },
        },
      },
      {
        intent: "get arxiv paper abstract and metadata",
        url: "https://arxiv.org/abs/2305.07759",
      },
    ) as Record<string, unknown>;

    expect(out.next_action, "no_match must emit a dispatchable next_action").toBeObject();
    const na = out.next_action as Record<string, unknown>;
    expect(na.command).toBe("unbrowse_go");
    const args = na.command_args as Record<string, unknown>;
    expect(args.url).toBe("https://arxiv.org/abs/2305.07759");
  });

  test("status: 'not_found' with url emits unbrowse_go next_action", () => {
    const out = addResolveMissGuidance(
      {
        result: {
          status: "not_found",
          message: "no skill registered for that domain",
        },
      },
      {
        intent: "anything",
        url: "https://example.com/x",
      },
    ) as Record<string, unknown>;

    expect(out.next_action).toBeObject();
    const na = out.next_action as Record<string, unknown>;
    expect(na.command).toBe("unbrowse_go");
    expect((na.command_args as Record<string, unknown>).url).toBe("https://example.com/x");
  });

  test("status: 'no_cached_match' still emits next_action (regression guard)", () => {
    const out = addResolveMissGuidance(
      {
        result: {
          status: "no_cached_match",
          url: "https://eatigo.com/sg/singapore",
        },
      },
      {
        intent: "find food",
        url: "https://eatigo.com/sg/singapore",
      },
    ) as Record<string, unknown>;

    expect(out.next_action).toBeObject();
    const na = out.next_action as Record<string, unknown>;
    expect(na.command).toBe("unbrowse_go");
  });

  test("status: 'no_match' without url omits next_action (undispatchable)", () => {
    // Mirrors the no_cached_match without-url contract: unbrowse_go requires
    // a real url. Better to omit next_action than promise an undispatchable
    // call. The prose hint in result.next_step still guides verbally.
    const out = addResolveMissGuidance(
      {
        result: { status: "no_match" },
      },
      { intent: "anything" },
    ) as Record<string, unknown>;

    expect(out.next_action).toBeUndefined();
  });

  test("status: 'ok' (cached hit) is a no-op", () => {
    const out = addResolveMissGuidance(
      { result: { status: "ok", endpoints: [{ id: "ep1" }] } },
      { intent: "anything" },
    ) as Record<string, unknown>;

    expect(out.next_action).toBeUndefined();
  });
});
