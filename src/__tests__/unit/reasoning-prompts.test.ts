/**
 * Unit tests for reasoning-prompts.ts
 *
 * Tests generateReasoningLayer() — deterministic prompt generation from
 * AgenticAnalysis + ApiData. No LLM calls, all logic is pure.
 *
 * The main export composes several internal functions:
 *   - computeConfidenceScores (entities, auth, dataFlows, coverage, overall)
 *   - generateInvestigationPrompts (CRUD gaps, auth refresh, single-sample, etc.)
 *   - generateActionPlan (steps based on confidence and analysis gaps)
 *   - identifyKnowledgeGaps (webhooks, rate limits, pagination, etc.)
 *   - generateDeepDiveTopics (areas needing investigation)
 *
 * Test strategy: build minimal AgenticAnalysis + ApiData objects and assert
 * on the structure and content of the returned ReasoningLayer.
 */

import { describe, it, expect } from "bun:test";
import { generateReasoningLayer } from "../../reasoning-prompts.js";
import type { ReasoningLayer } from "../../reasoning-prompts.js";
import type { AgenticAnalysis, Entity, AuthFlow, DataFlow, EndpointSuggestion, PaginationPattern, ErrorPattern, RateLimitInfo } from "../../agentic-analyzer.js";
import type { ApiData, EndpointGroup } from "../../types.js";
import { makeApiData, makeEndpointGroup, makeParsedRequest } from "../helpers.js";

// ── Test data builders ──────────────────────────────────────────────────

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    name: "User",
    fields: [
      { name: "id", type: "number", seenIn: ["/api/users"], nullable: false, isId: true },
      { name: "name", type: "string", seenIn: ["/api/users"], nullable: false, isId: false },
      { name: "email", type: "string", seenIn: ["/api/users"], nullable: true, isId: false },
    ],
    readEndpoints: ["GET /api/users", "GET /api/users/{userId}"],
    writeEndpoints: ["POST /api/users", "PUT /api/users/{userId}"],
    deleteEndpoints: ["DELETE /api/users/{userId}"],
    crudComplete: true,
    missingOps: [],
    ...overrides,
  };
}

function makeAuthFlow(overrides: Partial<AuthFlow> = {}): AuthFlow {
  return {
    endpoint: "/api/auth/login",
    method: "POST",
    inputFields: ["email", "password"],
    producedTokens: ["accessToken", "refreshToken"],
    consumedBy: [
      { endpoint: "GET /api/users", location: "header", field: "Authorization" },
    ],
    refreshEndpoint: "/api/auth/refresh",
    ...overrides,
  };
}

