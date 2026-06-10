/**
 * Client-fill seal: the agent fills the public (llm) holes from a values map;
 * secret (vault) holes are left for the browser (credentials: include) at fetch.
 */
import { describe, expect, it } from "bun:test";
import { fillHoledTool, type HoledTool } from "../src/lib/holed-tool-fill";

// A holed tool with two public holes (query, tags) and one secret hole (apiKey).
const tool: HoledTool = {
  endpoint_id: "ep-search",
  method: "GET",
  url_template:
    "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}&token={apiKey}",
  holes: [
    { location: { in: "query", name: "query" }, name: "query", kind: "id", fill: "llm" },
    { location: { in: "query", name: "tags" }, name: "tags", kind: "id", fill: "llm" },
    { location: { in: "query", name: "token" }, name: "apiKey", kind: "secret", fill: "vault" },
  ],
};

describe("fillHoledTool", () => {
  it("fills {query} and {tags} from values, leaving the secret hole for the browser", () => {
    // No apiKey in values — it's a vault hole, supplied later by the browser.
    const r = fillHoledTool(tool, { query: "rust", tags: "story" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The secret {apiKey} placeholder stays — the browser fills it at fetch.
      expect(r.url).toBe(
        "https://hn.algolia.com/api/v1/search?query=rust&tags=story&token={apiKey}",
      );
      expect(r.method).toBe("GET");
    }
  });

  it("fails (ok:false) naming the missing llm hole", () => {
    const r = fillHoledTool(tool, { query: "rust" }); // tags missing
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unfilled hole: tags");
    }
  });

  it("does NOT require the secret (vault) hole to be in values (still ok:true)", () => {
    // Only an llm-only tool to isolate: secret hole absent from values is fine.
    const r = fillHoledTool(tool, { query: "rust", tags: "story" });
    expect(r.ok).toBe(true); // apiKey deliberately absent
  });

  it("URL-encodes the filled values (spaces, ampersands)", () => {
    const r = fillHoledTool(tool, { query: "a b & c", tags: "front_page" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toContain("query=a%20b%20%26%20c");
      // raw space / & must NOT leak into the query value
      expect(r.url).not.toContain("query=a b");
      expect(r.url).not.toContain("a b & c");
    }
  });
});
