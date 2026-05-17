import { describe, expect, test } from "bun:test";
import { addGoNextStepHints, SESSION_TOOL_NAMES } from "../src/mcp.js";

// Root cause (gate run .bench-gate/20260517T111902Z): unbrowse_go opens a
// browse session and flips SESSION_TOOL_NAMES visible via
// notifications/tools/list_changed, but its RESULT carried no next_action /
// _workflow_hints. An agent that does not re-list tools after the
// notification never discovers unbrowse_close, so the
// capture->enrichment->index pipeline never fires and non-cached routes
// resolve no_match. The substrate must SURFACE what just became callable
// (parity with addExecuteNextStepHints / addCaptureNextStepHints), not rely
// on a prescribed procedure baked into the caller's prompt.
//
// Self-contained: tests/mcp-next-action-shape.test.ts is RED at branch HEAD
// for an unrelated pre-existing reason (it imports addResolveHitGuidance,
// which has never existed in src/mcp.ts). This file imports only the symbols
// this fix introduces, so it loads and runs independently.

type NextAction = {
  title: string;
  command: string;
  command_args: Record<string, unknown>;
  why: string;
};

function asNextAction(value: unknown): NextAction {
  expect(value, "next_action must be a plain object").toBeObject();
  const obj = value as Record<string, unknown>;
  expect(obj.title, "next_action.title must be a non-empty string").toBeString();
  expect((obj.title as string).length).toBeGreaterThan(0);
  expect(obj.command, "next_action.command must be a string MCP tool name").toBeString();
  expect((obj.command as string)).toStartWith("unbrowse_");
  expect(obj.command_args, "next_action.command_args must be a plain object").toBeObject();
  expect(obj.why, "next_action.why must be a non-empty string").toBeString();
  expect((obj.why as string).length).toBeGreaterThan(0);
  return obj as NextAction;
}

describe("addGoNextStepHints: session-open tool-availability surfacing", () => {
  test("session-open result emits a dispatchable next_action + _workflow_hints", () => {
    const out = addGoNextStepHints(
      { result: { ok: true, session_id: "sess_go_1", har_active: true } },
      { url: "https://news.ycombinator.com/" },
    ) as Record<string, unknown>;

    const na = asNextAction(out.next_action);
    // command is a literal session-scoped MCP tool name (callable right now).
    expect(SESSION_TOOL_NAMES.has(na.command)).toBe(true);
    expect(out._workflow_hints, "_workflow_hints must be present").toBeObject();
  });

  test("surfaces the now-available session tools derived from SESSION_TOOL_NAMES (not a re-typed list)", () => {
    const out = addGoNextStepHints(
      { result: { ok: true, session_id: "sess_go_2" } },
      { url: "https://example.com/" },
    ) as Record<string, unknown>;
    const hints = out._workflow_hints as Record<string, unknown>;
    const avail = hints.session_tools_now_available as string[];
    expect(Array.isArray(avail)).toBe(true);
    // Exactly the declared set; falsifies any hand-typed drift.
    expect(new Set(avail)).toEqual(SESSION_TOOL_NAMES);
    expect(avail).toContain("unbrowse_close");
    expect(avail).toContain("unbrowse_snap");
  });

  test("the close->index requirement is stated so a non-relisting agent still learns it", () => {
    const out = addGoNextStepHints(
      { result: { ok: true } },
      { url: "https://example.com/" },
    ) as Record<string, unknown>;
    const hints = out._workflow_hints as Record<string, unknown>;
    const blob = JSON.stringify(hints).toLowerCase();
    expect(blob).toContain("unbrowse_close");
    expect(blob).toContain("index");
  });

  test("session_id from the go result is threaded into command_args (parallel-session dispatchable)", () => {
    const out = addGoNextStepHints(
      { result: { ok: true, session_id: "sess_go_42" } },
      { url: "https://example.com/" },
    ) as Record<string, unknown>;
    const na = out.next_action as Record<string, unknown>;
    expect((na.command_args as Record<string, unknown>).session_id).toBe("sess_go_42");
  });

  test("no session_id -> command_args is {} (no placeholder leak)", () => {
    const out = addGoNextStepHints(
      { result: { ok: true } },
      { url: "https://example.com/" },
    ) as Record<string, unknown>;
    const na = out.next_action as Record<string, unknown>;
    for (const v of Object.values(na.command_args as Record<string, unknown>)) {
      if (typeof v === "string") expect(v).not.toContain("<");
    }
  });

  test("non-object result is returned untouched (parity with addCaptureNextStepHints)", () => {
    expect(addGoNextStepHints("not-an-object" as unknown, {})).toBe("not-an-object");
  });
});