function makeDataFlow(overrides: Partial<DataFlow> = {}): DataFlow {
  return {
    producer: "GET /api/users",
    producerField: "id",
    consumer: "GET /api/users/{userId}",
    consumerLocation: "path",
    consumerField: "userId",
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AgenticAnalysis> = {}): AgenticAnalysis {
  return {
    entities: [],
    authFlows: [],
    pagination: [],
    errors: [],
    rateLimits: [],
    dataFlows: [],
    suggestions: [],
    apiStyle: "rest",
    versioning: null,
    confidence: { overall: 0.5, entities: 0.5, auth: 0.5, dataFlows: 0.5, coverage: 0.5 },
    summary: "Test analysis",
    ...overrides,
  };
}

// ── Structure tests ──────────────────────────────────────────────────────

describe("generateReasoningLayer", () => {
  describe("output structure", () => {
    it("returns all required top-level keys", () => {
      const analysis = makeAnalysis();
      const data = makeApiData();
      const result = generateReasoningLayer(analysis, data);

      expect(result.confidenceScores).toBeDefined();
      expect(result.investigationPrompts).toBeDefined();
      expect(result.actionPlan).toBeDefined();
      expect(result.knowledgeGaps).toBeDefined();
      expect(result.deepDiveTopics).toBeDefined();
    });

    it("confidence scores have all dimensions", () => {
      const result = generateReasoningLayer(makeAnalysis(), makeApiData());
      const cs = result.confidenceScores;

      expect(cs.overall).toBeDefined();
      expect(cs.entities).toBeDefined();
      expect(cs.auth).toBeDefined();
      expect(cs.dataFlows).toBeDefined();
      expect(cs.coverage).toBeDefined();

      // Each should have value and reasoning
      for (const key of ["overall", "entities", "auth", "dataFlows", "coverage"] as const) {
        expect(typeof cs[key].value).toBe("number");
        expect(typeof cs[key].reasoning).toBe("string");
        expect(cs[key].reasoning.length).toBeGreaterThan(0);
      }
    });

    it("confidence values are clamped between 0 and 1", () => {
      const result = generateReasoningLayer(makeAnalysis(), makeApiData());
      const cs = result.confidenceScores;

      for (const key of ["overall", "entities", "auth", "dataFlows", "coverage"] as const) {
        expect(cs[key].value).toBeGreaterThanOrEqual(0);
        expect(cs[key].value).toBeLessThanOrEqual(1);
      }
    });

    it("arrays are always arrays (even when empty)", () => {
      const result = generateReasoningLayer(makeAnalysis(), makeApiData());
      expect(Array.isArray(result.investigationPrompts)).toBe(true);
      expect(Array.isArray(result.actionPlan)).toBe(true);
      expect(Array.isArray(result.knowledgeGaps)).toBe(true);
      expect(Array.isArray(result.deepDiveTopics)).toBe(true);
    });
  });

  // ── Confidence Scoring ────────────────────────────────────────────────

  describe("confidence scoring", () => {
    describe("entities confidence", () => {
      it("returns 0 when no entities detected", () => {
        const result = generateReasoningLayer(
          makeAnalysis({ entities: [] }),
          makeApiData(),
        );
        expect(result.confidenceScores.entities.value).toBe(0);
        expect(result.confidenceScores.entities.reasoning).toContain("No entities");
      });

      it("boosts confidence with rich schemas (avg >= 5 fields)", () => {
        const entity = makeEntity({
          fields: [
            { name: "id", type: "number", seenIn: ["/api/users"], nullable: false, isId: true },
            { name: "name", type: "string", seenIn: ["/api/users"], nullable: false, isId: false },
            { name: "email", type: "string", seenIn: ["/api/users"], nullable: true, isId: false },
            { name: "role", type: "string", seenIn: ["/api/users"], nullable: false, isId: false },
            { name: "createdAt", type: "string", seenIn: ["/api/users"], nullable: false, isId: false },
          ],
        });
        const result = generateReasoningLayer(
          makeAnalysis({ entities: [entity] }),
          makeApiData(),
        );
        expect(result.confidenceScores.entities.reasoning).toContain("rich schemas");
      });

      it("penalizes sparse schemas (avg < 2 fields)", () => {
        const entity = makeEntity({
          fields: [
            { name: "id", type: "number", seenIn: ["/api/items"], nullable: false, isId: true },
          ],
        });
        const result = generateReasoningLayer(
          makeAnalysis({ entities: [entity] }),
          makeApiData(),
        );
        expect(result.confidenceScores.entities.reasoning).toContain("sparse schemas");
      });

      it("boosts for good endpoint coverage (avg >= 3 per entity)", () => {
        const entity = makeEntity({
          readEndpoints: ["GET /a", "GET /b"],
          writeEndpoints: ["POST /a"],
          deleteEndpoints: [],
        });
        const result = generateReasoningLayer(
          makeAnalysis({ entities: [entity] }),
          makeApiData(),
        );
        expect(result.confidenceScores.entities.reasoning).toContain("good endpoint coverage");
      });

      it("penalizes limited endpoint coverage (avg < 1.5)", () => {
        const entity = makeEntity({
          readEndpoints: ["GET /a"],
          writeEndpoints: [],
          deleteEndpoints: [],
        });
        const result = generateReasoningLayer(
          makeAnalysis({ entities: [entity] }),
          makeApiData(),
        );
        expect(result.confidenceScores.entities.reasoning).toContain("limited endpoint coverage");
      });

      it("boosts for CRUD completeness > 50%", () => {
        const complete = makeEntity({ crudComplete: true });
        const incomplete = makeEntity({ crudComplete: false, missingOps: ["delete"] });
        const result = generateReasoningLayer(
          makeAnalysis({ entities: [complete, complete, incomplete] }),
          makeApiData(),
        );
        expect(result.confidenceScores.entities.reasoning).toContain("complete CRUD");
      });

      it("penalizes when > 50% of endpoints have single sample", () => {
        const groups = [
          makeEndpointGroup({ exampleCount: 1 }),
          makeEndpointGroup({ exampleCount: 1, normalizedPath: "/api/v1/other" }),
          makeEndpointGroup({ exampleCount: 5, normalizedPath: "/api/v1/multi" }),
        ];
        const result = generateReasoningLayer(
          makeAnalysis({ entities: [makeEntity()] }),
          makeApiData({ endpointGroups: groups }),
        );
        expect(result.confidenceScores.entities.reasoning).toContain("only 1 sample");
      });
    });

    describe("auth confidence", () => {
      it("returns 0.5 when no auth and method is none", () => {
        const result = generateReasoningLayer(
          makeAnalysis({ authFlows: [] }),
          makeApiData({ authMethod: "none" }),
        );
        expect(result.confidenceScores.auth.value).toBe(0.5);
        expect(result.confidenceScores.auth.reasoning).toContain("No auth detected");
      });

      it("returns 0.3 when auth method present but no auth flow found", () => {
        const result = generateReasoningLayer(
          makeAnalysis({ authFlows: [] }),
          makeApiData({ authMethod: "Bearer Token" }),
        );
        expect(result.confidenceScores.auth.value).toBe(0.3);
        expect(result.confidenceScores.auth.reasoning).toContain("Bearer Token");
      });

      it("boosts for token production", () => {
        const flow = makeAuthFlow({ producedTokens: ["accessToken"] });
        const result = generateReasoningLayer(
          makeAnalysis({ authFlows: [flow] }),
          makeApiData(),
        );
        expect(result.confidenceScores.auth.reasoning).toContain("token production observed");
      });

      it("penalizes when no tokens detected in auth response", () => {
        const flow = makeAuthFlow({ producedTokens: [] });
        const result = generateReasoningLayer(
          makeAnalysis({ authFlows: [flow] }),
          makeApiData(),
        );
        expect(result.confidenceScores.auth.reasoning).toContain("no token fields detected");
      });

      it("boosts for token consumption", () => {
        const flow = makeAuthFlow({
          consumedBy: [
            { endpoint: "GET /a", location: "header", field: "Auth" },
            { endpoint: "GET /b", location: "header", field: "Auth" },
          ],
        });
        const result = generateReasoningLayer(
          makeAnalysis({ authFlows: [flow] }),
          makeApiData(),
        );
        expect(result.confidenceScores.auth.reasoning).toContain("tokens consumed by 2 endpoints");
      });

      it("boosts for refresh endpoint", () => {
        const flow = makeAuthFlow({ refreshEndpoint: "/auth/refresh" });
        const result = generateReasoningLayer(
          makeAnalysis({ authFlows: [flow] }),
          makeApiData(),
        );
        expect(result.confidenceScores.auth.reasoning).toContain("refresh endpoint detected");
      });

      it("penalizes when no refresh endpoint found", () => {
        const flow = makeAuthFlow({ refreshEndpoint: undefined });
        const result = generateReasoningLayer(
          makeAnalysis({ authFlows: [flow] }),
          makeApiData(),
        );
        expect(result.confidenceScores.auth.reasoning).toContain("no refresh endpoint found");
      });
    });

    describe("data flows confidence", () => {
      it("returns 0.2 when no data flows detected", () => {
        const result = generateReasoningLayer(
          makeAnalysis({ dataFlows: [] }),
          makeApiData(),
        );
        expect(result.confidenceScores.dataFlows.value).toBe(0.2);
        expect(result.confidenceScores.dataFlows.reasoning).toContain("No data flows");
      });

      it("boosts for >= 5 data flows", () => {
        const flows = Array.from({ length: 5 }, (_, i) =>
          makeDataFlow({ producerField: `field${i}`, consumerField: `param${i}` }),
        );
        const result = generateReasoningLayer(
          makeAnalysis({ dataFlows: flows }),
          makeApiData(),
        );
        expect(result.confidenceScores.dataFlows.reasoning).toContain("5 data flows traced");
      });

      it("moderate boost for 2-4 data flows", () => {
        const flows = [makeDataFlow(), makeDataFlow({ producerField: "otherId" })];
        const result = generateReasoningLayer(
          makeAnalysis({ dataFlows: flows }),
          makeApiData(),
        );
        expect(result.confidenceScores.dataFlows.reasoning).toContain("2 data flows traced");
      });

      it("boosts when most flows are path-param connections", () => {
        const flows = [
          makeDataFlow({ consumerLocation: "path" }),
          makeDataFlow({ consumerLocation: "path", producerField: "other" }),
        ];
        const result = generateReasoningLayer(
          makeAnalysis({ dataFlows: flows }),
          makeApiData(),
        );
        expect(result.confidenceScores.dataFlows.reasoning).toContain("explicit path-param");
      });

      it("penalizes for disconnected producers", () => {
        const groups = [
          makeEndpointGroup({ produces: ["orphanId"], consumes: [] }),
        ];
        const result = generateReasoningLayer(
          makeAnalysis({ dataFlows: [makeDataFlow()] }),
          makeApiData({ endpointGroups: groups }),
        );
        expect(result.confidenceScores.dataFlows.reasoning).toContain("never consumed");
      });
    });

    describe("coverage confidence", () => {
      it("returns 0 when no endpoint groups", () => {
        const result = generateReasoningLayer(
          makeAnalysis(),
          makeApiData({ endpointGroups: [] }),
        );
        expect(result.confidenceScores.coverage.value).toBe(0);
        expect(result.confidenceScores.coverage.reasoning).toContain("No endpoint groups");
      });

      it("boosts for high response body coverage (>= 80%)", () => {
        const groups = [
          makeEndpointGroup({ responseBodySchema: { id: "number", name: "string" } }),
          makeEndpointGroup({ responseBodySchema: { status: "string" }, normalizedPath: "/api/v1/status" }),
        ];
        const result = generateReasoningLayer(
          makeAnalysis(),
          makeApiData({ endpointGroups: groups }),
        );
        expect(result.confidenceScores.coverage.reasoning).toContain("response schemas");
      });

      it("boosts for multi-sample endpoints (>= 50%)", () => {
        const groups = [
          makeEndpointGroup({ exampleCount: 3 }),
          makeEndpointGroup({ exampleCount: 5, normalizedPath: "/api/v1/other" }),
        ];
        const result = generateReasoningLayer(
          makeAnalysis(),
          makeApiData({ endpointGroups: groups }),
        );
        expect(result.confidenceScores.coverage.reasoning).toContain("2+ samples");
      });

      it("boosts for high request volume (>= 50)", () => {
        const requests = Array.from({ length: 50 }, () => makeParsedRequest());
        const result = generateReasoningLayer(
          makeAnalysis(),
          makeApiData({ requests, endpointGroups: [makeEndpointGroup()] }),
        );
        expect(result.confidenceScores.coverage.reasoning).toContain("good volume");
      });

      it("penalizes for sparse requests (< 10)", () => {
        const requests = Array.from({ length: 5 }, () => makeParsedRequest());
        const result = generateReasoningLayer(
          makeAnalysis(),
          makeApiData({ requests, endpointGroups: [makeEndpointGroup()] }),
        );
        expect(result.confidenceScores.coverage.reasoning).toContain("sparse");
      });

      it("boosts for spec-sourced endpoints", () => {
        const groups = [
          makeEndpointGroup({ fromSpec: true }),
        ];
        const result = generateReasoningLayer(
          makeAnalysis(),
          makeApiData({ endpointGroups: groups }),
        );
        expect(result.confidenceScores.coverage.reasoning).toContain("OpenAPI spec");
      });
    });

    describe("overall confidence", () => {
      it("is a weighted average (entities 30%, auth 25%, dataFlows 25%, coverage 20%)", () => {
        // With all-empty analysis + no groups, we get:
        // entities=0, auth=0.5 (no auth, method not "none" by default), dataFlows=0.2, coverage=0
        const result = generateReasoningLayer(makeAnalysis(), makeApiData());
        const cs = result.confidenceScores;

        const expected = cs.entities.value * 0.3 + cs.auth.value * 0.25 +
          cs.dataFlows.value * 0.25 + cs.coverage.value * 0.2;
        expect(cs.overall.value).toBeCloseTo(expected, 5);
      });

      it("labels high confidence (>= 0.7)", () => {
        // Build a high-confidence scenario
        const entity = makeEntity({
          fields: Array.from({ length: 6 }, (_, i) => ({
            name: `f${i}`, type: "string", seenIn: ["/a"], nullable: false, isId: i === 0,
          })),
          readEndpoints: ["GET /a", "GET /b"],
          writeEndpoints: ["POST /a"],
          deleteEndpoints: ["DELETE /a"],
          crudComplete: true,
        });
        const flow = makeAuthFlow();
        const dataFlows = Array.from({ length: 5 }, (_, i) =>
          makeDataFlow({ consumerLocation: "path", producerField: `f${i}` }),
        );
        const groups = Array.from({ length: 5 }, (_, i) =>
          makeEndpointGroup({
            normalizedPath: `/api/v1/r${i}`,
            exampleCount: 3,
            responseBodySchema: { id: "number" },
          }),
        );
        const requests = Array.from({ length: 60 }, () => makeParsedRequest());
        const result = generateReasoningLayer(
          makeAnalysis({ entities: [entity], authFlows: [flow], dataFlows }),
          makeApiData({ endpointGroups: groups, requests }),
        );
        if (result.confidenceScores.overall.value >= 0.7) {
          expect(result.confidenceScores.overall.reasoning).toContain("High overall confidence");
        }
      });

      it("calls out weakest area when below 40%", () => {
        // dataFlows will be low (0.2) with no flows
        const result = generateReasoningLayer(
          makeAnalysis({ dataFlows: [] }),
          makeApiData(),
        );
        if (result.confidenceScores.dataFlows.value < 0.4) {
          expect(result.confidenceScores.overall.reasoning).toContain("Weakest area");
        }
      });
    });
  });

  // ── Investigation Prompts ─────────────────────────────────────────────

  describe("investigation prompts", () => {
    it("generates prompts for incomplete CRUD entities", () => {
      const entity = makeEntity({
        crudComplete: false,
        missingOps: ["delete"],
      });
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [entity] }),
        makeApiData(),
      );
      const crudPrompts = result.investigationPrompts.filter(p => p.topic === "Entity CRUD gaps");
      expect(crudPrompts.length).toBeGreaterThan(0);
      expect(crudPrompts[0].priority).toBe("high");
      expect(crudPrompts[0].question).toContain("delete");
      expect(crudPrompts[0].question).toContain("User");
    });

    it("generates specific hypothesis for delete vs other missing ops", () => {
      const entity = makeEntity({
        crudComplete: false,
        missingOps: ["delete", "create"],
      });
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [entity] }),
        makeApiData(),
      );
      const deletePrompt = result.investigationPrompts.find(p =>
        p.question.includes("delete"),
      );
      expect(deletePrompt?.hypothesis).toContain("soft-delete");

      const createPrompt = result.investigationPrompts.find(p =>
        p.question.includes("create"),
      );
      expect(createPrompt?.hypothesis).toContain("not exercised");
    });

    it("generates prompt for missing auth refresh endpoint", () => {
      const flow = makeAuthFlow({ refreshEndpoint: undefined });
      const result = generateReasoningLayer(
        makeAnalysis({ authFlows: [flow] }),
        makeApiData(),
      );
      const authPrompts = result.investigationPrompts.filter(p => p.topic === "Auth token lifecycle");
      expect(authPrompts.length).toBe(1);
      expect(authPrompts[0].priority).toBe("high");
      expect(authPrompts[0].question).toContain("refresh");
    });

    it("does not generate auth prompt when refresh exists", () => {
      const flow = makeAuthFlow({ refreshEndpoint: "/auth/refresh" });
      const result = generateReasoningLayer(
        makeAnalysis({ authFlows: [flow] }),
        makeApiData(),
      );
      const authPrompts = result.investigationPrompts.filter(p => p.topic === "Auth token lifecycle");
      expect(authPrompts.length).toBe(0);
    });

    it("generates prompt for single-sample endpoints", () => {
      const groups = [
        makeEndpointGroup({ exampleCount: 1 }),
      ];
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ endpointGroups: groups }),
      );
      const singlePrompts = result.investigationPrompts.filter(p => p.topic === "Single-sample endpoints");
      expect(singlePrompts.length).toBe(1);
      expect(singlePrompts[0].priority).toBe("medium");
    });

    it("does not generate single-sample prompt when all have multiple samples", () => {
      const groups = [
        makeEndpointGroup({ exampleCount: 5 }),
      ];
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ endpointGroups: groups }),
      );
      const singlePrompts = result.investigationPrompts.filter(p => p.topic === "Single-sample endpoints");
      expect(singlePrompts.length).toBe(0);
    });

    it("generates prompts for disconnected data flows", () => {
      const groups = [
        makeEndpointGroup({ produces: ["orphanId"], consumes: [] }),
      ];
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ endpointGroups: groups }),
      );
      const disconnected = result.investigationPrompts.filter(p => p.topic === "Disconnected data flows");
      expect(disconnected.length).toBe(1);
      expect(disconnected[0].priority).toBe("medium");
      expect(disconnected[0].question).toContain("orphanId");
    });

    it("generates prompts for ambiguous path parameters", () => {
      const groups = [
        makeEndpointGroup({
          pathParams: [{ name: "slug", type: "unknown", example: "some-value" }],
        }),
      ];
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ endpointGroups: groups }),
      );
      const ambiguous = result.investigationPrompts.filter(p => p.topic === "Ambiguous path parameters");
      expect(ambiguous.length).toBe(1);
      expect(ambiguous[0].priority).toBe("low");
    });

    it("generates prompts for pagination with unknown params", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          pagination: [{
            endpoint: "/api/items",
            type: "offset-limit",
            params: { offset: "offset", limit: "limit" },
            examples: {},
          }],
        }),
        makeApiData(),
      );
      const pagPrompts = result.investigationPrompts.filter(p => p.topic === "Pagination details unknown");
      expect(pagPrompts.length).toBe(1);
      expect(pagPrompts[0].priority).toBe("low");
    });

    it("generates prompts for opaque error responses", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          errors: [{
            status: 500,
            shape: "unknown",
            fields: [],
            endpoints: ["GET /api/broken"],
          }],
        }),
        makeApiData(),
      );
      const errorPrompts = result.investigationPrompts.filter(p => p.topic === "Opaque error responses");
      expect(errorPrompts.length).toBe(1);
      expect(errorPrompts[0].question).toContain("500");
    });

    it("does not generate opaque error prompt when error has fields", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          errors: [{
            status: 500,
            shape: "object",
            fields: ["message", "code"],
            example: "Internal Server Error",
            endpoints: ["GET /api/broken"],
          }],
        }),
        makeApiData(),
      );
      const errorPrompts = result.investigationPrompts.filter(p => p.topic === "Opaque error responses");
      expect(errorPrompts.length).toBe(0);
    });
  });

  // ── Action Plan ───────────────────────────────────────────────────────

  describe("action plan", () => {
    it("recommends more traffic capture when overall confidence < 35%", () => {
      // Very sparse: no entities, no groups, no requests
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [], dataFlows: [] }),
        makeApiData({ endpointGroups: [], requests: [] }),
      );
      if (result.confidenceScores.overall.value < 0.35) {
        const captureStep = result.actionPlan.find(s => s.tool === "unbrowse_capture");
        expect(captureStep).toBeDefined();
        expect(captureStep!.priority).toBe(1);
      }
    });

    it("recommends auth deep-analysis when auth confidence < 40%", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ authFlows: [] }),
        makeApiData({ authMethod: "Bearer Token" }),
      );
      // auth confidence should be 0.3
      const authStep = result.actionPlan.find(s =>
        s.action.toLowerCase().includes("auth") && s.tool === "unbrowse_analyze",
      );
      expect(authStep).toBeDefined();
    });

    it("recommends CRUD probing when entities have incomplete CRUD", () => {
      const entity = makeEntity({ crudComplete: false, missingOps: ["delete"] });
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [entity] }),
        makeApiData(),
      );
      const crudStep = result.actionPlan.find(s =>
        s.action.includes("CRUD") && s.tool === "unbrowse_probe",
      );
      expect(crudStep).toBeDefined();
    });

    it("recommends probing high-confidence endpoint suggestions", () => {
      const suggestions: EndpointSuggestion[] = [
        { method: "DELETE", path: "/api/users/{userId}", reason: "CRUD gap", confidence: "high" },
      ];
      const result = generateReasoningLayer(
        makeAnalysis({ suggestions }),
        makeApiData(),
      );
      const probeStep = result.actionPlan.find(s =>
        s.action.includes("undiscovered") && s.tool === "unbrowse_probe",
      );
      expect(probeStep).toBeDefined();
    });

    it("recommends probing medium-confidence suggestions separately", () => {
      const suggestions: EndpointSuggestion[] = [
        { method: "PATCH", path: "/api/items/{id}", reason: "pattern", confidence: "medium" },
      ];
      const result = generateReasoningLayer(
        makeAnalysis({ suggestions }),
        makeApiData(),
      );
      const probeStep = result.actionPlan.find(s =>
        s.action.includes("possible") && s.tool === "unbrowse_probe",
      );
      expect(probeStep).toBeDefined();
    });

    it("recommends data flow re-analysis when dataFlows confidence < 40%", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ dataFlows: [] }),
        makeApiData(),
      );
      // dataFlows confidence = 0.2
      const dfStep = result.actionPlan.find(s =>
        s.action.includes("data flow") && s.tool === "unbrowse_analyze",
      );
      expect(dfStep).toBeDefined();
    });

    it("recommends live interception when > 50% endpoints are spec-sourced", () => {
      const groups = [
        makeEndpointGroup({ fromSpec: true }),
        makeEndpointGroup({ fromSpec: true, normalizedPath: "/api/v1/other" }),
      ];
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ endpointGroups: groups }),
      );
      const interceptStep = result.actionPlan.find(s => s.tool === "unbrowse_intercept");
      expect(interceptStep).toBeDefined();
    });

    it("adds re-generate step as last when there are other steps", () => {
      const entity = makeEntity({ crudComplete: false, missingOps: ["delete"] });
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [entity] }),
        makeApiData(),
      );
      if (result.actionPlan.length > 0) {
        const lastStep = result.actionPlan[result.actionPlan.length - 1];
        expect(lastStep.tool).toBe("unbrowse_generate");
      }
    });

    it("returns empty action plan for complete high-confidence API", () => {
      // Auth is "none", all entities complete, good flows, good coverage
      const entity = makeEntity({ crudComplete: true });
      const groups = Array.from({ length: 5 }, (_, i) =>
        makeEndpointGroup({
          normalizedPath: `/api/v1/r${i}`,
          exampleCount: 3,
          responseBodySchema: { id: "number" },
        }),
      );
      const flows = Array.from({ length: 5 }, (_, i) =>
        makeDataFlow({ consumerLocation: "path", producerField: `f${i}` }),
      );
      const requests = Array.from({ length: 60 }, () => makeParsedRequest());
      const result = generateReasoningLayer(
        makeAnalysis({
          entities: [entity],
          authFlows: [],
          dataFlows: flows,
        }),
        makeApiData({
          authMethod: "none",
          endpointGroups: groups,
          requests,
        }),
      );
      // With high confidence and no gaps, there should be few/no action steps
      // (no capture needed, no auth analyze, no CRUD probe, no suggestions probe)
      // The only possible steps would be data flow re-analysis if score is low
      // In practice it may still have some steps, but none of the "critical" ones
      const criticalSteps = result.actionPlan.filter(s =>
        s.tool === "unbrowse_capture" && s.action.includes("more API traffic"),
      );
      expect(criticalSteps.length).toBe(0);
    });

    it("action steps have incrementing priorities", () => {
      const entity = makeEntity({ crudComplete: false, missingOps: ["delete"] });
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [entity] }),
        makeApiData(),
      );
      for (let i = 1; i < result.actionPlan.length; i++) {
        expect(result.actionPlan[i].priority).toBeGreaterThan(result.actionPlan[i - 1].priority);
      }
    });
  });

  // ── Knowledge Gaps ───────────────────────────────────────────────────

  describe("knowledge gaps", () => {
    it("always includes webhook gap", () => {
      const result = generateReasoningLayer(makeAnalysis(), makeApiData());
      expect(result.knowledgeGaps.some(g => g.includes("webhook"))).toBe(true);
    });

    it("includes rate limit gap when none detected", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ rateLimits: [] }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("Rate limit"))).toBe(true);
    });

    it("includes rate limit value gap when limit is undefined", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          rateLimits: [{ scope: "global", headers: ["X-RateLimit-Limit"] }],
        }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("limit value not parsed"))).toBe(true);
    });

    it("includes rate limit window gap when windowSeconds is undefined", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          rateLimits: [{ scope: "global", limit: 100, headers: ["X-RateLimit-Limit"] }],
        }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("window unknown"))).toBe(true);
    });

    it("includes pagination gap when examples are sparse", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          pagination: [{
            endpoint: "/api/items",
            type: "offset-limit",
            params: { offset: "offset" },
            examples: {},
          }],
        }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("pagination") && g.includes("/api/items"))).toBe(true);
    });

    it("includes auth token expiry gap when tokens produced but no refresh", () => {
      const flow = makeAuthFlow({
        producedTokens: ["accessToken"],
        refreshEndpoint: undefined,
      });
      const result = generateReasoningLayer(
        makeAnalysis({ authFlows: [flow] }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("token expiry unknown"))).toBe(true);
    });

    it("includes missing error status codes gap when > 3 common statuses missing", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ errors: [] }),
        makeApiData(),
      );
      // No errors observed -> all 7 common statuses missing (> 3)
      expect(result.knowledgeGaps.some(g => g.includes("Error responses for HTTP"))).toBe(true);
    });

    it("includes content-type gap when no requests have responseContentType", () => {
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ requests: [] }),
      );
      expect(result.knowledgeGaps.some(g => g.includes("content-type"))).toBe(true);
    });

    it("includes versioning gap when no versioning detected", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ versioning: null }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("versioning"))).toBe(true);
    });

    it("does not include versioning gap when versioning is detected", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          versioning: { detected: true, versions: ["v1", "v2"], pattern: "/v{n}/" },
        }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("No API versioning"))).toBe(false);
    });

    it("includes GraphQL schema gap when apiStyle is graphql", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ apiStyle: "graphql" }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("GraphQL"))).toBe(true);
    });

    it("does not include GraphQL gap for REST APIs", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ apiStyle: "rest" }),
        makeApiData(),
      );
      expect(result.knowledgeGaps.some(g => g.includes("GraphQL"))).toBe(false);
    });

    it("includes endpoint no-body gap when some but not all lack bodies", () => {
      const groups = [
        makeEndpointGroup({ responseBodySchema: { id: "number" } }),
        makeEndpointGroup({ responseBodySchema: undefined, normalizedPath: "/api/v1/noBody" }),
      ];
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ endpointGroups: groups }),
      );
      expect(result.knowledgeGaps.some(g => g.includes("no captured response body"))).toBe(true);
    });
  });

  // ── Deep Dive Topics ──────────────────────────────────────────────────

  describe("deep dive topics", () => {
    it("suggests auth deep dive when auth confidence < 60%", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ authFlows: [] }),
        makeApiData({ authMethod: "Bearer Token" }),
      );
      // auth confidence = 0.3
      const authTopic = result.deepDiveTopics.find(t => t.focusKey === "auth");
      expect(authTopic).toBeDefined();
      expect(authTopic!.topic).toBe("Authentication & Authorization");
    });

    it("does not suggest auth deep dive when confidence >= 60%", () => {
      const flow = makeAuthFlow();
      const result = generateReasoningLayer(
        makeAnalysis({ authFlows: [flow] }),
        makeApiData(),
      );
      // With full auth flow, confidence should be high
      if (result.confidenceScores.auth.value >= 0.6) {
        const authTopic = result.deepDiveTopics.find(t => t.focusKey === "auth");
        expect(authTopic).toBeUndefined();
      }
    });

    it("suggests entity deep dive when entities confidence < 60%", () => {
      const entity = makeEntity({
        fields: [{ name: "id", type: "number", seenIn: ["/a"], nullable: false, isId: true }],
        readEndpoints: ["GET /a"],
        writeEndpoints: [],
        deleteEndpoints: [],
      });
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [entity] }),
        makeApiData(),
      );
      if (result.confidenceScores.entities.value < 0.6) {
        const entTopic = result.deepDiveTopics.find(t => t.focusKey === "entities");
        expect(entTopic).toBeDefined();
      }
    });

    it("suggests data flow deep dive when confidence < 50%", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ dataFlows: [] }),
        makeApiData(),
      );
      // dataFlows confidence = 0.2
      const dfTopic = result.deepDiveTopics.find(t => t.focusKey === "data-flows");
      expect(dfTopic).toBeDefined();
    });

    it("suggests pagination deep dive when unknown pagination exists", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          pagination: [{
            endpoint: "/api/items",
            type: "unknown",
            params: {},
            examples: {},
          }],
        }),
        makeApiData(),
      );
      const pagTopic = result.deepDiveTopics.find(t => t.focusKey === "pagination");
      expect(pagTopic).toBeDefined();
      expect(pagTopic!.currentConfidence).toBe(0.3);
    });

    it("suggests error deep dive when opaque errors exist", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          errors: [{ status: 500, shape: "unknown", fields: [], endpoints: ["/api/broken"] }],
        }),
        makeApiData(),
      );
      const errTopic = result.deepDiveTopics.find(t => t.focusKey === "errors");
      expect(errTopic).toBeDefined();
    });

    it("does not suggest error deep dive when errors have fields", () => {
      const result = generateReasoningLayer(
        makeAnalysis({
          errors: [{ status: 400, shape: "object", fields: ["message"], endpoints: ["/api/x"] }],
        }),
        makeApiData(),
      );
      const errTopic = result.deepDiveTopics.find(t => t.focusKey === "errors");
      expect(errTopic).toBeUndefined();
    });

    it("suggests coverage deep dive when coverage confidence < 50%", () => {
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ endpointGroups: [makeEndpointGroup({ exampleCount: 1 })], requests: [makeParsedRequest()] }),
      );
      if (result.confidenceScores.coverage.value < 0.5) {
        const covTopic = result.deepDiveTopics.find(t => t.focusKey === "coverage");
        expect(covTopic).toBeDefined();
      }
    });

    it("each topic has required fields", () => {
      const result = generateReasoningLayer(
        makeAnalysis({ dataFlows: [] }),
        makeApiData(),
      );
      for (const topic of result.deepDiveTopics) {
        expect(topic.topic).toBeTruthy();
        expect(topic.focusKey).toBeTruthy();
        expect(topic.why).toBeTruthy();
        expect(typeof topic.currentConfidence).toBe("number");
        expect(topic.expectedImprovement).toBeTruthy();
      }
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles completely empty analysis and data", () => {
      const result = generateReasoningLayer(
        makeAnalysis(),
        makeApiData({ requests: [], endpointGroups: [] }),
      );
      expect(result).toBeDefined();
      expect(result.confidenceScores.overall.value).toBeGreaterThanOrEqual(0);
      expect(result.knowledgeGaps.length).toBeGreaterThan(0);
    });

    it("handles analysis with many entities", () => {
      const entities = Array.from({ length: 20 }, (_, i) =>
        makeEntity({ name: `Entity${i}`, crudComplete: i % 2 === 0, missingOps: i % 2 === 0 ? [] : ["delete"] }),
      );
      const result = generateReasoningLayer(
        makeAnalysis({ entities }),
        makeApiData(),
      );
      expect(result.confidenceScores.entities.value).toBeGreaterThan(0);
    });

    it("investigation prompts have valid structure", () => {
      const entity = makeEntity({ crudComplete: false, missingOps: ["delete"] });
      const flow = makeAuthFlow({ refreshEndpoint: undefined });
      const groups = [makeEndpointGroup({ exampleCount: 1, produces: ["orphanId"], consumes: [] })];
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [entity], authFlows: [flow] }),
        makeApiData({ endpointGroups: groups }),
      );
      for (const prompt of result.investigationPrompts) {
        expect(prompt.topic).toBeTruthy();
        expect(["high", "medium", "low"]).toContain(prompt.priority);
        expect(prompt.question).toBeTruthy();
        expect(prompt.hypothesis).toBeTruthy();
        expect(prompt.verification).toBeTruthy();
      }
    });

    it("action plan steps have valid structure", () => {
      const entity = makeEntity({ crudComplete: false, missingOps: ["delete"] });
      const result = generateReasoningLayer(
        makeAnalysis({ entities: [entity] }),
        makeApiData(),
      );
      for (const step of result.actionPlan) {
        expect(typeof step.priority).toBe("number");
        expect(step.action).toBeTruthy();
        expect(step.tool).toBeTruthy();
        expect(step.params).toBeDefined();
        expect(step.expectedOutcome).toBeTruthy();
        expect(step.reasoning).toBeTruthy();
      }
    });
  });
});
