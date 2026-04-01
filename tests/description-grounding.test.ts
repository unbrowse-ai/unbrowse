/**
 * Tests that groundedDescription produces descriptions anchored in real
 * request params and response fields — not LLM hallucination. Covers issue #226.
 *
 * Imports from the real source module (src/reverse-engineer/description-prompt)
 * instead of the backend service that was never wired in.
 */
import { describe, it, expect } from "bun:test";
import { groundedDescription, buildDescriptionPrompt } from "../src/reverse-engineer/description-prompt";

describe("description grounding (issue #226)", () => {
  it("extracts last path segment into description", () => {
    const desc = groundedDescription({
      url_template: "https://api.example.com/v1/search",
      method: "GET",
      params: [
        { name: "q", in: "query", example: "test" },
        { name: "limit", in: "query" },
        { name: "offset", in: "query" },
      ],
      domain: "api.example.com",
    });
    // Should reference "search" from the URL and "q" from params
    expect(desc.toLowerCase()).toContain("search");
    expect(desc).toContain("q");
  });

  it("grounds path-param endpoints in the resource name", () => {
    const desc = groundedDescription({
      url_template: "https://api.example.com/users/{userId}/posts/{postId}",
      method: "GET",
      params: [{ name: "userId", in: "path" }, { name: "postId", in: "path" }],
      domain: "api.example.com",
    });
    // Path param segments are filtered; last concrete segment is "posts"
    expect(desc).toContain("Posts");
    expect(desc).toContain("Returns");
  });

  it("uses correct verb for POST endpoints", () => {
    const desc = groundedDescription({
      url_template: "https://api.example.com/v1/messages",
      method: "POST",
      params: [
        { name: "recipient", in: "body" },
        { name: "text", in: "body" },
        { name: "priority", in: "body" },
      ],
      domain: "api.example.com",
    });
    expect(desc).toContain("Creates");
    expect(desc.toLowerCase()).toContain("messages");
  });

  it("includes response fields when present", () => {
    const desc = groundedDescription({
      url_template: "https://api.example.com/v1/bulk",
      method: "GET",
      params: [],
      sample_response_keys: ["id", "name", "status"],
      domain: "api.example.com",
    });
    expect(desc).toContain("id");
    expect(desc).toContain("name");
    expect(desc).toContain("status");
  });

  it("handles endpoints with no params gracefully", () => {
    const desc = groundedDescription({
      url_template: "https://api.example.com/v1/health",
      method: "GET",
      params: [],
      domain: "api.example.com",
    });
    expect(desc).toContain("Returns");
    expect(desc.toLowerCase()).toContain("health");
  });

  it("uses DELETE verb for delete endpoints", () => {
    const desc = groundedDescription({
      url_template: "https://api.example.com/v1/posts/{postId}",
      method: "DELETE",
      params: [{ name: "postId", in: "path" }],
      domain: "api.example.com",
    });
    expect(desc).toContain("Deletes");
    expect(desc).toContain("Posts");
  });

  it("buildDescriptionPrompt includes params and response fields for grounding", () => {
    const prompt = buildDescriptionPrompt({
      url_template: "https://api.example.com/products/{id}",
      method: "GET",
      params: [
        { name: "id", in: "path" },
        { name: "fields", in: "query", example: "name,price" },
      ],
      sample_response_keys: ["name", "price", "description"],
      domain: "example.com",
    });
    // Prompt must contain the actual params and response fields
    expect(prompt).toContain("id (path)");
    expect(prompt).toContain("fields (query)");
    expect(prompt).toContain("name, price, description");
  });
});
