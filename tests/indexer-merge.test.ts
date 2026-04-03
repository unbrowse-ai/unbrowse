import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SkillManifest, EndpointDescriptor } from "../src/types/skill.js";

// We test the merge logic directly — no mocks, real filesystem, real functions
import { mergeEndpoints } from "../src/marketplace/index.js";
import { buildSkillOperationGraph } from "../src/graph/index.js";

function makeEndpoint(overrides: Partial<EndpointDescriptor> & { endpoint_id: string; url_template: string }): EndpointDescriptor {
  return {
    method: "GET",
    idempotency: "safe",
    verification_status: "pending",
    reliability_score: 0.5,
    ...overrides,
  };
}

function makeSkill(domain: string, endpoints: EndpointDescriptor[], overrides?: Partial<SkillManifest>): SkillManifest {
  return {
    skill_id: `test-${domain}-${Date.now()}`,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: "test",
    domain,
    description: `API skill for ${domain}`,
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    endpoints,
    ...overrides,
  };
}

describe("endpoint merging across captures", () => {
  test("mergeEndpoints combines list + detail endpoints from separate captures", () => {
    const listEndpoint = makeEndpoint({
      endpoint_id: "list-users",
      url_template: "https://api.example.com/users",
      description: "List users",
      semantic: {
        action_kind: "list",
        resource_kind: "user",
        requires: [],
        provides: [{ key: "user_id", semantic_type: "user_identifier", source: "response" }],
      },
    });

    const detailEndpoint = makeEndpoint({
      endpoint_id: "get-user",
      url_template: "https://api.example.com/users/{user_id}",
      description: "Get user details",
      semantic: {
        action_kind: "detail",
        resource_kind: "user",
        requires: [{ key: "user_id", required: true, source: "url_template", semantic_type: "user_identifier" }],
        provides: [],
      },
    });

    // Simulate two separate captures
    const capture1Endpoints = [listEndpoint];
    const capture2Endpoints = [detailEndpoint];

    // Merge should combine them
    const merged = mergeEndpoints(capture1Endpoints, capture2Endpoints);

    expect(merged.length).toBe(2);
    expect(merged.find(ep => ep.endpoint_id === "list-users")).toBeDefined();
    expect(merged.find(ep => ep.endpoint_id === "get-user")).toBeDefined();
  });

  test("mergeEndpoints deduplicates by method + url_template", () => {
    const ep1 = makeEndpoint({
      endpoint_id: "ep-v1",
      url_template: "https://api.example.com/search?q={query}",
      description: "Search v1",
      reliability_score: 0.3,
    });

    const ep2 = makeEndpoint({
      endpoint_id: "ep-v2",
      url_template: "https://api.example.com/search?q={query}",
      description: "Search v2",
      reliability_score: 0.8,
    });

    const merged = mergeEndpoints([ep1], [ep2]);

    // Should be 1 endpoint (deduped), keeping ep-v1's endpoint_id but best reliability
    expect(merged.length).toBe(1);
    expect(merged[0].endpoint_id).toBe("ep-v1");
    expect(merged[0].reliability_score).toBe(0.8);
  });

  test("merged multi-endpoint skill produces graph edges", () => {
    const listEndpoint = makeEndpoint({
      endpoint_id: "list-users",
      url_template: "https://api.example.com/users",
      semantic: {
        action_kind: "list",
        resource_kind: "user",
        requires: [],
        provides: [{ key: "user_id", semantic_type: "user_identifier", source: "response" }],
      },
    });

    const detailEndpoint = makeEndpoint({
      endpoint_id: "get-user",
      url_template: "https://api.example.com/users/{user_id}",
      semantic: {
        action_kind: "detail",
        resource_kind: "user",
        requires: [{ key: "user_id", required: true, source: "url_template", semantic_type: "user_identifier" }],
        provides: [{ key: "user_email", source: "response" }],
      },
    });

    const merged = mergeEndpoints([listEndpoint], [detailEndpoint]);
    const graph = buildSkillOperationGraph(merged);

    expect(graph.operations.length).toBe(2);
    // Should have at least one edge connecting list -> detail
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);

    const parentChildEdges = graph.edges.filter(e => e.kind === "parent_child");
    const depEdges = graph.edges.filter(e => e.kind === "dependency");

    // Either parent_child or dependency edge should connect list -> detail via user_id
    const connectingEdges = graph.edges.filter(e => {
      const fromOp = graph.operations.find(op => op.operation_id === e.from_operation_id);
      const toOp = graph.operations.find(op => op.operation_id === e.to_operation_id);
      return fromOp?.endpoint_id === "list-users" && toOp?.endpoint_id === "get-user";
    });
    expect(connectingEdges.length).toBeGreaterThanOrEqual(1);
    expect(connectingEdges[0].binding_key).toBe("user_id");
  });

  test("pagination self-edges are created for cursor-based endpoints", () => {
    const paginatedEndpoint = makeEndpoint({
      endpoint_id: "list-items",
      url_template: "https://api.example.com/items?cursor={cursor}",
      semantic: {
        action_kind: "list",
        resource_kind: "item",
        requires: [{ key: "cursor", source: "url_template" }],
        provides: [{ key: "cursor", source: "response" }, { key: "item_id", source: "response" }],
      },
    });

    const graph = buildSkillOperationGraph([paginatedEndpoint]);

    const paginationEdges = graph.edges.filter(e => e.kind === "pagination");
    expect(paginationEdges.length).toBeGreaterThanOrEqual(1);
    // Self-loop: from and to are the same operation
    expect(paginationEdges[0].from_operation_id).toBe(paginationEdges[0].to_operation_id);
  });
});

