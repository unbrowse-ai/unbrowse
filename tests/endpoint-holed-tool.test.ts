/**
 * endpointToHoledTool — the PII-censored tool-with-holes the server recommends
 * and the CLIENT populates (path-A, corrected shape).
 *
 * The server must NOT hand back a populated command with the caller's data /
 * credentials filled in. It returns the endpoint as a TOOL WITH HOLES: the
 * url_template + the typed slots the client fills itself — query/path params
 * from its own prompt (kind:id, fill:llm), auth headers / cookies from its
 * local vault (kind:secret, fill:vault). No values, no credentials ever leave
 * for the server to fill. The client populates the holes and executes.
 *
 * Red under HEAD — endpointToHoledTool does not exist.
 */
import { describe, expect, it } from "bun:test";
import { endpointToHoledTool } from "../src/skillmd.js";
import type { SkillManifest } from "../src/types/skill.js";

function skill(): SkillManifest {
  return {
    skill_id: "sk1", version: "1.0.0", schema_version: "1", name: "HN",
    intent_signature: "search hn", domain: "hn.algolia.com", description: "d",
    owner_type: "agent", execution_type: "http", lifecycle: "active", updated_at: "2026-06-01T00:00:00Z",
    endpoints: [
      {
        endpoint_id: "ep-search",
        method: "GET",
        url_template: "https://hn.algolia.com/api/v1/search?query={query}&tags={tags}",
        headers_template: { authorization: "Bearer SECRET", accept: "application/json" },
        description: "search",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
    ],
  } as SkillManifest;
}

describe("endpointToHoledTool", () => {
  it("exposes the url_template + every {placeholder} as a caller-filled hole", () => {
    const tool = endpointToHoledTool(skill(), skill().endpoints[0]);
    expect(tool.endpoint_id).toBe("ep-search");
    expect(tool.method).toBe("GET");
    expect(tool.url_template).toContain("{query}");
    const qHoles = tool.holes.filter((h) => h.location.in === "query");
    const names = qHoles.map((h) => h.name).sort();
    expect(names).toEqual(["query", "tags"]);
    // public params are filled by the client's agent from the prompt
    for (const h of qHoles) {
      expect(h.kind).toBe("id");
      expect(h.fill).toBe("llm");
    }
  });

  it("exposes auth headers as SECRET holes filled from the client's vault", () => {
    const tool = endpointToHoledTool(skill(), skill().endpoints[0]);
    const auth = tool.holes.find((h) => h.location.in === "header" && h.name.toLowerCase() === "authorization");
    expect(auth).toBeDefined();
    expect(auth?.kind).toBe("secret");
    expect(auth?.fill).toBe("vault");
    // a non-secret header (accept) is inert structure, not a hole
    expect(tool.holes.some((h) => h.name.toLowerCase() === "accept")).toBe(false);
  });

  it("carries NO values or credentials — PII-censored, shape only", () => {
    const tool = endpointToHoledTool(skill(), skill().endpoints[0]);
    const json = JSON.stringify(tool);
    expect(json).not.toContain("Bearer SECRET");
    expect(json).not.toContain("SECRET");
    // holes name the slots, never their values
    for (const h of tool.holes) {
      expect(h).not.toHaveProperty("value");
    }
  });
});
