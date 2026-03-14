import { describe, expect, it } from "bun:test";
import { classifyAutonomousFailure, decideRepair, evaluateDagReadiness, summarizeBenchmarkRuns } from "../evals/codex-autonomous-harness-lib.js";
import { getResolvedSkillId, synthesizeDeferredEndpointsFromSkill } from "../evals/codex-autonomous-harness.js";
import { reviewEvalPayload } from "../evals/codex-eval-review.js";
import type { SkillManifest } from "../src/types/index.js";

function fixtureSkill(): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "fixture-github",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: now,
    updated_at: now,
    name: "github",
    intent_signature: "search repositories",
    domain: "github.com",
    description: "fixture",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id: "search",
        method: "GET",
        url_template: "https://api.github.com/search/repositories?q={q}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
      },
      {
        endpoint_id: "detail",
        method: "GET",
        url_template: "https://api.github.com/repositories/{repo_id}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
      },
    ],
    operation_graph: {
      generated_at: now,
      entry_operation_ids: ["github-search"],
      operations: [
        {
          operation_id: "github-search",
          endpoint_id: "search",
          method: "GET",
          url_template: "https://api.github.com/search/repositories?q={q}",
          action_kind: "search",
          resource_kind: "repository",
          requires: [],
          provides: [{ key: "repo_id", source: "response", semantic_type: "repository_identifier" }],
          confidence: 1,
        },
        {
          operation_id: "github-repo-detail",
          endpoint_id: "detail",
          method: "GET",
          url_template: "https://api.github.com/repositories/{repo_id}",
          action_kind: "detail",
          resource_kind: "repository",
          requires: [{ key: "repo_id", required: true, source: "path_params", semantic_type: "repository_identifier" }],
          provides: [{ key: "repo_id", source: "response", semantic_type: "repository_identifier" }],
          confidence: 1,
        },
      ],
      edges: [
        {
          edge_id: "github-search:github-repo-detail:repo_id",
          from_operation_id: "github-search",
          to_operation_id: "github-repo-detail",
          binding_key: "repo_id",
          kind: "dependency",
          confidence: 1,
        },
      ],
    },
  };
}

