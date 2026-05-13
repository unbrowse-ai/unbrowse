import { describe, expect, test } from "bun:test";
import {
  addCaptureNextStepHints,
  addExecuteNextStepHints,
  addResolveHitGuidance,
  addResolveMissGuidance,
} from "../src/mcp.js";

// Spec for Phase 1 of docs/mcp-ux-fix-plan.md:
//   Every MCP result that carries _workflow_hints MUST also carry a root-level
//   next_action: { title, command, command_args, why }.
//   - command is a literal MCP tool name (e.g. "unbrowse_review")
//   - command_args is a JSON object dispatchable via tools/call
//   - _workflow_hints stays byte-identical (back-compat)

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

describe("addExecuteNextStepHints — Phase 1 next_action shape", () => {
  test("emits next_action to call unbrowse_feedback with skill + endpoint", () => {
    const out = addExecuteNextStepHints(
      { result: { description: "Captured search endpoint" } },
      { skill: "sk_eatigo_search", endpoint: "ep_search_by_location" },
    ) as Record<string, unknown>;

    const na = asNextAction(out.next_action);
    expect(na.command).toBe("unbrowse_feedback");
    expect(na.command_args.skill).toBe("sk_eatigo_search");
    expect(na.command_args.endpoint).toBe("ep_search_by_location");

    // _workflow_hints back-compat: must still be present
    expect(out._workflow_hints, "_workflow_hints must remain for back-compat").toBeObject();
  });
});

describe("addCaptureNextStepHints — Phase 1 next_action shape (Aiko's eatigo failure mode)", () => {
  test("close/sync result emits next_action to call unbrowse_review", () => {
    const out = addCaptureNextStepHints(
      { result: { skill_id: "sk_eatigo_chinatown_listing", session_id: "sess_123" } },
      { session_id: "sess_123" },
    ) as Record<string, unknown>;

    const na = asNextAction(out.next_action);
    expect(na.command).toBe("unbrowse_review");
    expect(na.command_args.skill).toBe("sk_eatigo_chinatown_listing");

    // _workflow_hints back-compat
    expect(out._workflow_hints, "_workflow_hints must remain for back-compat").toBeObject();
  });

  test("missing skill_id still produces a valid next_action (no placeholder ids)", () => {
    const out = addCaptureNextStepHints(
      { result: { session_id: "sess_999" } },
      { session_id: "sess_999" },
    ) as Record<string, unknown>;

    const na = asNextAction(out.next_action);
    expect(na.command).toBe("unbrowse_review");
    // command_args may be empty {} but must not contain "<skill-id>" placeholders
    for (const v of Object.values(na.command_args)) {
      if (typeof v === "string") expect(v).not.toContain("<");
    }
  });
});

describe("addResolveMissGuidance — Phase 1 next_action shape", () => {
  test("no_cached_match emits next_action to call unbrowse_go with the target url", () => {
    const out = addResolveMissGuidance(
      {
        result: {
          status: "no_cached_match",
          message: "No cached endpoint matched this intent yet.",
          url: "https://eatigo.com/sg/singapore",
        },
      },
      {
        intent: "find me food on eatigo at 54a pagoda street",
        url: "https://eatigo.com/sg/singapore",
      },
    ) as Record<string, unknown>;

    const na = asNextAction(out.next_action);
    expect(na.command).toBe("unbrowse_go");
    expect(na.command_args.url).toBe("https://eatigo.com/sg/singapore");
  });

  test("cached match (status != no_cached_match) does NOT emit next_action from this function", () => {
    const out = addResolveMissGuidance(
      { result: { status: "ok", endpoints: [{ id: "ep1" }] } },
      { intent: "anything" },
    ) as Record<string, unknown>;
    // addResolveMissGuidance is a no-op for non-miss results;
    // next_action is added by addExecuteNextStepHints downstream.
    expect(out.next_action).toBeUndefined();
  });

  test("status no_match (orchestrator's real emission) also fires next_action", () => {
    const out = addResolveMissGuidance(
      { result: { status: "no_match", url: "https://news.ycombinator.com" } },
      { intent: "get top stories", url: "https://news.ycombinator.com" },
    ) as Record<string, unknown>;
    const na = asNextAction(out.next_action);
    expect(na.command).toBe("unbrowse_go");
    expect(na.command_args.url).toBe("https://news.ycombinator.com");
  });

  test("status not_found also fires next_action", () => {
    const out = addResolveMissGuidance(
      { result: { status: "not_found", url: "https://example.com/x" } },
      { intent: "anything", url: "https://example.com/x" },
    ) as Record<string, unknown>;
    const na = asNextAction(out.next_action);
    expect(na.command).toBe("unbrowse_go");
  });
});

