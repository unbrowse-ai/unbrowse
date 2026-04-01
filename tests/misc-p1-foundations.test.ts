import { describe, test, expect } from "bun:test";
import { isStructuredSearchForm } from "../src/execution/search-forms.js";
import type { SearchFormSpec } from "../src/execution/search-forms.js";
import { attributeLifecycle } from "../src/runtime/lifecycle.js";
import type { LifecycleEvent } from "../src/runtime/lifecycle.js";
import { isRepeatableEval } from "../evals/codex-harness-lib.js";
import type { EvalResult } from "../evals/codex-harness-lib.js";

describe("#92 search forms", () => {
  test("identifies structured search form", () => {
    const spec: SearchFormSpec = {
      form_selector: "form#search",
      submit_selector: "button[type=submit]",
      fields: [
        { name: "query", type: "text", selector: "input#q", required: true },
        { name: "category", type: "select", selector: "select#cat", options: ["all", "products"], required: false },
      ],
    };
    expect(isStructuredSearchForm(spec)).toBe(true);
  });

  test("empty form is not structured", () => {
    const spec: SearchFormSpec = { form_selector: "form", submit_selector: "", fields: [] };
    expect(isStructuredSearchForm(spec)).toBe(false);
  });
});

describe("#93 eval repeatability", () => {
  test("consistent results are repeatable", () => {
    const results: EvalResult[] = [
      { case_id: "1", status: "pass", duration_ms: 100 },
      { case_id: "1", status: "pass", duration_ms: 120 },
    ];
    expect(isRepeatableEval(results)).toBe(true);
  });

  test("inconsistent results are not repeatable", () => {
    const results: EvalResult[] = [
      { case_id: "1", status: "pass", duration_ms: 100 },
      { case_id: "1", status: "fail", duration_ms: 120 },
    ];
    expect(isRepeatableEval(results)).toBe(false);
  });
});

describe("#95 lifecycle attribution", () => {
  test("attributes time to phases", () => {
    const events: LifecycleEvent[] = [
      { phase: "resolve", skill_id: "s1", timestamp: "2026-03-01T00:00:00Z", duration_ms: 50, source: "cache" },
      { phase: "execute", skill_id: "s1", timestamp: "2026-03-01T00:00:01Z", duration_ms: 200, source: "cache" },
      { phase: "resolve", skill_id: "s2", timestamp: "2026-03-01T00:00:02Z", duration_ms: 100, source: "marketplace" },
    ];
    const totals = attributeLifecycle(events);
    expect(totals.get("resolve")).toBe(150);
    expect(totals.get("execute")).toBe(200);
  });
});
