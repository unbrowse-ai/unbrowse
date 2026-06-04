import { describe, expect, test } from "bun:test";
import { maybePostProcessResult } from "../src/mcp.js";

// Truth-telling diagnostic contract.
//
// When the caller passes a `path` or `extract` that doesn't match the real
// response shape, `maybePostProcessResult` used to return a silent
// `result: []` — indistinguishable from "the API returned no data". That
// forced a second round trip (schema:true) to discover the actual shape.
//
// the platform now surfaces evidence on the failure path: actual top-level
// shape on a path miss, sample-item shape on an extract miss. The agent can
// correct its next call from that evidence alone.

function fixture() {
  return {
    trace: { trace_id: "stub", success: true, status_code: 200 },
    result: {
      code: 0,
      message: "OK",
      data: {
        total_count: 2,
        list: [
          { bid: 100, name: "Alpha", area: "Singapore", ratings: "4.5" },
          { bid: 101, name: "Beta", area: "Singapore", ratings: "4.2" },
        ],
      },
    },
  } as Record<string, unknown>;
}

describe("path miss diagnostic", () => {
  test("wrong path on a populated response surfaces actual_shape", () => {
    const processed = maybePostProcessResult(fixture(), {
      path: "content.restaurants[]",
    }) as Record<string, unknown>;

    expect(Array.isArray(processed.result), "result should still be an empty array on path miss").toBe(true);
    expect((processed.result as unknown[]).length).toBe(0);

    const diag = processed.path_diagnostic as Record<string, unknown> | undefined;
    expect(diag, "path_diagnostic must be present when path matches zero elements").toBeDefined();
    expect(typeof diag?.message).toBe("string");
    expect((diag?.message as string).includes("content.restaurants[]")).toBe(true);

    const shape = diag?.actual_shape as Record<string, unknown>;
    expect(shape, "actual_shape must reflect real top-level keys").toBeDefined();
    expect(Object.keys(shape)).toContain("data");
    expect(Object.keys(shape)).toContain("code");
  });

  test("correct path returns data and omits diagnostic", () => {
    const processed = maybePostProcessResult(fixture(), {
      path: "data.list[]",
    }) as Record<string, unknown>;

    expect(Array.isArray(processed.result)).toBe(true);
    expect((processed.result as unknown[]).length).toBe(2);
    expect(processed.path_diagnostic, "no diagnostic when path resolves").toBeUndefined();
  });
});

describe("extract miss diagnostic", () => {
  test("wrong extract on a populated array surfaces sample_item_shape", () => {
    const processed = maybePostProcessResult(fixture(), {
      path: "data.list[]",
      extract: "title,price",
    }) as Record<string, unknown>;

    expect(Array.isArray(processed.result)).toBe(true);
    expect((processed.result as unknown[]).length).toBe(0);

    const diag = processed.extract_diagnostic as Record<string, unknown> | undefined;
    expect(diag, "extract_diagnostic must be present when no extract field resolves").toBeDefined();
    expect((diag?.message as string).includes("title,price")).toBe(true);

    const shape = diag?.sample_item_shape as Record<string, unknown>;
    expect(shape, "sample_item_shape must reflect a real item").toBeDefined();
    expect(Object.keys(shape)).toContain("name");
    expect(Object.keys(shape)).toContain("bid");
  });

  test("correct extract returns rows and omits diagnostic", () => {
    const processed = maybePostProcessResult(fixture(), {
      path: "data.list[]",
      extract: "name,area",
    }) as Record<string, unknown>;

    const rows = processed.result as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    expect(Object.keys(rows[0]).sort()).toEqual(["area", "name"]);
    expect(processed.extract_diagnostic).toBeUndefined();
  });
});

describe("diagnostic does not bypass diet on un-projected results", () => {
  test("no caller projection -> result still passes through dietIfOversize unchanged", () => {
    // No path/extract/limit/schema -> the existing diet path runs.
    const processed = maybePostProcessResult(fixture(), {});
    // Small fixture -> diet returns the result envelope as-is (no truncation).
    expect((processed as Record<string, unknown>).result).toBeDefined();
    expect((processed as Record<string, unknown>).path_diagnostic).toBeUndefined();
    expect((processed as Record<string, unknown>).extract_diagnostic).toBeUndefined();
  });
});
