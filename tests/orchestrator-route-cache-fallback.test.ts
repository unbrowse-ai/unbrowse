import { describe, expect, test } from "bun:test";
import {
  chooseBestRouteCacheCandidate,
  isCachedSkillRelevantForIntent,
  shouldFallbackToLiveCaptureAfterAutoexecFailure,
} from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

function makeSkill(): SkillManifest {
  return {
    skill_id: "lawnet-skill",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "LawNet",
    intent_signature: "search cases",
    domain: "www.lawnet.sg",
    description: "LawNet search",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id: "artifact",
        method: "GET",
        url_template: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Captured page artifact for search cases",
        trigger_url: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
        },
        dom_extraction: {
          extraction_method: "repeated-elements",
          confidence: 0.8,
          selector: "div.results",
        },
        semantic: {
          action_kind: "search",
          resource_kind: "document",
          description_out: "Captured page artifact for search cases",
        },
      },
      {
        endpoint_id: "structured-search",
        method: "POST",
        url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.7,
        description: "Searches documents with titles",
        trigger_url: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
        body: {
          basicSearchKey: "{basic_search_key}",
          grouping: "1",
        },
        body_params: {
          basic_search_key: "assessment of damages new evidence",
        },
        response_schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              link: { type: "string" },
            },
          },
        },
        dom_extraction: {
          extraction_method: "repeated-elements",
          confidence: 0.9,
          selector: "div.results",
        },
        semantic: {
          action_kind: "search",
          resource_kind: "document",
          description_in: "Requires basic_search_key",
          description_out: "Searches documents with titles",
        },
      },
    ],
    intents: ["search cases"],
    operation_graph: { operations: [], edges: [] },
  };
}

describe("chooseBestRouteCacheCandidate", () => {
  const intent = "search for high court case assessment of damages new evidence adduced after tranches started";
  const contextUrl = "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search";

  test("prefers global structured-search snapshot over stale scoped page artifact", () => {
    const skill = makeSkill();
    const chosen = chooseBestRouteCacheCandidate(
      [
        {
          scopedKey: "cli-1:www.lawnet.sg:search:https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
          scope: "cli-1",
          entry: {
            skillId: skill.skill_id,
            domain: skill.domain,
            endpointId: "artifact",
            ts: 100,
          },
          skill,
        },
        {
          scopedKey: "global:www.lawnet.sg:search:https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
          scope: "global",
          entry: {
            skillId: skill.skill_id,
            domain: skill.domain,
            endpointId: "structured-search",
            ts: 90,
          },
          skill,
        },
      ],
      intent,
      contextUrl,
    );

    expect(chosen?.scope).toBe("global");
    expect(chosen?.entry.endpointId).toBe("structured-search");
  });

  test("keeps current scoped cache when it already points at the good endpoint", () => {
    const skill = makeSkill();
    const chosen = chooseBestRouteCacheCandidate(
      [
        {
          scopedKey: "cli-1:www.lawnet.sg:search:https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
          scope: "cli-1",
          entry: {
            skillId: skill.skill_id,
            domain: skill.domain,
            endpointId: "structured-search",
            ts: 100,
          },
          skill,
        },
        {
          scopedKey: "global:www.lawnet.sg:search:https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
          scope: "global",
          entry: {
            skillId: skill.skill_id,
            domain: skill.domain,
            endpointId: "artifact",
            ts: 90,
          },
          skill,
        },
      ],
      intent,
      contextUrl,
    );

    expect(chosen?.scope).toBe("cli-1");
    expect(chosen?.entry.endpointId).toBe("structured-search");
  });
});

describe("shouldFallbackToLiveCaptureAfterAutoexecFailure", () => {
  test("falls through to live capture when cached auto-exec exhausts all candidates on a real page", () => {
    expect(
      shouldFallbackToLiveCaptureAfterAutoexecFailure(
        true,
        "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      ),
    ).toBe(true);
  });

  test("keeps deferral when there is no page context to capture", () => {
    expect(shouldFallbackToLiveCaptureAfterAutoexecFailure(true, undefined)).toBe(false);
    expect(shouldFallbackToLiveCaptureAfterAutoexecFailure(false, "https://www.lawnet.sg")).toBe(
      false,
    );
  });
});

describe("isCachedSkillRelevantForIntent", () => {
  test("rejects single search page artifacts that only mirror the same search shell", () => {
    const contextUrl = "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search";
    const skill: SkillManifest = {
      skill_id: "lawnet-capture-artifact",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: "LawNet captured page",
      intent_signature: "search cases",
      domain: "www.lawnet.sg",
      description: "LawNet captured page artifact",
      owner_type: "agent",
      endpoints: [
        {
          endpoint_id: "artifact",
          method: "GET",
          url_template: contextUrl,
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.8,
          description: "Captured page artifact for search cases",
          trigger_url: contextUrl,
          response_schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              link: { type: "string" },
            },
          },
          dom_extraction: {
            extraction_method: "key-value",
            confidence: 0.8,
            selector: "div#layout-column_column-2",
          },
          semantic: {
            action_kind: "search",
            resource_kind: "resource",
            description_out: "Captured page artifact for search cases",
          },
        },
      ],
      intents: ["search cases"],
      operation_graph: { operations: [], edges: [] },
    };

    expect(
      isCachedSkillRelevantForIntent(
        skill,
        "search Singapore case law for leave to adduce new evidence after assessment of damages started",
        contextUrl,
      ),
    ).toBe(false);
  });
});
