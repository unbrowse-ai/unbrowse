import { describe, test, expect } from "bun:test";
import { buildDescriptionPrompt, inferDescriptionParams } from "../src/reverse-engineer/description-prompt";

describe("#165 grounded LLM descriptions", () => {
  test("prompt includes parameters", () => {
    const prompt = buildDescriptionPrompt({
      url_template: "https://api.example.com/search",
      method: "GET",
      params: [{ name: "q", in: "query", example: "example-value", type: "string", required: true }],
      domain: "example.com",
    });
    expect(prompt).toContain("q (query, string, required)");
    expect(prompt).toContain("example placeholder");
  });

  test("prompt includes response fields", () => {
    const prompt = buildDescriptionPrompt({
      url_template: "https://api.example.com/products/{id}",
      method: "GET",
      params: [{ name: "id", in: "path" }],
      sample_response_keys: ["name", "price", "description", "stock"],
      domain: "example.com",
    });
    expect(prompt).toContain("name, price, description, stock");
  });

  test("prompt works with no params", () => {
    const prompt = buildDescriptionPrompt({
      url_template: "https://api.example.com/health",
      method: "GET",
      params: [],
      domain: "example.com",
    });
    expect(prompt).toContain("GET https://api.example.com/health");
    expect(prompt).not.toContain("Parameters:");
  });

  test("prompt includes method and url", () => {
    const prompt = buildDescriptionPrompt({
      url_template: "https://api.example.com/submit",
      method: "POST",
      params: [{ name: "data", in: "body" }],
      domain: "example.com",
    });
    expect(prompt).toContain("POST https://api.example.com/submit");
  });

  test("prompt includes dependency vars and searchable terms after dependency extraction", () => {
    const prompt = buildDescriptionPrompt({
      url_template: "https://api.example.com/checkout",
      method: "POST",
      params: [{ name: "item_id", in: "body", type: "string", required: true }],
      dependency_bindings: ["item_id", "session_token", "selectedDate"],
      search_terms: ["checkout", "item_id", "selectedDate"],
      domain: "example.com",
    });
    expect(prompt).toContain("Dependency vars: item_id, session_token, selectedDate");
    expect(prompt).toContain("Search terms: checkout, item_id, selectedDate");
  });

  test("inferDescriptionParams scrubs sensitive examples and preserves type context", () => {
    const params = inferDescriptionParams({
      email: "lewis@example.com",
      session_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      selectedDate: "2026-04-04",
      audience: ["resident", "non-resident"],
    }, {
      email: "body",
      session_token: "header",
      selectedDate: "body",
      audience: "query",
    });

    expect(params.find((param) => param.name === "email")?.example).toBe("user@example.com");
    expect(params.find((param) => param.name === "session_token")?.example).toBe("[REDACTED]");
    expect(params.find((param) => param.name === "selectedDate")?.type).toBe("string");
    expect(params.find((param) => param.name === "audience")?.enum_values).toEqual(["resident", "non-resident"]);
  });
});
