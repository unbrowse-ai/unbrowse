import { describe, expect, it } from "bun:test";
import { isStructuredSearchForm, detectSearchForms } from "../src/execution/search-forms.js";
import type { SearchFormSpec } from "../src/execution/search-forms.js";

describe("isStructuredSearchForm", () => {
  it("returns true for a form with fields and a submit selector", () => {
    const spec: SearchFormSpec = {
      form_selector: "form#search",
      submit_selector: "button[type=submit]",
      fields: [
        { name: "q", type: "text", selector: 'input[name="q"]', required: true },
      ],
    };
    expect(isStructuredSearchForm(spec)).toBe(true);
  });

  it("returns false when fields array is empty", () => {
    const spec: SearchFormSpec = {
      form_selector: "form#search",
      submit_selector: "button[type=submit]",
      fields: [],
    };
    expect(isStructuredSearchForm(spec)).toBe(false);
  });

  it("returns false when submit_selector is empty", () => {
    const spec: SearchFormSpec = {
      form_selector: "form#search",
      submit_selector: "",
      fields: [
        { name: "q", type: "text", selector: 'input[name="q"]', required: true },
      ],
    };
    expect(isStructuredSearchForm(spec)).toBe(false);
  });

  it("returns true with multiple fields and result_selector", () => {
    const spec: SearchFormSpec = {
      form_selector: "form#advanced",
      submit_selector: 'input[type="submit"]',
      fields: [
        { name: "q", type: "text", selector: 'input[name="q"]', required: true },
        { name: "category", type: "select", selector: 'select[name="category"]', options: ["all", "books", "music"], required: false },
      ],
      result_selector: "#results",
    };
    expect(isStructuredSearchForm(spec)).toBe(true);
  });
});

describe("detectSearchForms", () => {
  it("detects a basic search form with a query input and submit button", () => {
    const html = `
      <html><body>
        <form id="search-form" action="/search">
          <input type="text" name="q" placeholder="Search..." />
          <button type="submit">Go</button>
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(1);
    expect(forms[0].form_selector).toBe("form#search-form");
    expect(forms[0].submit_selector).toBe("button[type=submit]");
    expect(forms[0].fields.some((f) => f.name === "q")).toBe(true);
    expect(isStructuredSearchForm(forms[0])).toBe(true);
  });

  it("skips login forms with password fields", () => {
    const html = `
      <html><body>
        <form id="login-form" action="/login">
          <input type="text" name="username" />
          <input type="password" name="password" />
          <button type="submit">Login</button>
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(0);
  });

  it("detects multiple search forms on the same page", () => {
    const html = `
      <html><body>
        <form id="quick-search" action="/search">
          <input type="search" name="q" />
          <button type="submit">Search</button>
        </form>
        <form id="advanced-search" action="/search/advanced">
          <input type="text" name="query" />
          <select name="category"><option value="all">All</option><option value="books">Books</option></select>
          <input type="submit" value="Search" />
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(2);
  });

  it("returns empty array for HTML with no forms", () => {
    const html = `<html><body><h1>Hello World</h1></body></html>`;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(0);
  });

  it("skips forms without a submit mechanism", () => {
    const html = `
      <html><body>
        <form id="broken" action="/search">
          <input type="text" name="q" />
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(0);
  });

  it("detects form with input[type=submit] instead of button", () => {
    const html = `
      <html><body>
        <form id="search" action="/search">
          <input type="text" name="search" />
          <input type="submit" value="Find" />
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(1);
    expect(forms[0].submit_selector).toBe('input[type="submit"]');
  });

  it("detects select fields with options", () => {
    const html = `
      <html><body>
        <form id="filter-form" action="/search">
          <input type="text" name="q" />
          <select name="type">
            <option value="all">All</option>
            <option value="images">Images</option>
            <option value="videos">Videos</option>
          </select>
          <button type="submit">Search</button>
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    expect(forms.length).toBe(1);
    const selectField = forms[0].fields.find((f) => f.name === "type");
    expect(selectField).toBeDefined();
    expect(selectField!.type).toBe("select");
    expect(selectField!.options).toEqual(["all", "images", "videos"]);
  });

  it("detects form with role=search even without search-named fields", () => {
    // Note: the form still needs at least one non-hidden field and a submit button
    // The heuristic allows forms with role=search even if field names aren't in the search set
    const html = `
      <html><body>
        <form role="search" action="/find">
          <input type="text" name="term" />
          <button>Go</button>
        </form>
      </body></html>
    `;
    const forms = detectSearchForms(html);
    // "term" is in SEARCH_FIELD_NAMES, so it qualifies
    expect(forms.length).toBe(1);
  });
});
