import { describe, expect, it } from "bun:test";
import { corpusSummary, filterAuthEvalCases, parseAuthEvalCases, summarizeWorkflow, toHarnessCase, workflowStepToHarnessCase } from "../evals/codex-auth-runner-lib.js";

describe("codex auth runner lib", () => {
  it("parses auth bootstrap metadata and preserves harness-compatible fields", () => {
    const cases = parseAuthEvalCases({
      cases: [
        {
          id: "x-bookmarks",
          suite: "popular-cookie-reuse",
          site: "x.com",
          intent: "get bookmarks",
          url: "https://x.com/i/bookmarks",
          auth: {
            domain: "x.com",
            persona: "browser-user",
            role: "member",
            session: "primary",
          },
          expected_fields: ["text", "author", "permalink"],
          validate: {
            min_rows: 1,
            terminal_ok: ["pass", "blocked", "skip"],
            retrieval: {
              max_rank: 2,
              any_of: [
                {
                  url_includes: ["/i/bookmarks"],
                },
              ],
            },
          },
          popularity: {
            source: "Similarweb",
            us_rank: 9,
          },
          auth_bootstrap: {
            strategy: "cookie_reuse",
            login_url: "https://x.com/i/flow/login",
            required_cookie_names: ["auth_token", "ct0"],
          },
        },
      ],
    });

    expect(cases).toHaveLength(1);
    expect(cases[0]?.auth_bootstrap.strategy).toBe("cookie_reuse");
    expect(cases[0]?.popularity?.us_rank).toBe(9);
    expect(toHarnessCase(cases[0]!)).toEqual({
      id: "x-bookmarks",
      intent: "get bookmarks",
      url: "https://x.com/i/bookmarks",
      auth: "x.com",
      auth_context: {
        domain: "x.com",
        persona: "browser-user",
        role: "member",
        session: "primary",
      },
      expected_fields: ["text", "author", "permalink"],
      validate: {
        min_rows: 1,
        terminal_ok: ["pass", "blocked", "skip"],
        retrieval: {
          max_rank: 2,
          any_of: [
            {
              url_includes: ["/i/bookmarks"],
            },
          ],
        },
      },
    });
  });

  it("sorts auth cases by popularity rank and filters by suite/top", () => {
    const cases = parseAuthEvalCases({
      cases: [
        {
          id: "demo",
          suite: "scripted-demo",
          intent: "get dashboard",
          url: "https://example.com/dashboard",
          auth: { domain: "example.com" },
          expected_fields: ["title"],
          auth_bootstrap: { strategy: "scripted_login", steps: [{ action: "sleep", ms: 1 }] },
        },
        {
          id: "rank-12",
          suite: "popular-cookie-reuse",
          intent: "get orders",
          url: "https://walmart.com/orders",
          auth: { domain: "walmart.com" },
          expected_fields: ["order_id"],
          popularity: { source: "Similarweb", us_rank: 12 },
          auth_bootstrap: { strategy: "cookie_reuse" },
        },
        {
          id: "rank-3",
          suite: "popular-cookie-reuse",
          intent: "get orders",
          url: "https://amazon.com/orders",
          auth: { domain: "amazon.com" },
          expected_fields: ["order_id"],
          popularity: { source: "Similarweb", us_rank: 3 },
          auth_bootstrap: { strategy: "cookie_reuse" },
        },
      ],
    });

    expect(filterAuthEvalCases(cases, { suite: "popular-cookie-reuse", top: 1 }).map((item) => item.id)).toEqual(["rank-3"]);
    expect(corpusSummary(cases)).toEqual({
      total: 3,
      suites: {
        "scripted-demo": 1,
        "popular-cookie-reuse": 2,
      },
      strategies: {
        "scripted_login": 1,
        "cookie_reuse": 2,
      },
    });
  });

  it("parses workflow phases and converts workflow steps into harness cases", () => {
    const cases = parseAuthEvalCases({
      cases: [
        {
          id: "saucedemo-products",
          suite: "scripted-demo",
          intent: "get products",
          url: "https://www.saucedemo.com/inventory.html",
          auth: { domain: "www.saucedemo.com" },
          expected_fields: ["title", "description"],
          auth_bootstrap: { strategy: "scripted_login", steps: [{ action: "sleep", ms: 1 }] },
          workflow: {
            max_total_ms: 60000,
            max_failures: 0,
            steps: [
              {
                id: "inventory",
                intent: "get products",
                url: "https://www.saucedemo.com/inventory.html",
                expected_fields: ["title", "description"],
                validate: { min_rows: 3 },
              },
            ],
            verify: [
              {
                id: "detail",
                intent: "get product details",
                url: "https://www.saucedemo.com/inventory-item.html?id=4",
                expected_fields: ["title", "description", "price"],
                validate: {
                  selection: {
                    any_of: [
                      {
                        url_includes: ["/inventory-item.html?id=4"],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    });

    expect(cases[0]?.workflow?.steps).toHaveLength(1);
    expect(cases[0]?.workflow?.verify).toHaveLength(1);
    expect(workflowStepToHarnessCase(cases[0]!, cases[0]!.workflow!.verify![0]!)).toEqual({
      id: "saucedemo-products:detail",
      intent: "get product details",
      url: "https://www.saucedemo.com/inventory-item.html?id=4",
      auth: "www.saucedemo.com",
      auth_context: { domain: "www.saucedemo.com" },
      expected_fields: ["title", "description", "price"],
      validate: {
        selection: {
          any_of: [
            {
              url_includes: ["/inventory-item.html?id=4"],
            },
          ],
        },
      },
    });
  });

  it("summarizes workflow truth across step failures and speed budgets", () => {
    expect(summarizeWorkflow([
      {
        id: "inventory",
        phase: "step",
        required: true,
        final_state: "pass",
        goal_satisfied: true,
        final_reason: "product_rows",
        total_ms: 1200,
        step_max_total_ms: 5000,
      },
      {
        id: "detail",
        phase: "verify",
        required: true,
        final_state: "fail",
        goal_satisfied: false,
        final_reason: "wrong_entity_type",
        total_ms: 800,
        step_max_total_ms: 5000,
      },
    ], {
      steps: [],
      max_total_ms: 10000,
      max_failures: 0,
    })).toEqual({
      final_state: "fail",
      goal_satisfied: false,
      final_reason: "verify:detail:wrong_entity_type",
      total_ms: 2000,
      performance_total_ms: 2000,
      error_count: 1,
      failed_step_ids: ["detail"],
      exceeded_step_budget_ids: [],
      exceeded_total_budget: false,
    });
  });

  it("scores workflow speed budgets against warm latency when benchmark telemetry exists", () => {
    expect(summarizeWorkflow([
      {
        id: "inventory",
        phase: "step",
        required: true,
        final_state: "pass",
        goal_satisfied: true,
        final_reason: "product_rows",
        total_ms: 45000,
        performance_total_ms: 18000,
        performance_basis: "warm",
        step_max_total_ms: 30000,
      },
      {
        id: "detail",
        phase: "verify",
        required: true,
        final_state: "pass",
        goal_satisfied: true,
        final_reason: "product_rows",
        total_ms: 17000,
        performance_total_ms: 9000,
        performance_basis: "warm",
        step_max_total_ms: 30000,
      },
    ], {
      steps: [],
      max_total_ms: 30000,
      max_failures: 0,
    })).toEqual({
      final_state: "pass",
      goal_satisfied: true,
      final_reason: "workflow_pass",
      total_ms: 62000,
      performance_total_ms: 27000,
      error_count: 0,
      failed_step_ids: [],
      exceeded_step_budget_ids: [],
      exceeded_total_budget: false,
    });
  });
});