// ─── Edges + adversarial (Step 5) ───────────────────────────────────────────

describe("edges: missing fields must NOT leak placeholders into command_args", () => {
  test("execute with no skill at all → command_args is {} (not '<skill-id>')", () => {
    const out = addExecuteNextStepHints(
      { result: { description: "Captured search endpoint" } },
      {}, // no skill, no endpoint
    ) as Record<string, unknown>;
    const na = out.next_action as Record<string, unknown>;
    expect(na.command).toBe("unbrowse_feedback");
    const args = na.command_args as Record<string, unknown>;
    // No keys is correct; placeholder strings are wrong.
    for (const v of Object.values(args)) {
      if (typeof v === "string") {
        expect(v).not.toContain("<");
        expect(v).not.toContain("TODO");
      }
    }
  });

  test("resolve miss with only domain (no url) → next_action OMITTED (undispatchable)", () => {
    // Cold-read finding from Step 8: unbrowse_go requires `url` per its input schema.
    // If we only have a domain, emitting next_action would promise an undispatchable
    // call. Better: omit next_action and let the prose hint (result.result.next_step)
    // guide the agent verbally. Acceptance criterion #3: "use real values from the
    // result" — if no real url, no next_action.
    const out = addResolveMissGuidance(
      { result: { status: "no_cached_match", domain: "eatigo.com" } },
      { intent: "find food", domain: "eatigo.com" },
    ) as Record<string, unknown>;
    expect(out.next_action).toBeUndefined();
    // Prose hint still guides the agent (back-compat).
    const nested = out.result as Record<string, unknown>;
    expect(typeof nested.next_step).toBe("string");
  });

  test("resolve miss with neither url nor domain → next_action OMITTED", () => {
    const out = addResolveMissGuidance(
      { result: { status: "no_cached_match" } },
      { intent: "find food" },
    ) as Record<string, unknown>;
    expect(out.next_action).toBeUndefined();
  });
});

describe("adversarial: malformed inputs", () => {
  test("execute where args.skill is a non-string (number) → command_args.skill absent", () => {
    const out = addExecuteNextStepHints(
      { result: { description: "x" } },
      { skill: 42 as unknown as string, endpoint: "ep_x" },
    ) as Record<string, unknown>;
    const na = out.next_action as Record<string, unknown>;
    const args = na.command_args as Record<string, unknown>;
    // Non-string skill silently dropped (matches existing addExecuteNextStepHints behavior at line 645)
    expect(args.skill).toBeUndefined();
    expect(args.endpoint).toBe("ep_x");
  });

  test("capture where result already has a next_action field → ours wins (spread order)", () => {
    const out = addCaptureNextStepHints(
      {
        result: { skill_id: "sk_real" },
        next_action: { command: "unbrowse_stale_old_thing", command_args: {}, title: "old", why: "old" },
      },
      {},
    ) as Record<string, unknown>;
    const na = out.next_action as Record<string, unknown>;
    // Our spread sits AFTER ...result, so we overwrite. Verify the new value wins.
    expect(na.command).toBe("unbrowse_review");
    expect((na.command_args as Record<string, unknown>).skill).toBe("sk_real");
  });

  test("execute with explicit null skill in args + skill_id at root → command_args.skill === root skill_id", () => {
    // resolveSkillId checks value.skill_id (root) and value.skill.skill_id (nested under .skill),
    // but NOT value.result.skill_id. Document this behavior so a future refactor knows
    // the unwrap pattern is asymmetric.
    const out = addExecuteNextStepHints(
      { skill_id: "sk_fallback", result: { description: "x" } }, // skill_id at ROOT, not under .result
      { skill: null as unknown as string, endpoint: "ep_y" },
    ) as Record<string, unknown>;
    const na = out.next_action as Record<string, unknown>;
    const args = na.command_args as Record<string, unknown>;
    expect(args.skill).toBe("sk_fallback");
    expect(args.endpoint).toBe("ep_y");
    // The null was never written as null — it was filtered by typeof !== "string" upstream.
    expect(args.skill).not.toBeNull();
  });

  test("execute with skill_id only NESTED under .result → resolveSkillId returns undefined (asymmetric unwrap)", () => {
    // This documents the resolveSkillId surprise: it does NOT recurse into .result.
    const out = addExecuteNextStepHints(
      { result: { description: "x", skill_id: "sk_nested_only" } },
      { skill: null as unknown as string, endpoint: "ep_y" },
    ) as Record<string, unknown>;
    const na = out.next_action as Record<string, unknown>;
    const args = na.command_args as Record<string, unknown>;
    // command_args.skill is absent because resolveSkillId only checks root-level skill_id.
    // The placeholder-leak check still passes: no "<…>" string, just an absent key.
    expect(args.skill).toBeUndefined();
    expect(args.endpoint).toBe("ep_y");
  });
});

