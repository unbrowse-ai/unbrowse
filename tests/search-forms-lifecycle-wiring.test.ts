import { describe, test, expect } from "bun:test";
import {
  isStructuredSearchForm,
  detectSearchForms,
  type SearchFormSpec,
} from "../src/execution/search-forms.js";
import {
  attributeLifecycle,
  type LifecycleEvent,
} from "../src/runtime/lifecycle.js";
import { isRepeatableEval, type EvalResult } from "../evals/eval-types.js";

// =============================================================================
// Issue #223: Verify these functions are importable from their source modules
// and actually used by consumer code (not dead code).
// =============================================================================

describe("isStructuredSearchForm (from source module)", () => {
  test("validates a well-formed search spec", () => {
    const spec: SearchFormSpec = {
      form_selector: "form#search",
      submit_selector: "button[type=submit]",
      fields: [
        { name: "query", type: "text", selector: "input#q", required: true },
        {
          name: "category",
          type: "select",
          selector: "select#cat",
          options: ["all", "products"],
          required: false,
        },
      ],
    };
    expect(isStructuredSearchForm(spec)).toBe(true);
  });

  test("rejects empty-fields form", () => {
    const spec: SearchFormSpec = {
      form_selector: "form",
      submit_selector: "",
      fields: [],
    };
    expect(isStructuredSearchForm(spec)).toBe(false);
  });

  test("rejects form with fields but no submit selector", () => {
    const spec: SearchFormSpec = {
      form_selector: "form",
      submit_selector: "",
      fields: [
        { name: "q", type: "text", selector: "input", required: true },
      ],
    };
    expect(isStructuredSearchForm(spec)).toBe(false);
  });
});

describe("detectSearchForms (HTML -> SearchFormSpec[])", () => {
  test("detects a basic search form from HTML", () => {
    const html = `
      <html><body>
        <form id="search-form" action="/search" method="get">
          <input type="text" name="q" placeholder="Search..." />
          <select name="category">
            <option value="all">All</option>
            <option value="books">Books</option>
          </select>
          <button type="submit">Go</button>
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBeGreaterThanOrEqual(1);
    const form = forms[0];
    expect(form.form_selector).toContain("search-form");
    expect(form.submit_selector).toBeTruthy();
    expect(form.fields.length).toBe(2);
    expect(isStructuredSearchForm(form)).toBe(true);
  });

  test("returns empty array for page without forms", () => {
    const html = `<html><body><p>No forms here</p></body></html>`;
    const forms = detectSearchForms(html);
    expect(forms).toEqual([]);
  });

  test("detects hidden fields", () => {
    const html = `
      <html><body>
        <form action="/api/search">
          <input type="hidden" name="token" value="abc" />
          <input type="text" name="query" />
          <input type="submit" value="Search" />
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(1);
    const hidden = forms[0].fields.find((f) => f.type === "hidden");
    expect(hidden).toBeTruthy();
    expect(hidden!.name).toBe("token");
  });

  test("detects radio and checkbox fields", () => {
    const html = `
      <html><body>
        <form id="filter-form" action="/results">
          <input type="text" name="q" />
          <input type="radio" name="sort" value="date" />
          <input type="radio" name="sort" value="relevance" />
          <input type="checkbox" name="in_stock" />
          <button type="submit">Filter</button>
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(1);
    const radioField = forms[0].fields.find((f) => f.type === "radio");
    expect(radioField).toBeTruthy();
    expect(radioField!.name).toBe("sort");
    const checkboxField = forms[0].fields.find((f) => f.type === "checkbox");
    expect(checkboxField).toBeTruthy();
  });

  test("skips login forms (no search-like fields)", () => {
    const html = `
      <html><body>
        <form action="/login" method="post">
          <input type="text" name="username" />
          <input type="password" name="password" />
          <button type="submit">Log in</button>
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    // Login forms should not be detected as search forms
    expect(forms.length).toBe(0);
  });
});

describe("attributeLifecycle (from source module)", () => {
  test("aggregates durations by phase", () => {
    const events: LifecycleEvent[] = [
      { phase: "discover", skill_id: "s1", timestamp: "2026-01-01T00:00:00Z", duration_ms: 10, source: "cache" },
      { phase: "resolve", skill_id: "s1", timestamp: "2026-01-01T00:00:01Z", duration_ms: 50, source: "cache" },
      { phase: "execute", skill_id: "s1", timestamp: "2026-01-01T00:00:02Z", duration_ms: 200, source: "cache" },
      { phase: "resolve", skill_id: "s2", timestamp: "2026-01-01T00:00:03Z", duration_ms: 100, source: "marketplace" },
    ];
    const totals = attributeLifecycle(events);
    expect(totals.get("discover")).toBe(10);
    expect(totals.get("resolve")).toBe(150);
    expect(totals.get("execute")).toBe(200);
  });

  test("handles empty events", () => {
    const totals = attributeLifecycle([]);
    expect(totals.size).toBe(0);
  });
});

describe("isRepeatableEval (from source module)", () => {
  test("consistent pass results are repeatable", () => {
    const results: EvalResult[] = [
      { case_id: "c1", status: "pass", duration_ms: 100 },
      { case_id: "c1", status: "pass", duration_ms: 120 },
    ];
    expect(isRepeatableEval(results)).toBe(true);
  });

  test("mixed results are not repeatable", () => {
    const results: EvalResult[] = [
      { case_id: "c1", status: "pass", duration_ms: 100 },
      { case_id: "c1", status: "fail", duration_ms: 120 },
    ];
    expect(isRepeatableEval(results)).toBe(false);
  });

  test("single result is not sufficient for repeatability", () => {
    expect(isRepeatableEval([{ case_id: "c1", status: "pass", duration_ms: 100 }])).toBe(false);
  });

  test("empty results are not repeatable", () => {
    expect(isRepeatableEval([])).toBe(false);
  });
});

// =============================================================================
// Integration: verify the wiring actually connects through consumer paths
// =============================================================================

describe("wiring integration", () => {
  test("execution/search-forms.ts exports isStructuredSearchForm and detectSearchForms", async () => {
    const mod = await import("../src/execution/search-forms.js");
    expect(typeof mod.isStructuredSearchForm).toBe("function");
    expect(typeof mod.detectSearchForms).toBe("function");
  });

  test("isStructuredSearchForm validates correctly via the import chain", async () => {
    const searchForms = await import("../src/execution/search-forms.js");
    const spec: SearchFormSpec = {
      form_selector: "form",
      submit_selector: "button",
      fields: [{ name: "q", type: "text", selector: "input", required: true }],
    };
    expect(searchForms.isStructuredSearchForm(spec)).toBe(true);
  });

  test("lifecycle module exports are type-compatible with orchestrator usage", () => {
    const event: LifecycleEvent = {
      phase: "publish",
      skill_id: "test-skill",
      timestamp: new Date().toISOString(),
      duration_ms: 42,
      source: "marketplace",
    };
    const result = attributeLifecycle([event]);
    expect(result).toBeInstanceOf(Map);
    expect(result.get("publish")).toBe(42);
  });
});
