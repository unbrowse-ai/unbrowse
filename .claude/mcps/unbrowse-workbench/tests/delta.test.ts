// Day-5 Creatures: falsifiable signal over src/delta.ts.
// Pure function tests. No mocks. The function reads only its arguments.
//
// Each test pair maps to a real-shaped MCP `tools/call` response root:
//   { jsonrpc: "2.0", id: <n>, result: {...} } or { ..., error: {...} }
// plus the per-side SideMeta the proxy already computes.

import { describe, test, expect } from "bun:test";
import { computeStructuralDiff } from "../src/delta.ts";

const META_A = { ms: 120, bytes: 800 };
const META_B = { ms: 95, bytes: 750 };

describe("computeStructuralDiff: identical responses", () => {
  test("deep-equal payloads return summary 'identical'", () => {
    const cand = {
      jsonrpc: "2.0",
      id: 1,
      result: { items: [{ a: 1 }, { a: 2 }], count: 2 },
    };
    const base = {
      jsonrpc: "2.0",
      id: 1,
      result: { items: [{ a: 1 }, { a: 2 }], count: 2 },
    };
    const out = computeStructuralDiff(cand, base, META_A, META_A);
    expect(out.structural_diff_summary).toBe("identical");
    expect(out.bytes_diff).toBe(0);
    expect(out.ms_diff).toBe(0);
  });
});

describe("computeStructuralDiff: root keys differ", () => {
  test("one side has result, the other has error", () => {
    const cand = { jsonrpc: "2.0", id: 2, result: { ok: true } };
    const base = {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "boom" },
    };
    const out = computeStructuralDiff(cand, base, META_A, META_B);
    expect(out.structural_diff_summary).toContain("root keys differ");
    expect(out.structural_diff_summary).toContain("result");
    expect(out.structural_diff_summary).toContain("error");
    expect(out.bytes_diff).toBe(META_A.bytes - META_B.bytes);
    expect(out.ms_diff).toBe(META_A.ms - META_B.ms);
  });
});

describe("computeStructuralDiff: one-level field add/remove", () => {
  test("candidate adds a key the baseline does not have", () => {
    const cand = {
      jsonrpc: "2.0",
      id: 3,
      result: { items: [], improvement_suggestion: "use page-artifact" },
    };
    const base = {
      jsonrpc: "2.0",
      id: 3,
      result: { items: [] },
    };
    const out = computeStructuralDiff(cand, base, META_A, META_B);
    expect(out.structural_diff_summary).toContain("1 field added");
    expect(out.structural_diff_summary).toContain("improvement_suggestion");
  });

  test("baseline has a key the candidate dropped", () => {
    const cand = {
      jsonrpc: "2.0",
      id: 4,
      result: { items: [] },
    };
    const base = {
      jsonrpc: "2.0",
      id: 4,
      result: { items: [], _legacy_field: "deprecated" },
    };
    const out = computeStructuralDiff(cand, base, META_A, META_B);
    expect(out.structural_diff_summary).toContain("1 field removed");
    expect(out.structural_diff_summary).toContain("_legacy_field");
  });
});

describe("computeStructuralDiff: same shape, value differences", () => {
  test("same root keys, same subkeys, different scalar values", () => {
    const cand = {
      jsonrpc: "2.0",
      id: 5,
      result: { items: [], count: 0, source: "candidate" },
    };
    const base = {
      jsonrpc: "2.0",
      id: 5,
      result: { items: [], count: 5, source: "baseline" },
    };
    const out = computeStructuralDiff(cand, base, META_A, META_B);
    // Must mention that values differ.
    expect(out.structural_diff_summary).toContain("values differ");
  });
});

describe("computeStructuralDiff: null / empty side", () => {
  test("candidate side null (upstream errored)", () => {
    const base = { jsonrpc: "2.0", id: 6, result: { ok: true } };
    const out = computeStructuralDiff(null, base, { ms: 0, bytes: 0 }, META_B);
    expect(out.structural_diff_summary).toContain("candidate");
    expect(out.structural_diff_summary).toContain("missing");
    expect(out.bytes_diff).toBe(0 - META_B.bytes);
    expect(out.ms_diff).toBe(0 - META_B.ms);
  });

  test("baseline side null (upstream errored)", () => {
    const cand = { jsonrpc: "2.0", id: 7, result: { ok: true } };
    const out = computeStructuralDiff(cand, null, META_A, { ms: 0, bytes: 0 });
    expect(out.structural_diff_summary).toContain("baseline");
    expect(out.structural_diff_summary).toContain("missing");
    expect(out.bytes_diff).toBe(META_A.bytes - 0);
    expect(out.ms_diff).toBe(META_A.ms - 0);
  });

  test("both sides null", () => {
    const out = computeStructuralDiff(null, null, { ms: 0, bytes: 0 }, { ms: 0, bytes: 0 });
    expect(out.structural_diff_summary).toContain("missing");
    expect(out.bytes_diff).toBe(0);
    expect(out.ms_diff).toBe(0);
  });
});

describe("computeStructuralDiff: 256-char cap", () => {
  test("summary is capped at 256 chars even with many differing keys", () => {
    const candResult: Record<string, unknown> = {};
    const baseResult: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) {
      candResult[`cand_only_key_with_a_long_name_${i}`] = i;
      baseResult[`base_only_key_with_a_long_name_${i}`] = i;
    }
    const cand = { jsonrpc: "2.0", id: 8, result: candResult };
    const base = { jsonrpc: "2.0", id: 8, result: baseResult };
    const out = computeStructuralDiff(cand, base, META_A, META_B);
    expect(out.structural_diff_summary.length).toBeLessThanOrEqual(256);
  });
});
