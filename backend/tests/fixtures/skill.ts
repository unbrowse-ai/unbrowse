import type { SkillManifest } from "../../src/types";

/** One shared skill fixture for the skill-primitive weld tests (was copy-pasted
 *  across four files — John 15:2). Override any field via `over`. */
export function makeSkill(over: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "skill_acme_123",
    version: "1.0.0",
    schema_version: "1",
    name: "acme-search",
    intent_signature: "search acme products",
    domain: "acme.com",
    description: "Acme product search + detail API",
    owner_type: "agent",
    execution_type: "http",
    owner_agent_id: "agent_owner_9",
    endpoints: [
      { endpoint_id: "ep_search", method: "GET", url_template: "https://acme.com/api/search?q={q}", description: "Search products by keyword", reliability_score: 0.91, verification_status: "verified" },
      { endpoint_id: "ep_detail", method: "GET", url_template: "https://acme.com/api/product/{id}", description: "Fetch one product's detail", reliability_score: 0.88, verification_status: "verified" },
    ],
    lifecycle: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as unknown as SkillManifest;
}
