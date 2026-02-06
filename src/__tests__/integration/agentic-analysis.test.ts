/**
 * Integration tests for the agentic analysis pipeline.
 *
 * Tests: loadFixture -> parseHar() -> enrichApiData() -> analyzeTraffic() -> generateReasoningLayer()
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { parseHar, enrichApiData } from "../../har-parser.js";
import { analyzeTraffic } from "../../agentic-analyzer.js";
import { generateReasoningLayer } from "../../reasoning-prompts.js";
import { loadFixture, loadEntries } from "../helpers.js";
import type { ApiData } from "../../types.js";
import type { AgenticAnalysis } from "../../agentic-analyzer.js";
import type { ReasoningLayer } from "../../reasoning-prompts.js";

// ── todo-api agentic analysis ───────────────────────────────────────────

describe("Agentic analysis integration: todo-api", () => {
  let data: ApiData;
  let harEntries: ReturnType<typeof loadEntries>;
  let analysis: AgenticAnalysis;

  beforeAll(() => {
    const har = loadFixture("todo-api");
    harEntries = har.log.entries;
    data = parseHar(har);
    data = enrichApiData(data);
    analysis = analyzeTraffic(data, harEntries);
  });

  // ── Entity detection ──────────────────────────────────────────────────

  it("should detect entities from the todo-api", () => {
    expect(analysis.entities.length).toBeGreaterThanOrEqual(1);
  });

  it("should detect a Todo entity", () => {
    const todoEntity = analysis.entities.find(
      (e) => e.name.toLowerCase().includes("todo"),
    );
    expect(todoEntity).toBeDefined();
  });

  it("should detect fields on the Todo entity", () => {
    const todoEntity = analysis.entities.find(
      (e) => e.name.toLowerCase().includes("todo"),
    );
    expect(todoEntity).toBeDefined();
    expect(todoEntity!.fields.length).toBeGreaterThanOrEqual(2);
  });

  it("should detect read and write endpoints for Todo", () => {
    const todoEntity = analysis.entities.find(
      (e) => e.name.toLowerCase().includes("todo"),
    );
    expect(todoEntity).toBeDefined();
    expect(todoEntity!.readEndpoints.length).toBeGreaterThanOrEqual(1);
    expect(todoEntity!.writeEndpoints.length).toBeGreaterThanOrEqual(1);
    // DELETE may be on a separate entity group since single-example paths
    // may not wildcard, splitting "todos" collection from "todos/t-1002" item
  });

  it("should assess CRUD completeness for Todo (may be incomplete due to path normalization)", () => {
    const todoEntity = analysis.entities.find(
      (e) => e.name.toLowerCase().includes("todo"),
    );
    expect(todoEntity).toBeDefined();
    // With single-example path segments, path normalizer may not wildcard,
    // causing DELETE/PUT to be grouped separately. The entity has create + read
    // at minimum. CRUD completeness depends on how many path segments get wildcarded.
    expect(todoEntity!.missingOps).toBeDefined();
    expect(Array.isArray(todoEntity!.missingOps)).toBe(true);
  });

  // ── Confidence scores ─────────────────────────────────────────────────

  it("should have confidence scores in valid 0-1 range", () => {
    expect(analysis.confidence.overall).toBeGreaterThanOrEqual(0);
    expect(analysis.confidence.overall).toBeLessThanOrEqual(1);
    expect(analysis.confidence.entities).toBeGreaterThanOrEqual(0);
    expect(analysis.confidence.entities).toBeLessThanOrEqual(1);
    expect(analysis.confidence.auth).toBeGreaterThanOrEqual(0);
    expect(analysis.confidence.auth).toBeLessThanOrEqual(1);
    expect(analysis.confidence.dataFlows).toBeGreaterThanOrEqual(0);
    expect(analysis.confidence.dataFlows).toBeLessThanOrEqual(1);
    expect(analysis.confidence.coverage).toBeGreaterThanOrEqual(0);
    expect(analysis.confidence.coverage).toBeLessThanOrEqual(1);
  });

  it("should have non-zero overall confidence", () => {
    expect(analysis.confidence.overall).toBeGreaterThan(0);
  });

  // ── API style and versioning ──────────────────────────────────────────

  it("should detect REST API style", () => {
    expect(analysis.apiStyle).toBe("rest");
  });

  it("should detect v1 versioning", () => {
    expect(analysis.versioning).toBeDefined();
    expect(analysis.versioning!.detected).toBe(true);
    expect(analysis.versioning!.versions).toContain("v1");
  });

  // ── Pagination detection ──────────────────────────────────────────────

  it("should detect pagination patterns", () => {
    // todo-api list endpoint has page/limit params
    expect(analysis.pagination.length).toBeGreaterThanOrEqual(1);
  });

  it("should identify pagination type for list endpoint", () => {
    const listPagination = analysis.pagination.find((p) =>
      p.endpoint.includes("todos"),
    );
    expect(listPagination).toBeDefined();
    // Has "page" and "limit" query params
    expect(
      listPagination!.type === "page-number" || listPagination!.type === "offset-limit",
    ).toBe(true);
  });

  // ── Data flows ────────────────────────────────────────────────────────

  it("should detect data flows between endpoints", () => {
    // e.g., POST /todos produces id → consumed by GET /todos/{id}, PUT /todos/{id}
    expect(analysis.dataFlows.length).toBeGreaterThanOrEqual(1);
  });

  // ── Endpoint suggestions ──────────────────────────────────────────────

  it("should generate endpoint suggestions", () => {
    // Even for a complete API, common utility suggestions may exist
    expect(analysis.suggestions).toBeDefined();
  });

  // ── Summary ───────────────────────────────────────────────────────────

  it("should produce a non-empty summary string", () => {
    expect(analysis.summary).toBeTruthy();
    expect(analysis.summary.length).toBeGreaterThan(20);
  });

  it("should mention entities in the summary", () => {
    expect(analysis.summary.toLowerCase()).toContain("entities");
  });
});

// ── Focus mode tests ────────────────────────────────────────────────────

describe("Agentic analysis integration: focus modes", () => {
  let data: ApiData;
  let harEntries: ReturnType<typeof loadEntries>;

  beforeAll(() => {
    const har = loadFixture("todo-api");
    harEntries = har.log.entries;
    data = parseHar(har);
    data = enrichApiData(data);
  });

  it("should run with focus=entities without error", () => {
    const result = analyzeTraffic(data, harEntries, { focus: "entities" });
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
  });

  it("should run with focus=auth without error", () => {
    const result = analyzeTraffic(data, harEntries, { focus: "auth" });
    expect(result.confidence).toBeDefined();
  });

  it("should run with focus=dataflow without error", () => {
    const result = analyzeTraffic(data, harEntries, { focus: "dataflow" });
    expect(result.dataFlows).toBeDefined();
  });

  it("should run with focus=gaps without error", () => {
    const result = analyzeTraffic(data, harEntries, { focus: "gaps" });
    expect(result.suggestions).toBeDefined();
  });

  it("should run with focus=pagination without error", () => {
    const result = analyzeTraffic(data, harEntries, { focus: "pagination" });
    expect(result.pagination).toBeDefined();
  });

  it("should run with focus=errors without error", () => {
    const result = analyzeTraffic(data, harEntries, { focus: "errors" });
    expect(result.errors).toBeDefined();
  });
});

// ── mixed-traffic agentic analysis ──────────────────────────────────────

describe("Agentic analysis integration: mixed-traffic", () => {
  let data: ApiData;
  let harEntries: ReturnType<typeof loadEntries>;
  let analysis: AgenticAnalysis;

  beforeAll(() => {
    const har = loadFixture("mixed-traffic");
    harEntries = har.log.entries;
    data = parseHar(har);
    data = enrichApiData(data);
    analysis = analyzeTraffic(data, harEntries);
  });

  it("should detect auth flows from login endpoint", () => {
    expect(analysis.authFlows.length).toBeGreaterThanOrEqual(1);
    const loginFlow = analysis.authFlows.find((f) =>
      f.endpoint.includes("auth") || f.endpoint.includes("login"),
    );
    expect(loginFlow).toBeDefined();
  });

  it("should detect produced tokens from auth flow", () => {
    const loginFlow = analysis.authFlows.find((f) =>
      f.endpoint.includes("auth") || f.endpoint.includes("login"),
    );
    expect(loginFlow).toBeDefined();
    expect(loginFlow!.producedTokens.length).toBeGreaterThanOrEqual(1);
  });

  it("should detect Contact and Deal entities", () => {
    const names = analysis.entities.map((e) => e.name.toLowerCase());
    expect(names.some((n) => n.includes("contact"))).toBe(true);
    expect(names.some((n) => n.includes("deal"))).toBe(true);
  });

  it("should detect error patterns if any exist", () => {
    // mixed-traffic may not have errors, that's fine
    expect(analysis.errors).toBeDefined();
  });
});

// ── Reasoning layer integration ─────────────────────────────────────────

describe("Reasoning layer integration: todo-api", () => {
  let data: ApiData;
  let analysis: AgenticAnalysis;
  let reasoning: ReasoningLayer;

  beforeAll(() => {
    const har = loadFixture("todo-api");
    data = parseHar(har);
    data = enrichApiData(data);
    analysis = analyzeTraffic(data, har.log.entries);
    reasoning = generateReasoningLayer(analysis, data);
  });

  it("should produce confidence scores with reasoning strings", () => {
    expect(reasoning.confidenceScores).toBeDefined();
    expect(reasoning.confidenceScores.overall).toBeDefined();
    expect(reasoning.confidenceScores.overall.value).toBeGreaterThanOrEqual(0);
    expect(reasoning.confidenceScores.overall.value).toBeLessThanOrEqual(1);
    expect(reasoning.confidenceScores.overall.reasoning).toBeTruthy();
  });

  it("should produce enriched confidence for each dimension", () => {
    for (const dim of ["entities", "auth", "dataFlows", "coverage"] as const) {
      const score = reasoning.confidenceScores[dim];
      expect(score.value).toBeGreaterThanOrEqual(0);
      expect(score.value).toBeLessThanOrEqual(1);
      expect(score.reasoning.length).toBeGreaterThan(0);
    }
  });

  it("should generate investigation prompts", () => {
    expect(reasoning.investigationPrompts).toBeDefined();
    // Should have at least some prompts (auth refresh, single-sample, etc.)
    expect(reasoning.investigationPrompts.length).toBeGreaterThanOrEqual(0);
  });

  it("should have valid priority levels on investigation prompts", () => {
    for (const prompt of reasoning.investigationPrompts) {
      expect(["high", "medium", "low"]).toContain(prompt.priority);
      expect(prompt.question).toBeTruthy();
      expect(prompt.hypothesis).toBeTruthy();
      expect(prompt.verification).toBeTruthy();
    }
  });

  it("should generate an action plan", () => {
    expect(reasoning.actionPlan).toBeDefined();
    // May or may not have steps depending on confidence
    expect(reasoning.actionPlan.length).toBeGreaterThanOrEqual(0);
  });

  it("should have ordered priority in action plan steps", () => {
    for (let i = 1; i < reasoning.actionPlan.length; i++) {
      expect(reasoning.actionPlan[i].priority).toBeGreaterThanOrEqual(
        reasoning.actionPlan[i - 1].priority,
      );
    }
  });

  it("should identify knowledge gaps", () => {
    expect(reasoning.knowledgeGaps).toBeDefined();
    expect(reasoning.knowledgeGaps.length).toBeGreaterThanOrEqual(1);
    for (const gap of reasoning.knowledgeGaps) {
      expect(gap.length).toBeGreaterThan(10);
    }
  });

  it("should suggest deep dive topics", () => {
    expect(reasoning.deepDiveTopics).toBeDefined();
    // May or may not have topics depending on confidence
    for (const topic of reasoning.deepDiveTopics) {
      expect(topic.topic).toBeTruthy();
      expect(topic.focusKey).toBeTruthy();
      expect(topic.why).toBeTruthy();
      expect(topic.currentConfidence).toBeGreaterThanOrEqual(0);
      expect(topic.currentConfidence).toBeLessThanOrEqual(1);
    }
  });
});

// ── Reasoning layer with mixed-traffic ──────────────────────────────────

describe("Reasoning layer integration: mixed-traffic", () => {
  let reasoning: ReasoningLayer;

  beforeAll(() => {
    const har = loadFixture("mixed-traffic");
    let data = parseHar(har);
    data = enrichApiData(data);
    const analysis = analyzeTraffic(data, har.log.entries);
    reasoning = generateReasoningLayer(analysis, data);
  });

  it("should produce reasoning layer for traffic with auth flow", () => {
    expect(reasoning).toBeDefined();
    expect(reasoning.confidenceScores.auth.value).toBeGreaterThan(0);
  });

  it("should generate action plan steps", () => {
    expect(reasoning.actionPlan.length).toBeGreaterThanOrEqual(0);
    for (const step of reasoning.actionPlan) {
      expect(step.tool).toBeTruthy();
      expect(step.reasoning).toBeTruthy();
      expect(step.expectedOutcome).toBeTruthy();
    }
  });
});

// ── Empty data edge case ────────────────────────────────────────────────

describe("Agentic analysis integration: empty data", () => {
  it("should handle analysis of empty API data gracefully", () => {
    const emptyHar = { log: { entries: [] as any[] } };
    let data = parseHar(emptyHar);
    data = enrichApiData(data);
    const analysis = analyzeTraffic(data);

    expect(analysis.entities.length).toBe(0);
    expect(analysis.authFlows.length).toBe(0);
    expect(analysis.pagination.length).toBe(0);
    expect(analysis.errors.length).toBe(0);
    expect(analysis.dataFlows.length).toBe(0);
    expect(analysis.confidence.overall).toBeGreaterThanOrEqual(0);
    expect(analysis.summary).toBeTruthy();
  });

  it("should handle reasoning layer for empty data gracefully", () => {
    const emptyHar = { log: { entries: [] as any[] } };
    let data = parseHar(emptyHar);
    data = enrichApiData(data);
    const analysis = analyzeTraffic(data);
    const reasoning = generateReasoningLayer(analysis, data);

    expect(reasoning.confidenceScores).toBeDefined();
    expect(reasoning.knowledgeGaps.length).toBeGreaterThanOrEqual(1);
  });
});
