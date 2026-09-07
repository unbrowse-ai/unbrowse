// FALSIFIER for the description_source provenance fix.
//
// Pre-2026-05-19: classifyDescriptionInput returned "agent" for any
// prose that wasn't generic-shaped, so pre-#501 skills (where
// augmentEndpointsWithAgent never ran) still got stamped
// description_source: "agent". Misleading the calling LLM about what
// metadata had actually been LLM-reviewed.
//
// Post-fix:
//   1. classifyDescriptionInput returns only "auto" | "missing".
//   2. augmentEndpointsWithAgent sets semantic.description_source =
//      "agent" authoritatively when the LLM actually runs.
//   3. getEndpointDescriptionMetadata's "agent" path is gated SOLELY on
//      the authoritative semantic marker.

import { describe, expect, test } from "bun:test";
import { getEndpointDescriptionMetadata } from "../src/lib/graph-core/index";
import type { EndpointDescriptor } from "../src/types/skill";

const baseEndpoint: EndpointDescriptor = {
  endpoint_id: "test_ep",
  method: "GET",
  url_template: "https://example.com/api/v1/items",
  idempotency: "safe",
  verification_status: "verified",
  reliability_score: 0.5,
};

describe("description_source provenance is authoritative, not inferred", () => {
  test("non-generic prose without semantic marker is 'auto', NOT 'agent'", () => {
    // Pre-fix this returned "agent" by prose-shape inference. That's
    // the regression we're locking out.
    const meta = getEndpointDescriptionMetadata({
      ...baseEndpoint,
      description: "Returns the user's recent activity feed including comments and reactions",
    });
    expect(meta.source).toBe("auto");
  });

  test("explicit semantic.description_source === 'agent' produces source 'agent'", () => {
    const meta = getEndpointDescriptionMetadata({
      ...baseEndpoint,
      description: "Returns the user's recent activity feed",
      semantic: {
        action_kind: "list",
        resource_kind: "activity",
        description_in: "Requires user_id",
        description_out: "Returns the user's recent activity feed",
        description_source: "agent",
        description_needs_review: false,
        response_summary: "feed: [{id, type, ts}]",
        example_request: undefined,
        example_response_compact: undefined,
        example_fields: ["feed[].id", "feed[].type"],
        requires: [],
        provides: [],
        negative_tags: [],
        confidence: 0.9,
        auth_required: false,
      },
    });
    expect(meta.source).toBe("agent");
    expect(meta.needs_review).toBe(false);
  });

  test("empty/missing description is 'missing'", () => {
    const meta = getEndpointDescriptionMetadata({
      ...baseEndpoint,
      description: undefined,
    });
    expect(meta.source).toBe("missing");
  });

  test("captured-page-artifact stub description is 'auto'", () => {
    const meta = getEndpointDescriptionMetadata({
      ...baseEndpoint,
      description: "Page content from example.com",
    });
    expect(meta.source).toBe("auto");
  });

  test("generic 'Returns X' description without semantic marker is 'auto'", () => {
    const meta = getEndpointDescriptionMetadata({
      ...baseEndpoint,
      description: "Returns resource",
    });
    expect(meta.source).toBe("auto");
  });
});

describe("agent-augment sets the authoritative marker on the semantic descriptor", () => {
  test("augment-augment.ts contains description_source: 'agent' as const", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "graph-core", "agent-augment.ts"), "utf8");
    // The sanitizeSemanticUpdate function MUST stamp the marker so the
    // renderer can trust it.
    expect(src).toMatch(/description_source:\s*"agent"\s+as\s+const/);
    expect(src).toMatch(/description_needs_review:\s*false/);
  });
});
