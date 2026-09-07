import { describe, expect, test } from "bun:test";

// B2 seed (Day 3, jesus-loop session 2026-05-13).
// Per .harness-out/session-bugs-20260513T122248Z.json: 30 sessions saw
// recipe_replay.*fail with no actionable next_step in the trace.
//
// Plan A4: when matchVerdict.match is false, the decisionTrace entry must
// carry a structured next_step derived from the reason (signal-mismatch,
// status-mismatch, recipe-missing-field, unknown).
//
// Today the helper src/execution/recipe-replay-hints.ts does NOT exist.
// This test FAILS by import. Day 4 implements it.

describe("B2: deriveRecipeReplayNextStep (Day 3 failing seed)", () => {
  test("signal-mismatch reason → mentions force-capture or re-capture", async () => {
    const { deriveRecipeReplayNextStep } = await import(
      "../src/execution/recipe-replay-hints.ts"
    );
    const hint = deriveRecipeReplayNextStep("signal-mismatch", {
      url: "https://example.com/api/foo",
      status: 200,
      endpointId: "abc",
    });
    expect(typeof hint).toBe("string");
    expect(hint.toLowerCase()).toMatch(/capture|signal|fingerprint|refresh/);
  });

  test("status-mismatch reason → mentions the diverged status", async () => {
    const { deriveRecipeReplayNextStep } = await import(
      "../src/execution/recipe-replay-hints.ts"
    );
    const hint = deriveRecipeReplayNextStep("status-mismatch", {
      url: "https://example.com/api/foo",
      status: 404,
      endpointId: "abc",
    });
    expect(typeof hint).toBe("string");
    // hint must mention the actual status or "force-capture" pathway
    expect(hint).toMatch(/404|force-capture|resolve|--force/i);
  });

  test("recipe-missing-field reason → mentions re-publish or review", async () => {
    const { deriveRecipeReplayNextStep } = await import(
      "../src/execution/recipe-replay-hints.ts"
    );
    const hint = deriveRecipeReplayNextStep("recipe-missing-field", {
      url: "https://example.com/api/foo",
      status: 0,
      endpointId: "abc",
    });
    expect(hint).toMatch(/review|publish|re-?capture/i);
  });

  test("unknown reason → generic actionable hint, never empty", async () => {
    const { deriveRecipeReplayNextStep } = await import(
      "../src/execution/recipe-replay-hints.ts"
    );
    const hint = deriveRecipeReplayNextStep(undefined, {
      url: "https://example.com",
      status: 200,
      endpointId: "abc",
    });
    expect(typeof hint).toBe("string");
    expect(hint.length).toBeGreaterThan(10);
  });
});

// B2 adversarial / edge (Day 5).
describe("B2: deriveRecipeReplayNextStep (Day 5 edges)", () => {
  test("never returns empty string for any input", async () => {
    const { deriveRecipeReplayNextStep } = await import(
      "../src/execution/recipe-replay-hints.ts"
    );
    for (const reason of [undefined, "unknown", "signal-mismatch", "status-mismatch", "recipe-missing-field", "weird-future-reason"] as const) {
      const hint = deriveRecipeReplayNextStep(reason as string | undefined, {
        url: "https://example.com",
        status: 0,
        endpointId: "abc",
      });
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(0);
    }
  });

  test("does not crash on null-ish context fields", async () => {
    const { deriveRecipeReplayNextStep } = await import(
      "../src/execution/recipe-replay-hints.ts"
    );
    const hint = deriveRecipeReplayNextStep("status-mismatch", {
      url: "",
      status: 0,
      endpointId: "",
    });
    expect(typeof hint).toBe("string");
    expect(hint.length).toBeGreaterThan(0);
  });

  test("hint mentions endpointId when provided (helps the agent target the right route)", async () => {
    const { deriveRecipeReplayNextStep } = await import(
      "../src/execution/recipe-replay-hints.ts"
    );
    const hint = deriveRecipeReplayNextStep("signal-mismatch", {
      url: "https://example.com/x",
      status: 200,
      endpointId: "ep_distinctive_123",
    });
    // soft-assert: the helper SHOULD reference either endpointId or the URL so
    // the agent can disambiguate when multiple replays fail in the same trace.
    const refs = hint.includes("ep_distinctive_123") || hint.includes("example.com");
    expect(refs).toBe(true);
  });
});