describe("addResolveHitGuidance — happy-path shortlist", () => {
  test("shortlist with skill + endpoint_id emits next_action to call unbrowse_execute", () => {
    const out = addResolveHitGuidance(
      {
        available_endpoints: [
          { endpoint_id: "ep_top", description: "Top candidate description" },
        ],
        skill: { skill_id: "sk_one" },
      },
      { intent: "anything" },
    ) as Record<string, unknown>;

    const na = asNextAction(out.next_action);
    expect(na.command).toBe("unbrowse_execute");
    expect(na.command_args.skill).toBe("sk_one");
    expect(na.command_args.endpoint).toBe("ep_top");
  });

  test("already-set next_action is preserved (miss-path wins, hit-path is a no-op)", () => {
    const preexisting = {
      title: "preexisting",
      command: "unbrowse_go",
      command_args: {},
      why: "from miss",
    };
    const out = addResolveHitGuidance(
      {
        next_action: preexisting,
        available_endpoints: [{ endpoint_id: "ep_top" }],
        skill: { skill_id: "sk_one" },
      },
      {},
    ) as Record<string, unknown>;
    expect(out.next_action).toBe(preexisting);
  });

  test("empty shortlist is a no-op (no next_action added)", () => {
    const out = addResolveHitGuidance(
      {
        available_endpoints: [],
        skill: { skill_id: "sk_one" },
      },
      {},
    ) as Record<string, unknown>;
    expect(out.next_action).toBeUndefined();
  });

  test("missing endpoint_id on top candidate is a no-op", () => {
    const out = addResolveHitGuidance(
      {
        available_endpoints: [{ description: "incomplete" }],
        skill: { skill_id: "sk_one" },
      },
      {},
    ) as Record<string, unknown>;
    expect(out.next_action).toBeUndefined();
  });

  test("missing skill id is a no-op (we never invent a skill)", () => {
    const out = addResolveHitGuidance(
      {
        available_endpoints: [{ endpoint_id: "ep_top" }],
      },
      {},
    ) as Record<string, unknown>;
    expect(out.next_action).toBeUndefined();
  });
});

describe("addResolveHitGuidance — adversarial corners", () => {
  test("description >120 chars is truncated with ellipsis", () => {
    const longDesc = "x".repeat(500);
    const out = addResolveHitGuidance(
      {
        available_endpoints: [{ endpoint_id: "ep_top", description: longDesc }],
        skill: { skill_id: "sk_one" },
      },
      {},
    ) as Record<string, unknown>;
    const na = asNextAction(out.next_action);
    expect(na.why.length).toBeLessThanOrEqual(120);
    expect(na.why.endsWith("...")).toBe(true);
  });

  test("description with control characters passes through unmodified", () => {
    const ctrlDesc = "Line 1\nLine 2[31mred[0m";
    const out = addResolveHitGuidance(
      {
        available_endpoints: [{ endpoint_id: "ep_top", description: ctrlDesc }],
        skill: { skill_id: "sk_one" },
      },
      {},
    ) as Record<string, unknown>;
    const na = asNextAction(out.next_action);
    expect(typeof na.why).toBe("string");
    expect(na.why).toBe(ctrlDesc);
  });

  test("doubly-nested available_endpoints is NOT recursed into", () => {
    const input = {
      result: {
        result: { available_endpoints: [{ endpoint_id: "ep_deep" }], skill: { skill_id: "sk_deep" } },
      },
    };
    const out = addResolveHitGuidance(input, {}) as Record<string, unknown>;
    expect(out.next_action).toBeUndefined();
  });

  test("top candidate is null in shortlist is a no-op (index 0 only, no scan)", () => {
    const out = addResolveHitGuidance(
      {
        available_endpoints: [null, { endpoint_id: "ep_two" }],
        skill: { skill_id: "sk_one" },
      },
      {},
    ) as Record<string, unknown>;
    expect(out.next_action).toBeUndefined();
  });

  test("integer skill_id is rejected (resolveSkillId requires string)", () => {
    const out = addResolveHitGuidance(
      {
        available_endpoints: [{ endpoint_id: "ep_top" }],
        skill: { skill_id: 42 },
      },
      {},
    ) as Record<string, unknown>;
    expect(out.next_action).toBeUndefined();
  });
});