describe("domain snapshot accumulation", () => {
  const testDir = join(tmpdir(), `unbrowse-test-snapshots-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("findAndMergeDomainSnapshot merges endpoints across snapshots", async () => {
    // Import the function we're about to create
    const { findAndMergeDomainSnapshot } = await import("../src/indexer/index.js");

    const skill1 = makeSkill("example.com", [
      makeEndpoint({
        endpoint_id: "search",
        url_template: "https://api.example.com/search?q={query}",
        semantic: { action_kind: "search", resource_kind: "item", requires: [], provides: [{ key: "item_id", source: "response" }] },
      }),
    ], { skill_id: "skill-example" });

    const skill2 = makeSkill("example.com", [
      makeEndpoint({
        endpoint_id: "get-item",
        url_template: "https://api.example.com/items/{item_id}",
        semantic: { action_kind: "detail", resource_kind: "item", requires: [{ key: "item_id", required: true, source: "url_template" }], provides: [] },
      }),
    ], { skill_id: "skill-example-2" });

    // Write skill1 as existing snapshot
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(testDir, "snapshot1.json"), JSON.stringify(skill1));

    // findAndMergeDomainSnapshot should find skill1 and merge skill2's endpoints into it
    const merged = findAndMergeDomainSnapshot(testDir, "example.com", skill2);

    expect(merged).toBeDefined();
    expect(merged!.endpoints.length).toBe(2);
    expect(merged!.endpoints.find(ep => ep.endpoint_id === "search")).toBeDefined();
    expect(merged!.endpoints.find(ep => ep.endpoint_id === "get-item")).toBeDefined();
    // skill_id should be preserved from the existing skill
    expect(merged!.skill_id).toBe("skill-example");
  });
});

describe("background index queue", () => {
  test("queueBackgroundIndex coalesces newer work for the same domain", async () => {
    const {
      queueBackgroundIndex,
      resetIndexQueueForTests,
      setBackgroundIndexProcessorForTests,
    } = await import("../src/indexer/index.js");

    resetIndexQueueForTests();

    const processed: string[] = [];
    let started = 0;
    let releaseFirst: (() => void) | null = null;
    const secondRunDone = new Promise<void>((resolve) => {
      setBackgroundIndexProcessorForTests(async (job) => {
        processed.push(`${job.cacheKey}:${job.skill.endpoints.length}`);
        started += 1;
        if (started === 1) {
          await new Promise<void>((release) => {
            releaseFirst = release;
          });
          return;
        }
        resolve();
      });
    });

    queueBackgroundIndex({
      skill: makeSkill("example.com", [
        makeEndpoint({ endpoint_id: "list", url_template: "https://api.example.com/items" }),
      ], { skill_id: "skill-example" }),
      domain: "example.com",
      intent: "browse example.com",
      cacheKey: "job-1",
    });

    await Promise.resolve();

    queueBackgroundIndex({
      skill: makeSkill("example.com", [
        makeEndpoint({ endpoint_id: "detail", url_template: "https://api.example.com/items/{id}" }),
      ], { skill_id: "skill-example" }),
      domain: "example.com",
      intent: "browse example.com",
      cacheKey: "job-2",
    });

    queueBackgroundIndex({
      skill: makeSkill("example.com", [
        makeEndpoint({ endpoint_id: "search", url_template: "https://api.example.com/search?q={query}" }),
      ], { skill_id: "skill-example" }),
      domain: "example.com",
      intent: "browse example.com",
      cacheKey: "job-3",
    });

    releaseFirst?.();
    await secondRunDone;

    expect(processed).toEqual([
      "job-1:1",
      "job-3:2",
    ]);

    resetIndexQueueForTests();
  });
});
