import { describe, test, expect } from "bun:test";
import { buildDescriptionPrompt } from "../src/reverse-engineer/description-prompt";

describe("#165 grounded LLM descriptions", () => {
  test("prompt includes parameters", () => {
    const prompt = buildDescriptionPrompt({
      url_template: "https://api.example.com/search",
      method: "GET",
      params: [{ name: "q", in: "query", example: "keyboards" }],
      domain: "example.com",
    });
    expect(prompt).toContain("q (query)");
    expect(prompt).toContain("keyboards");
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
});
