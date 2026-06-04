/**
 * tests/run-planner.test.ts — Step 4 signals + Step 5 ministry.
 *
 * Exercises the planner against the golden path, several edges, and one
 * adversarial input. Mock deps record every call so we can verify the
 * decision tree, not just the return value.
 *
 * Run: bun test tests/run-planner.test.ts
 */

import { describe, expect, it } from "bun:test";

import {
  DEFAULT_RUN_POLICY,
  resolveRunPolicy,
  runPlanner,
  type BrowseOutcome,
  type CaptureOutcome,
  type ExecuteOutcome,
  type ResolveOutcome,
  type RunPlannerDeps,
  type RunPlannerInput,
  type RunPlannerResult,
} from "../src/orchestrator/run-planner.js";

type DepCalls = {
  resolve: number;
  execute: number;
  capture: number;
  browse: number;
};

function makeDeps(overrides: {
  resolve?: () => Promise<ResolveOutcome>;
  resolveSeq?: Array<() => Promise<ResolveOutcome>>;
  execute?: () => Promise<ExecuteOutcome>;
  capture?: () => Promise<CaptureOutcome>;
  browse?: () => Promise<BrowseOutcome>;
}): { deps: RunPlannerDeps; calls: DepCalls } {
  const calls: DepCalls = { resolve: 0, execute: 0, capture: 0, browse: 0 };
  const seq = overrides.resolveSeq ? [...overrides.resolveSeq] : null;
  const deps: RunPlannerDeps = {
    resolve: async () => {
      calls.resolve++;
      if (seq && seq.length > 0) {
        const fn = seq.shift()!;
        return fn();
      }
      if (overrides.resolve) return overrides.resolve();
      return { status: "miss" };
    },
    execute: async () => {
      calls.execute++;
      return overrides.execute ? overrides.execute() : { result: { data: {} }, trace: { success: true } };
    },
    capture: async () => {
      calls.capture++;
      return overrides.capture ? overrides.capture() : { endpoints_discovered: 0 };
    },
    browse: async () => {
      calls.browse++;
      return overrides.browse ? overrides.browse() : { ok: true, session_id: "sess-test" };
    },
  };
  return { deps, calls };
}

const baseInput: RunPlannerInput = {
  url: "https://example.com/search?q=hello",
  intent: "find hello",
};

// ---------------------------------------------------------------------------
// Step 4 signals — types + defaults
// ---------------------------------------------------------------------------

describe("run-planner: policy defaults", () => {
  it("resolveRunPolicy(undefined) returns the documented defaults", () => {
    const p = resolveRunPolicy();
    expect(p).toEqual(DEFAULT_RUN_POLICY);
    expect(p.allow_browser).toBe(true);
    expect(p.allow_index).toBe(true);
    expect(p.allow_paid_graph).toBe(true);
    expect(p.allow_side_effects).toBe(false);
    expect(p.confirm_third_party_terms).toBe(false);
    expect(p.budget_ms).toBe(8000);
  });

  it("resolveRunPolicy overrides only the supplied keys", () => {
    const p = resolveRunPolicy({ allow_browser: false, budget_ms: 1234 });
    expect(p.allow_browser).toBe(false);
    expect(p.budget_ms).toBe(1234);
    expect(p.allow_index).toBe(DEFAULT_RUN_POLICY.allow_index);
    expect(p.allow_side_effects).toBe(DEFAULT_RUN_POLICY.allow_side_effects);
  });
});

// ---------------------------------------------------------------------------
// Step 5 ministry — golden path
// ---------------------------------------------------------------------------

