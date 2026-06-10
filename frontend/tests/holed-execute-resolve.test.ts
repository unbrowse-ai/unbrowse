/**
 * Loop-wiring witness (path-A verb atom): the hero loop resolves an execute step
 * from a holed tool, not a raw LLM URL. When the LLM supplies {endpoint_id, values},
 * resolveHoledExecute finds that endpoint in the skills it resolved this loop,
 * builds the PII-censored holed tool from the manifest template, and fills the
 * public holes — the LLM never writes a URL, it only supplies hole values.
 *
 * Red under HEAD — resolveHoledExecute does not exist; the loop only knew how to
 * execute a raw {url}. This wires endpointToHoledTool + fillHoledTool INTO the loop.
 */
import { describe, expect, it } from "bun:test";
import { resolveHoledExecute } from "../src/lib/holed-execute";
import type { SkillManifestLite } from "../src/lib/recommend-guard";

const manifests: SkillManifestLite[] = [
  {
    skill_id: "sk-hn",
    domain: "hn.algolia.com",
    endpoints: [
      { endpoint_id: "ep-search", method: "GET", url: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}" },
    ],
  },
];

describe("resolveHoledExecute — the loop fills a holed tool from {endpoint_id, values}", () => {
  it("builds the URL from the manifest template, not from the LLM", () => {
    const r = resolveHoledExecute({ endpoint_id: "ep-search", values: { query: "rust", tags: "story" } }, manifests);
    expect(r.kind).toBe("holed");
    if (r.kind !== "holed") return;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe("https://hn.algolia.com/api/v1/search?query=rust&tags=story");
    expect(r.method).toBe("GET");
  });

  it("rejects an endpoint_id that no resolved skill owns (anti-hallucination)", () => {
    const r = resolveHoledExecute({ endpoint_id: "ep-nope", values: { query: "x" } }, manifests);
    expect(r.kind).toBe("holed");
    if (r.kind !== "holed") return;
    expect(r.ok).toBe(false);
  });

  it("rejects a missing public hole before any fetch", () => {
    const r = resolveHoledExecute({ endpoint_id: "ep-search", values: { query: "rust" } }, manifests);
    expect(r.kind).toBe("holed");
    if (r.kind !== "holed") return;
    expect(r.ok).toBe(false);
  });

  it("falls through to the raw-url path when the LLM gave no endpoint_id", () => {
    const r = resolveHoledExecute({ url: "https://hn.algolia.com/api/v1/search?query=ai" }, manifests);
    expect(r.kind).toBe("url");
    if (r.kind !== "url") return;
    expect(r.url).toBe("https://hn.algolia.com/api/v1/search?query=ai");
  });
});
