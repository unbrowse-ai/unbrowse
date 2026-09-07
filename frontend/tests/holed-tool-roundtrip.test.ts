/**
 * Frontend composition witness: the client can PRODUCE a holed tool from a
 * resolved-skill manifest, FILL it, and the filled URL passes the client's own
 * seal. Mirrors backend/tests/holed-tool-roundtrip.test.ts for the frontend half.
 *
 *   1. endpointToHoledTool(manifestEndpoint) → PII-censored tool-with-holes
 *   2. fillHoledTool(tool, values)           → executable URL
 *   3. urlBelongsToSkill(manifest, url)      → the seal ACCEPTS it
 *
 * Red under HEAD — the frontend has no endpointToHoledTool (it could fill a holed
 * tool but not make one), so the client loop had no way to run the holed-tool
 * model locally.
 */
import { describe, expect, it } from "bun:test";
import { endpointToHoledTool, fillHoledTool } from "../src/lib/holed-tool-fill";
import { urlBelongsToSkill } from "../src/lib/recommend-guard";

const manifest = {
  skill_id: "sk-hn",
  domain: "hn.algolia.com",
  endpoints: [
    { endpoint_id: "ep-search", method: "GET", url: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}", headers: { authorization: "Bearer SECRET" } },
  ],
};

describe("frontend endpointToHoledTool + composition", () => {
  it("produces a PII-censored holed tool from a manifest endpoint", () => {
    const tool = endpointToHoledTool(manifest.endpoints[0]);
    expect(tool.endpoint_id).toBe("ep-search");
    const q = tool.holes.filter((h) => h.location.in === "query").map((h) => h.name).sort();
    expect(q).toEqual(["query", "tags"]);
    for (const h of tool.holes.filter((x) => x.location.in === "query")) {
      expect(h.kind).toBe("id");
      expect(h.fill).toBe("llm");
    }
    expect(JSON.stringify(tool)).not.toContain("SECRET");
  });

  it("round-trips: emit → fill → the seal accepts the filled URL", () => {
    const tool = endpointToHoledTool(manifest.endpoints[0]);
    const filled = fillHoledTool(tool, { query: "rust", tags: "story" });
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    expect(filled.url).toBe("https://hn.algolia.com/api/v1/search?query=rust&tags=story");
    const sealed = urlBelongsToSkill(manifest, filled.url);
    expect(sealed.ok).toBe(true);
  });

  it("a missing public hole is rejected before the seal sees a half-URL", () => {
    const tool = endpointToHoledTool(manifest.endpoints[0]);
    const filled = fillHoledTool(tool, { query: "rust" });
    expect(filled.ok).toBe(false);
  });
});
