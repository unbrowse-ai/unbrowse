import { describe, expect, it } from "bun:test";
import { marketplaceSkillMatchesContext, selectSkillIdsToHydrate } from "../src/orchestrator/index.js";

function meta(skillId: string, endpointId: string, domain: string): Record<string, unknown> {
  return {
    content: JSON.stringify({
      skill_id: skillId,
      endpoint_id: endpointId,
      domain,
    }),
  };
}

describe("marketplace hydration selection", () => {
  it("prioritizes requested-domain skills, dedupes by skill, and caps hydration count", () => {
    const selected = selectSkillIdsToHydrate(
      [
        { metadata: meta("global-1", "ep-a", "example.com") },
        { metadata: meta("target-1", "ep-b", "finance.yahoo.com") },
        { metadata: meta("global-2", "ep-c", "reddit.com") },
        { metadata: meta("target-1", "ep-d", "finance.yahoo.com") },
        { metadata: meta("target-2", "ep-e", "query2.finance.yahoo.com") },
        { metadata: meta("global-3", "ep-f", "github.com") },
        { metadata: meta("target-3", "ep-g", "yahoo.com") },
        { metadata: meta("global-4", "ep-h", "linkedin.com") },
        { metadata: meta("global-5", "ep-i", "walmart.com") },
      ],
      "finance.yahoo.com",
      4,
    );

    expect(selected).toEqual(["target-1", "target-2", "target-3", "global-1"]);
  });

  it("rejects mismatched page-artifact-only skills for concrete detail urls", () => {
    expect(marketplaceSkillMatchesContext({
      skill_id: "skill-1",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: "2026-03-13T00:00:00.000Z",
      updated_at: "2026-03-13T00:00:00.000Z",
      name: "www.saucedemo.com",
      intent_signature: "www.saucedemo.com",
      domain: "www.saucedemo.com",
      description: "API skill for www.saucedemo.com",
      owner_type: "agent",
      endpoints: [{
        endpoint_id: "inventory-page",
        method: "GET",
        url_template: "https://www.saucedemo.com/inventory.html",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Captured page artifact for get products",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
      }],
      intents: ["get products"],
      index_status: "ok",
    } as any, "get product details", "https://www.saucedemo.com/inventory-item.html?id=4")).toBe(false);
  });

  it("rejects localhost skills captured on a different port", () => {
    expect(marketplaceSkillMatchesContext({
      skill_id: "skill-localhost-admin",
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active",
      execution_type: "http",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      name: "localhost admin",
      intent_signature: "localhost admin",
      domain: "localhost",
      description: "API skill for localhost admin",
      owner_type: "agent",
      endpoints: [{
        endpoint_id: "admin-home",
        method: "GET",
        url_template: "http://localhost:7780/",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        description: "Captured page artifact for admin dashboard",
        trigger_url: "http://localhost:7780/",
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
      }],
      intents: ["admin dashboard"],
      index_status: "ok",
    } as any, "count reddit comments", "http://localhost:9999")).toBe(false);
  });
});
