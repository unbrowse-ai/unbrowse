/**
 * Frontend seal (path-A brick 3b): when the hero loop has resolved a skill, the
 * LLM's execute_route URL must belong to that skill, or the client must refuse.
 */
import { describe, expect, it } from "bun:test";
import { urlBelongsToSkill, parseManifest } from "../src/lib/recommend-guard";

const manifest = {
  skill_id: "sk-hn",
  domain: "hn.algolia.com",
  endpoints: [
    { endpoint_id: "ep-search", method: "GET", url: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}" },
  ],
};

describe("urlBelongsToSkill", () => {
  it("accepts a URL on the skill's host matching an endpoint path", () => {
    const r = urlBelongsToSkill(manifest, "https://hn.algolia.com/api/v1/search?query=rust&tags=story");
    expect(r.ok).toBe(true);
  });

  it("rejects an off-skill host (exfil)", () => {
    const r = urlBelongsToSkill(manifest, "https://evil.example.com/api/v1/search?query=x");
    expect(r.ok).toBe(false);
    expect(r.reason?.toLowerCase()).toContain("host");
  });

  it("rejects a same-host URL that matches no endpoint path", () => {
    const r = urlBelongsToSkill(manifest, "https://hn.algolia.com/admin/delete-everything");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("endpoint");
  });

  it("rejects an invalid URL", () => {
    expect(urlBelongsToSkill(manifest, "not a url").ok).toBe(false);
  });
});

describe("parseManifest", () => {
  it("parses a get_route output JSON with endpoints", () => {
    const m = parseManifest(JSON.stringify(manifest));
    expect(m?.skill_id).toBe("sk-hn");
    expect(m?.endpoints).toHaveLength(1);
  });
  it("returns null for non-manifest output", () => {
    expect(parseManifest("HTTP 200\n<html>")).toBeNull();
    expect(parseManifest('{"results":[]}')).toBeNull();
  });
});
