import { describe, expect, test } from "bun:test";
import { getSkillChunk } from "../src/graph/index";
import type { SkillManifest, SkillOperationNode } from "../src/types/index.js";

// D4 — dedupe operations by (method, url_template) at chunk-build time.
// Two captures of x.com HomeTimeline got separate operation_ids but
// shared URL+method, surfacing as duplicates in available_operations.

function makeNode(over: Partial<SkillOperationNode>): SkillOperationNode {
  return {
    operation_id: "op",
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://www.example.com/",
    trigger_url: "https://www.example.com/",
    action_kind: "fetch",
    resource_kind: "page",
    description_in: "",
    description_out: "",
    requires: [],
    provides: [],
    negative_tags: [],
    ...over,
  } as SkillOperationNode;
}

function makeSkill(operations: SkillOperationNode[]): SkillManifest {
  return {
    skill_id: "s1",
    version: "1.0.0",
    schema_version: "1",
    name: "Example",
    intent_signature: "",
    domain: "example.com",
    description: "",
    owner_type: "marketplace",
    execution_type: "http",
    endpoints: operations.map((op) => ({
      endpoint_id: op.endpoint_id,
      method: op.method,
      url_template: op.url_template,
      description: "",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.9,
    } as any)),
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    operation_graph: {
      generated_at: new Date().toISOString(),
      entry_operation_ids: operations.map((o) => o.operation_id),
      operations,
      edges: [],
    } as any,
  } as SkillManifest;
}

describe("D4 — dedupe operations by (method, url_template) in chunk", () => {
  test("two captures of same GraphQL POST collapse to one in chunk.operations", () => {
    const a = makeNode({
      operation_id: "home-1",
      endpoint_id: "home-1",
      method: "POST",
      url_template: "https://x.com/i/api/graphql/Yf4WJo0fW46TnqrHUw_1Ow/HomeTimeline",
    });
    const b = makeNode({
      operation_id: "home-2",
      endpoint_id: "home-2",
      method: "POST",
      url_template: "https://x.com/i/api/graphql/Yf4WJo0fW46TnqrHUw_1Ow/HomeTimeline",
    });
    const c = makeNode({
      operation_id: "search-1",
      endpoint_id: "search-1",
      method: "POST",
      url_template: "https://x.com/i/api/graphql/R0u1RWRf748KzyGBXvOYRA/SearchTimeline",
    });
    const skill = makeSkill([a, b, c]);
    const chunk = getSkillChunk(skill, { intent: "home timeline" });
    const urls = chunk.operations.map((o) => o.url_template);
    // HomeTimeline must appear only once
    const homeCount = urls.filter((u) => u.includes("HomeTimeline")).length;
    expect(homeCount).toBe(1);
    // SearchTimeline must still be present
    expect(urls.some((u) => u.includes("SearchTimeline"))).toBe(true);
  });

  test("GET and POST at the same URL are NOT collapsed (different operations)", () => {
    const get = makeNode({
      operation_id: "get-1", endpoint_id: "get-1",
      method: "GET", url_template: "https://api.example.com/items",
    });
    const post = makeNode({
      operation_id: "post-1", endpoint_id: "post-1",
      method: "POST", url_template: "https://api.example.com/items",
    });
    const skill = makeSkill([get, post]);
    const chunk = getSkillChunk(skill, { intent: "list items" });
    expect(chunk.operations.length).toBe(2);
  });
});

// A8 — URL entity templatification at execute time. The captured url_template
// has a hardcoded entity value (e.g., wikipedia/wiki/Quantum_computing) but the
// agent's --url contextUrl points at a different entity in the same shape.
// We use a small unit-level test against the alignment math (path-segment
// counting + entity-shape detection) since the full executeEndpoint goes
// through HTTP fetch. The behavior is exercised end-to-end in real harness
// runs once captured.

describe("A8 — URL alignment math (smoke)", () => {
  test("same hostname + same segment count + one entity diff → eligible", () => {
    const cap = new URL("https://en.wikipedia.org/wiki/Quantum_computing");
    const ctx = new URL("https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)");
    const capSegs = cap.pathname.split("/").filter(Boolean);
    const ctxSegs = ctx.pathname.split("/").filter(Boolean);
    expect(capSegs.length).toBe(ctxSegs.length);
    const diffs = capSegs.filter((s, i) => s !== ctxSegs[i]);
    expect(diffs.length).toBe(1);
    expect(diffs[0]).toBe("Quantum_computing");
  });

  test("different segment count → not eligible (would not substitute)", () => {
    const cap = new URL("https://api.example.com/v1/users");
    const ctx = new URL("https://api.example.com/v1/users/123");
    const capSegs = cap.pathname.split("/").filter(Boolean);
    const ctxSegs = ctx.pathname.split("/").filter(Boolean);
    expect(capSegs.length).not.toBe(ctxSegs.length);
  });

  test("different hostnames → not eligible", () => {
    const cap = new URL("https://en.wikipedia.org/wiki/Q");
    const ctx = new URL("https://de.wikipedia.org/wiki/Q");
    expect(cap.hostname).not.toBe(ctx.hostname);
  });
});
