// W-DRIFT-RECOVERY-SHAPE-VALIDATE: structural overlap gate on drift
// recovery. A high-confidence DOM extraction can return data with NO
// structural relationship to the endpoint's captured response_schema
// (real x.com /home regression: logged-out SSR shell `{optimist, entities,
// featureSwitch, settings}` passed extraction confidence 0.85 but had
// zero overlap with the original `data.home.home_timeline_urt.
// instructions[].entries[]` GraphQL contract). The shape-overlap check
// rejects such recoveries so the substrate keeps emitting the actionable
// schema_drift_recapture_required envelope instead of overwriting it with
// a junk shell.
//
// Real-runtime: live helper functions, no mocks. Substrate primitive
// `recoveredDataMatchesOriginalShape` is the gate; this suite is its
// regression guard.

import { describe, expect, test } from "bun:test";
import {
  flattenKeys,
  flattenSchemaKeys,
  recoveredDataMatchesOriginalShape,
} from "../src/execution/drift-page-recovery.js";

describe("flattenKeys: structural key extraction from live data", () => {
  test("walks nested objects and descends arrays into [0]", () => {
    const data = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                entries: [{ entryId: "x", content: { itemContent: {} } }],
              },
            ],
          },
        },
      },
    };
    const keys = flattenKeys(data, 4);
    expect(keys.has("data")).toBe(true);
    expect(keys.has("data.home")).toBe(true);
    expect(keys.has("data.home.home_timeline_urt")).toBe(true);
    expect(keys.has("data.home.home_timeline_urt.instructions")).toBe(true);
    expect(keys.has("data.home.home_timeline_urt.instructions[].entries")).toBe(true);
  });

  test("returns empty set on null / undefined / scalars", () => {
    expect(flattenKeys(null).size).toBe(0);
    expect(flattenKeys(undefined).size).toBe(0);
    expect(flattenKeys("x").size).toBe(0);
    expect(flattenKeys(42).size).toBe(0);
  });
});

describe("flattenSchemaKeys: structural key extraction from ResponseSchema", () => {
  test("walks properties and items so schema shape matches live-data shape", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            home: {
              type: "object",
              properties: {
                home_timeline_urt: {
                  type: "object",
                  properties: {
                    instructions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          entries: { type: "array", items: { type: "object" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const keys = flattenSchemaKeys(schema, 4);
    expect(keys.has("data")).toBe(true);
    expect(keys.has("data.home")).toBe(true);
    expect(keys.has("data.home.home_timeline_urt")).toBe(true);
    expect(keys.has("data.home.home_timeline_urt.instructions")).toBe(true);
    expect(keys.has("data.home.home_timeline_urt.instructions[].entries")).toBe(true);
  });
});

describe("recoveredDataMatchesOriginalShape: substrate-faithful drift recovery gate", () => {
  test("REGRESSION: x.com /home logged-out SSR shell is rejected against home_timeline_urt schema", () => {
    // Captured schema: the real HomeTimeline GraphQL response shape.
    const originalSchema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            home: {
              type: "object",
              properties: {
                home_timeline_urt: {
                  type: "object",
                  properties: {
                    instructions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          entries: { type: "array", items: { type: "object" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    // Live recovery: the logged-out SSR shell that triggered the bug
    // (.bench-gate/20260521T010031Z/022_graphql_https___x_com_home/
    //  execute.response.raw — `data` field has these exact keys).
    const recoveredData = {
      optimist: {},
      entities: {},
      featureSwitch: {},
      settings: { isLoaded: false },
      devices: {},
      session: {},
      snoozedTags: {},
      developer: {},
    };
    const result = recoveredDataMatchesOriginalShape(originalSchema, recoveredData);
    expect(result.matches).toBe(false);
    expect(result.reason).toBe("no_overlap");
    expect(result.intersection).toEqual([]);
    expect(result.originalKeys.length).toBeGreaterThan(2);
    // Sanity: the original keys include data.* paths.
    expect(result.originalKeys.some((k) => k.startsWith("data"))).toBe(true);
    // Sanity: the recovered keys are the shell's top-level keys.
    expect(result.recoveredKeys).toContain("optimist");
    expect(result.recoveredKeys).toContain("featureSwitch");
  });

  test("FALSIFIER: real overlap (recovery matches original) is accepted", () => {
    // crates.io listing schema with a top-level `crates` array.
    const originalSchema = {
      type: "object",
      properties: {
        crates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
    };
    // Recovery returns the same top-level structure.
    const recoveredData = {
      crates: [
        { name: "tokio", description: "async runtime" },
        { name: "serde", description: "serialization" },
      ],
    };
    const result = recoveredDataMatchesOriginalShape(originalSchema, recoveredData);
    expect(result.matches).toBe(true);
    expect(result.reason).toBe("overlap_found");
    expect(result.intersection).toContain("crates");
  });

  test("EDGE CASE: tiny schema (<= 2 keys) skips the check; confidence alone gates", () => {
    // A captured endpoint with a 1-key envelope — too small to derive
    // overlap signal from. The substrate must not block recovery here
    // (the confidence floor in tryRecoverFromSchemaDrift is the only
    // gate that applies).
    const originalSchema = {
      type: "object",
      properties: {
        status: { type: "string" },
      },
    };
    // Even if the recovered data has wildly different keys, this is
    // accepted because the schema was too small to make a reliable
    // structural comparison.
    const recoveredData = {
      title: "Some page",
      body: "Some content",
      items: [{ id: 1 }],
    };
    const result = recoveredDataMatchesOriginalShape(originalSchema, recoveredData);
    expect(result.matches).toBe(true);
    expect(result.reason).toBe("skipped_tiny_schema");
  });
});
