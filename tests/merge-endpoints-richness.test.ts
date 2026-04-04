import { describe, it, expect } from "bun:test";
import { mergeEndpoints } from "../backend/src/services/marketplace";
import type { EndpointDescriptor } from "../backend/src/types";

function makeEp(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep1",
    method: "GET",
    url_template: "https://example.com/api/{id}",
    idempotency: "safe",
    verification_status: "unverified",
    reliability_score: 0,
    ...overrides,
  };
}

describe("mergeEndpoints richness promotion", () => {
  it("promotes incoming endpoint with response_schema over bare existing", () => {
    const existing = [makeEp()];
    const incoming = [
      makeEp({
        response_schema: {
          type: "object",
          properties: { name: { type: "string", inferred_from_samples: 1 } },
          inferred_from_samples: 3,
        },
      }),
    ];
    const merged = mergeEndpoints(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].response_schema).toBeDefined();
  });

  it("promotes incoming endpoint with csrf_plan over bare existing", () => {
    const existing = [makeEp()];
    const incoming = [
      makeEp({
        csrf_plan: { token_source: "header", token_name: "x-csrf" } as any,
      }),
    ];
    const merged = mergeEndpoints(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].csrf_plan).toBeDefined();
  });

  it("preserves existing when incoming is not richer", () => {
    const existing = [
      makeEp({
        response_schema: {
          type: "object",
          properties: { id: { type: "number", inferred_from_samples: 1 } },
          inferred_from_samples: 5,
        },
        description: "Returns user data",
      }),
    ];
    const incoming = [makeEp()];
    const merged = mergeEndpoints(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].response_schema).toBeDefined();
    expect(merged[0].description).toBe("Returns user data");
  });

  it("preserves existing on equal richness", () => {
    const existing = [makeEp({ description: "existing desc" })];
    const incoming = [makeEp({ description: "incoming desc" })];
    const merged = mergeEndpoints(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe("existing desc");
  });

  it("tie-breaks by response_schema JSON length", () => {
    const smallSchema = {
      type: "object",
      properties: { a: { type: "string", inferred_from_samples: 1 } },
      inferred_from_samples: 1,
    };
    const bigSchema = {
      type: "object",
      properties: {
        a: { type: "string", inferred_from_samples: 1 },
        b: { type: "number", inferred_from_samples: 1 },
        c: { type: "boolean", inferred_from_samples: 1 },
      },
      inferred_from_samples: 5,
    };
    const existing = [makeEp({ response_schema: smallSchema as any })];
    const incoming = [makeEp({ response_schema: bigSchema as any })];
    const merged = mergeEndpoints(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(Object.keys(merged[0].response_schema!.properties!)).toHaveLength(3);
  });
});