describe("codex autonomous harness helpers", () => {
  it("classifies cloudflare challenges as terminal blocked failures", () => {
    expect(classifyAutonomousFailure("resolve_failed", {
      error: "cf challenge",
      html: "<title>Just a moment...</title><div id='challenge-running'></div>",
    })).toEqual({
      class: "blocked",
      terminal: true,
      reason: "cloudflare_blocked",
    });
  });

  it("does not misclassify generic auth metadata as an auth failure", () => {
    expect(classifyAutonomousFailure("unclassified_array", {
      auth: true,
      trace_context: {
        skill_snapshot: {
          auth_required: true,
        },
      },
    }).class).toBe("transport");
  });

  it("finds reachable DAG paths for explicit target operations", () => {
    const dag = evaluateDagReadiness({
      skill: fixtureSkill(),
      target_operation_id: "github-repo-detail",
    });

    expect(dag.available).toBe(true);
    expect(dag.reachable).toBe(true);
    expect(dag.selected_path).toEqual(["github-search", "github-repo-detail"]);
  });

  it("prefers learned_skill_id placeholders and synthesizes endpoints from fetched skills", () => {
    expect(getResolvedSkillId({
      trace: { skill_id: "browser-capture" },
      result: { learned_skill_id: "fixture-github" },
    })).toBe("fixture-github");

    expect(synthesizeDeferredEndpointsFromSkill(fixtureSkill())).toEqual([
      {
        endpoint_id: "search",
        url: "https://api.github.com/search/repositories?q={q}",
        trigger_url: undefined,
        schema_summary: undefined,
      },
      {
        endpoint_id: "detail",
        url: "https://api.github.com/repositories/{repo_id}",
        trigger_url: undefined,
        schema_summary: undefined,
      },
    ]);
  });

  it("follows trigger urls after force-capture retries are already exhausted", () => {
    expect(decideRepair({
      round: 1,
      max_rounds: 5,
      already_force_captured: true,
      follow_url: "https://example.com/items/123",
      follow_budget_remaining: 2,
      failure: { class: "intent", terminal: false, reason: "intent_mismatch" },
    })).toEqual({
      action: "follow_url",
      reason: "follow_trigger_url",
      next_url: "https://example.com/items/123",
    });
  });

  it("passes local eval review when intent truth and expected fields line up", async () => {
    const review = await reviewEvalPayload({
      intent: "get stock quote",
      expected_fields: ["symbol", "shortName", "regularMarketPrice"],
      payload: {
        quoteResponse: {
          result: [
            {
              symbol: "AAPL",
              shortName: "Apple Inc.",
              regularMarketPrice: 212.34,
              currency: "USD",
            },
          ],
        },
      },
    });

    expect(review.verdict).toBe("pass");
    expect(review.missing_fields).toEqual([]);
  });

  it("enforces richer validation clauses for rows, side effects, and echoed params", async () => {
    const review = await reviewEvalPayload({
      intent: "create note",
      expected_fields: ["id", "title", "description"],
      params: { title: "hello", description: "world" },
      validate: {
        min_rows: 1,
        side_effect: "created",
        echo_params: ["title", "description"],
      },
      payload: {
        id: "note-1",
        title: "hello",
        description: "world",
        created: true,
      },
    });

    expect(review.verdict).toBe("pass");
    expect(review.row_count).toBe(1);
    expect(review.echoed_params).toEqual(["title", "description"]);
    expect(review.side_effect_observed).toBe("created");
  });

  it("fails validation when minimum rows are not met", async () => {
    const review = await reviewEvalPayload({
      intent: "search repositories",
      expected_fields: ["full_name"],
      validate: { min_rows: 2, entity_type: "repository" },
      payload: [
        { full_name: "openai/openai-node", description: "sdk", stargazers_count: 1 },
      ],
    });

    expect(review.verdict).toBe("fail");
    expect(review.validation_failures).toContain("min_rows:1/2");
    expect(review.observed_entity_types).toContain("repository");
  });

  it("passes field-complete unknown widget rows for non-classified intents", async () => {
    const review = await reviewEvalPayload({
      intent: "get dashboard widgets",
      expected_fields: ["title"],
      validate: { min_rows: 1 },
      payload: [
        { title: "Time at Work", description: "Time at Work" },
        { title: "Quick Launch", description: "Quick Launch" },
      ],
    });

    expect(review.verdict).toBe("pass");
    expect(review.reason).toBe("unclassified_array");
  });

  it("passes title/message records for message-like intents", async () => {
    const review = await reviewEvalPayload({
      intent: "get login success message",
      expected_fields: ["title", "message"],
      payload: {
        title: "Logged In Successfully",
        message: "Congratulations student. You successfully logged in!",
      },
    });

    expect(review.verdict).toBe("pass");
    expect(review.reason).toBe("message_record");
  });

  it("accepts common url aliases like link and mdn_url for expected url fields", async () => {
    const stackReview = await reviewEvalPayload({
      intent: "get tag questions",
      expected_fields: ["title", "url", "score"],
      payload: {
        items: [
          {
            title: "How to find references in Atom?",
            score: 8,
            question_id: 43640917,
            answer_count: 1,
            link: "https://stackoverflow.com/questions/43640917/how-to-find-references-or-usages-in-atom-editor",
          },
        ],
      },
    });
    expect(stackReview.matched_fields).toContain("url");
    expect(stackReview.missing_fields).toEqual([]);

    const mdnReview = await reviewEvalPayload({
      intent: "search docs",
      expected_fields: ["title", "url", "summary"],
      payload: {
        documents: [
          {
            title: "BackgroundFetchManager: fetch() method",
            mdn_url: "/en-US/docs/Web/API/BackgroundFetchManager/fetch",
            summary: "Starts a background fetch.",
          },
        ],
      },
    });
    expect(mdnReview.matched_fields).toContain("url");
    expect(mdnReview.missing_fields).toEqual([]);
  });

  it("judges against projected normalized payloads, not just raw fields", async () => {
    const gemReview = await reviewEvalPayload({
      intent: "get package info",
      expected_fields: ["name", "version", "description"],
      payload: {
        name: "rails",
        version: "8.0.2",
        info: "Ruby on Rails",
      },
    });
    expect(gemReview.verdict).toBe("pass");
    expect(gemReview.matched_fields).toContain("description");

    const modelReview = await reviewEvalPayload({
      intent: "search models",
      expected_fields: ["name", "url", "downloads"],
      payload: [
        {
          modelId: "openai/gpt-oss-20b",
          downloads: 123,
        },
      ],
    });
    expect(modelReview.verdict).toBe("pass");
    expect(modelReview.matched_fields).toContain("name");
    expect(modelReview.matched_fields).toContain("url");
  });

  it("projects dev.to authors from article paths and lobsters scores from text", async () => {
    const devtoReview = await reviewEvalPayload({
      intent: "get tag posts",
      expected_fields: ["title", "url", "author"],
      payload: [
        {
          title: "WebGPU article",
          path: "/sylwia-lask/webgpu-demo",
          url: "https://dev.to/sylwia-lask/webgpu-demo",
        },
      ],
    });
    expect(devtoReview.verdict).toBe("pass");
    expect(devtoReview.matched_fields).toContain("author");

    const lobstersReview = await reviewEvalPayload({
      intent: "get posts",
      expected_fields: ["title", "url", "score"],
      payload: [
        {
          title: "Interesting systems post",
          url: "/s/abc123/interesting_systems_post",
          text: "162 Interesting systems post systems.example.com authored by alice 2 hours ago | 12 comments",
        },
      ],
    });
    expect(lobstersReview.verdict).toBe("pass");
    expect(lobstersReview.matched_fields).toContain("score");
  });

  it("summarizes cold-vs-warm benchmark deltas", () => {
    expect(summarizeBenchmarkRuns(
      {
        label: "cold",
        final_state: "pass",
        goal_satisfied: true,
        final_reason: "ok",
        total_rounds: 2,
        total_resolve_ms: 3000,
        total_execute_ms: 600,
        total_ms: 3600,
        first_source: "live-capture",
        final_source: "live-capture",
        total_tokens_used: 1200,
        total_tokens_saved: 100,
        avg_tokens_saved_pct: 8,
      },
      {
        label: "warm",
        final_state: "pass",
        goal_satisfied: true,
        final_reason: "ok",
        total_rounds: 1,
        total_resolve_ms: 300,
        total_execute_ms: 100,
        total_ms: 400,
        first_source: "marketplace",
        final_source: "marketplace",
        total_tokens_used: 200,
        total_tokens_saved: 900,
        avg_tokens_saved_pct: 75,
      },
    )).toEqual({
      speedup_ms: 3200,
      speedup_ratio: 9,
      token_delta: 1000,
      token_reduction_pct: 83,
    });
  });
});