describe("run-planner: golden path", () => {
  it("resolve.hit + safe GET → execute → status ok with full run_plan", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({
        status: "hit",
        skill: { skill_id: "skill-A" },
        available_endpoints: [
          { endpoint_id: "ep-1", method: "GET", needs_params: false },
        ],
      }),
      execute: async () => ({ result: { data: { items: [1, 2, 3] } }, trace: { success: true, endpoint_id: "ep-1" } }),
    });

    const out: RunPlannerResult = await runPlanner(baseInput, deps);

    expect(out.status).toBe("ok");
    expect(calls.resolve).toBe(1);
    expect(calls.execute).toBe(1);
    expect(calls.capture).toBe(0);
    expect(calls.browse).toBe(0);
    expect(out.run_plan).toEqual([
      expect.objectContaining({ step: "resolve", status: "hit" }),
      expect.objectContaining({ step: "execute", status: "complete", endpoint_id: "ep-1" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Step 5 ministry — edges
// ---------------------------------------------------------------------------

describe("run-planner: edge — resolve auth_required", () => {
  it("returns auth_required + unbrowse auth next_action without calling capture or browse", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({ error: "auth_required", login_url: "https://example.com/login" }),
    });

    const out = await runPlanner(baseInput, deps);

    expect(out.status).toBe("auth_required");
    expect(out.next_action?.command).toBe('unbrowse auth "https://example.com/login"');
    expect(calls.execute).toBe(0);
    expect(calls.capture).toBe(0);
    expect(calls.browse).toBe(0);
  });
});

describe("run-planner: edge — miss → capture → re-resolve hit → execute", () => {
  it("walks the full chain and emits resolve+index+resolve+execute steps", async () => {
    const { deps, calls } = makeDeps({
      resolveSeq: [
        async () => ({ status: "miss" }),
        async () => ({
          status: "hit",
          skill: { skill_id: "skill-B" },
          available_endpoints: [{ endpoint_id: "ep-2", method: "GET" }],
        }),
      ],
      capture: async () => ({ skill_id: "skill-B", endpoints_discovered: 4, capture_pattern: "json" }),
      execute: async () => ({ result: { data: { ok: true } }, trace: { success: true } }),
    });

    const out = await runPlanner(baseInput, deps);

    expect(out.status).toBe("ok");
    expect(calls.resolve).toBe(2);
    expect(calls.capture).toBe(1);
    expect(calls.execute).toBe(1);
    expect(calls.browse).toBe(0);
    expect(out.run_plan).toEqual([
      expect.objectContaining({ step: "resolve", status: "miss" }),
      expect.objectContaining({ step: "index", status: "complete", endpoints_discovered: 4 }),
      expect.objectContaining({ step: "resolve", status: "hit", label: "after_index" }),
      expect.objectContaining({ step: "execute", status: "complete", endpoint_id: "ep-2" }),
    ]);
  });
});

describe("run-planner: edge — miss → thin capture → browse_required", () => {
  it("opens a browse session and surfaces a snap next_action", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({ status: "miss" }),
      capture: async () => ({ endpoints_discovered: 0 }),
      browse: async () => ({ ok: true, session_id: "sess-zzz" }),
    });

    const out = await runPlanner(baseInput, deps);

    expect(out.status).toBe("browse_required");
    expect(calls.browse).toBe(1);
    expect(out.next_action?.command).toBe(
      "unbrowse snap --session sess-zzz --filter interactive",
    );
    expect(out.run_plan).toContainEqual(
      expect.objectContaining({ step: "browse", status: "opened", session_id: "sess-zzz" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Step 5 ministry — adversarial
// ---------------------------------------------------------------------------

describe("run-planner: adversarial — unsafe POST endpoint must not auto-execute", () => {
  it("blocks side-effecting endpoint and emits a manual execute next_action", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({
        status: "hit",
        skill: { skill_id: "skill-C" },
        available_endpoints: [
          { endpoint_id: "ep-write", method: "POST", needs_params: false },
        ],
      }),
    });

    const out = await runPlanner(baseInput, deps);

    expect(out.status).toBe("blocked");
    expect(calls.execute).toBe(0);
    expect(out.next_action?.command).toBe(
      "unbrowse execute --skill skill-C --endpoint ep-write",
    );
    expect(out.run_plan).toContainEqual(
      expect.objectContaining({
        step: "execute",
        status: "skipped",
        reason: "endpoint_not_safe_or_missing_params",
      }),
    );
  });
});

describe("run-planner: adversarial — third-party terms require confirmation", () => {
  it("does not auto-execute and surfaces --confirm-third-party-terms", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({
        status: "hit",
        skill: { skill_id: "skill-D" },
        available_endpoints: [
          { endpoint_id: "ep-tos", method: "GET", requires_third_party_terms_confirmation: true },
        ],
      }),
    });

    const out = await runPlanner(baseInput, deps);

    expect(out.status).toBe("blocked");
    expect(calls.execute).toBe(0);
    expect(out.next_action?.command).toContain("--confirm-third-party-terms");
    expect(out.run_plan).toContainEqual(
      expect.objectContaining({
        step: "execute",
        status: "skipped",
        reason: "requires_third_party_terms_confirmation",
      }),
    );
  });
});

describe("run-planner: policy — allow_index=false blocks capture fallback", () => {
  it("returns blocked + retry-without-no-index next_action without calling capture", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({ status: "miss" }),
    });
    const out = await runPlanner(
      { ...baseInput, policy: { allow_index: false } },
      deps,
    );

    expect(out.status).toBe("blocked");
    expect(calls.capture).toBe(0);
    expect(calls.browse).toBe(0);
    expect(out.next_action?.why).toContain("allow_index");
  });
});

describe("run-planner: payment_required — does not bypass via capture/browse", () => {
  it("short-circuits with status payment_required and no side-channel calls", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({ error: "payment_required" }),
    });
    const out = await runPlanner(baseInput, deps);
    expect(out.status).toBe("payment_required");
    expect(calls.execute).toBe(0);
    expect(calls.capture).toBe(0);
    expect(calls.browse).toBe(0);
    expect(out.next_action?.why).toContain("payment");
  });
});

describe("run-planner: policy — allow_browser=false blocks browse fallback", () => {
  it("returns blocked + unbrowse go next_action without calling browse", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({ status: "miss" }),
      capture: async () => ({ endpoints_discovered: 0 }),
    });
    const out = await runPlanner(
      { ...baseInput, policy: { allow_browser: false } },
      deps,
    );
    expect(out.status).toBe("blocked");
    expect(calls.browse).toBe(0);
    expect(out.next_action?.command).toContain("unbrowse go");
  });
});

describe("run-planner: post-index unsafe endpoint must not silently succeed", () => {
  it("re-resolve hit with POST endpoint blocks instead of returning ok", async () => {
    const { deps, calls } = makeDeps({
      resolveSeq: [
        async () => ({ status: "miss" }),
        async () => ({
          status: "hit",
          skill: { skill_id: "skill-late" },
          available_endpoints: [{ endpoint_id: "ep-late-write", method: "POST" }],
        }),
      ],
      capture: async () => ({ endpoints_discovered: 2 }),
    });
    const out = await runPlanner(baseInput, deps);
    expect(out.status).toBe("blocked");
    expect(calls.execute).toBe(0);
    expect(out.next_action?.command).toBe(
      "unbrowse execute --skill skill-late --endpoint ep-late-write",
    );
    expect(out.run_plan).toContainEqual(
      expect.objectContaining({
        step: "execute",
        status: "skipped",
        reason: "endpoint_not_safe_or_missing_params",
      }),
    );
  });
});
