/**
 * Unit tests for workflow-types.ts
 *
 * Tests the exported type guard functions:
 *   - isWorkflowSkill()
 *   - isApiPackageSkill()
 */

import { describe, it, expect } from "bun:test";
import {
  isWorkflowSkill,
  isApiPackageSkill,
} from "../../workflow-types.js";
import type {
  WorkflowSkill,
  ApiPackageSkill,
  Skill,
} from "../../workflow-types.js";

// ── Test data builders ───────────────────────────────────────────────────────

function makeWorkflowSkill(overrides: Partial<WorkflowSkill> = {}): WorkflowSkill {
  return {
    name: "test-workflow",
    version: "1.0.0",
    category: "workflow",
    description: "A test workflow",
    triggers: ["when user asks to search"],
    domains: ["example.com"],
    auth: [{
      domain: "example.com",
      authType: "bearer",
    }],
    inputs: [{
      name: "query",
      type: "string",
      description: "Search query",
      required: true,
    }],
    outputs: [{
      name: "results",
      type: "array",
      description: "Search results",
      fromStep: "step-1",
      path: "$.results",
    }],
    steps: [{
      id: "step-1",
      type: "api-call",
      target: "/api/search",
      method: "GET",
      domain: "example.com",
      description: "Search the API",
    }],
    metrics: {
      totalExecutions: 0,
      successfulExecutions: 0,
      successRate: 0,
      avgExecutionTime: 0,
      failurePoints: [],
      totalEarnings: 0,
    },
    ...overrides,
  };
}

function makeApiPackageSkill(overrides: Partial<ApiPackageSkill> = {}): ApiPackageSkill {
  return {
    name: "test-api",
    version: "1.0.0",
    category: "api-package",
    description: "A test API package",
    domain: "api.example.com",
    baseUrl: "https://api.example.com",
    auth: {
      domain: "api.example.com",
      authType: "bearer",
    },
    endpoints: [{
      method: "GET",
      path: "/api/items",
      description: "List items",
      verified: true,
    }],
    metrics: {
      totalCalls: 0,
      successfulCalls: 0,
      successRate: 0,
      avgResponseTime: 0,
      totalEarnings: 0,
    },
    ...overrides,
  };
}

// ── isWorkflowSkill ──────────────────────────────────────────────────────────

describe("isWorkflowSkill", () => {
  it("returns true for workflow skills", () => {
    const skill: Skill = makeWorkflowSkill();
    expect(isWorkflowSkill(skill)).toBe(true);
  });

  it("returns false for api-package skills", () => {
    const skill: Skill = makeApiPackageSkill();
    expect(isWorkflowSkill(skill)).toBe(false);
  });

  it("narrows type to WorkflowSkill", () => {
    const skill: Skill = makeWorkflowSkill();
    if (isWorkflowSkill(skill)) {
      // TypeScript should allow accessing workflow-specific fields
      expect(skill.steps).toBeDefined();
      expect(skill.domains).toBeDefined();
      expect(skill.triggers).toBeDefined();
      expect(skill.inputs).toBeDefined();
      expect(skill.outputs).toBeDefined();
    } else {
      // Should not reach here
      expect(true).toBe(false);
    }
  });
});

// ── isApiPackageSkill ────────────────────────────────────────────────────────

describe("isApiPackageSkill", () => {
  it("returns true for api-package skills", () => {
    const skill: Skill = makeApiPackageSkill();
    expect(isApiPackageSkill(skill)).toBe(true);
  });

  it("returns false for workflow skills", () => {
    const skill: Skill = makeWorkflowSkill();
    expect(isApiPackageSkill(skill)).toBe(false);
  });

  it("narrows type to ApiPackageSkill", () => {
    const skill: Skill = makeApiPackageSkill();
    if (isApiPackageSkill(skill)) {
      // TypeScript should allow accessing api-package-specific fields
      expect(skill.domain).toBeDefined();
      expect(skill.baseUrl).toBeDefined();
      expect(skill.endpoints).toBeDefined();
    } else {
      // Should not reach here
      expect(true).toBe(false);
    }
  });
});

// ── Mutual exclusion ─────────────────────────────────────────────────────────

describe("type guards are mutually exclusive", () => {
  it("workflow skill passes exactly one guard", () => {
    const skill: Skill = makeWorkflowSkill();
    expect(isWorkflowSkill(skill)).toBe(true);
    expect(isApiPackageSkill(skill)).toBe(false);
  });

  it("api-package skill passes exactly one guard", () => {
    const skill: Skill = makeApiPackageSkill();
    expect(isWorkflowSkill(skill)).toBe(false);
    expect(isApiPackageSkill(skill)).toBe(true);
  });
});
