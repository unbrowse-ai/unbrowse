import { describe, expect, it } from "bun:test";
import { isCachedSkillRelevantForIntent, pickPreferredSkillSnapshot } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

describe("snapshot repair", () => {
  it("prefers the richer local snapshot for the same skill", () => {
    const stale: SkillManifest = {
      skill_id: "lawnet-skill",
      domain: "www.lawnet.sg",
      lifecycle: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: "1.0.0",
      endpoint_count: 1,
      endpoints: [
        {
          endpoint_id: "artifact",
          method: "GET",
          url_template: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
          description: "Captured page artifact for search",
          verification_status: "verified",
          reliability_score: 1,
          idempotency: "safe",
        },
      ],
      intents: ["search"],
    };

    const rich: SkillManifest = {
      ...stale,
      endpoint_count: 2,
      endpoints: [
        stale.endpoints[0]!,
        {
          endpoint_id: "duk",
          method: "POST",
          url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
          description: "Searches documents with title, citation, court",
          body_params: { basic_search_key: "leave to adduce new evidence" },
          dom_extraction: { extraction_method: "repeated-elements", selector: "#results", confidence: 0.9 },
          response_schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                citation: { type: "string" },
              },
            },
          },
          verification_status: "unverified",
          reliability_score: 0.5,
          idempotency: "safe",
        },
      ],
    };

    expect(pickPreferredSkillSnapshot(stale, [rich]).endpoints).toHaveLength(2);
    expect(pickPreferredSkillSnapshot(rich, [stale]).endpoints).toHaveLength(2);
  });

  it("treats same-context structured search endpoints as relevant for long search prompts", () => {
    const skill: SkillManifest = {
      skill_id: "lawnet-skill",
      domain: "www.lawnet.sg",
      lifecycle: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: "1.0.0",
      endpoint_count: 1,
      endpoints: [
        {
          endpoint_id: "duk",
          method: "POST",
          url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
          trigger_url: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
          description: "Searches LawNet case rows",
          body_params: { basic_search_key: "stale captured query" },
          dom_extraction: { extraction_method: "repeated-elements", selector: "#results", confidence: 0.9 },
          response_schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
            },
          },
          verification_status: "unverified",
          reliability_score: 0.5,
          idempotency: "safe",
        },
      ],
      intents: ["search"],
    };

    const relevant = isCachedSkillRelevantForIntent(
      skill,
      "im doing an application for leave to adduce new evidence at a late stage after the notice for appointment for assessment of damages and need the high court case where the ad had already started and the court still allowed new evidence",
      "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
    );
    expect(relevant).toBe(true);
  });

});
