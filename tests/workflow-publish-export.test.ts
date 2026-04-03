import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillManifest, WorkflowArtifact, WorkflowPublishArtifact } from "../src/types/index.js";
import { writeWorkflowArtifact } from "../src/workflow/artifact.js";
import { buildWorkflowPublishArtifact, readWorkflowPublishArtifact, writeWorkflowPublishArtifact } from "../src/workflow/publish.js";
import { queuePassiveSkillPublish, resetPassivePublishQueueForTests } from "../src/orchestrator/passive-publish.js";

const tempDirs: string[] = [];
const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;

function makeSkill(): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "skill-export",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: now,
    updated_at: now,
    name: "export-skill",
    intent_signature: "submit checkout",
    domain: "example.com",
    description: "workflow export skill",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id: "checkout-submit",
        method: "POST",
        url_template: "https://example.com/api/checkout",
        trigger_url: "https://example.com/checkout?cart_id=secret-cart",
        headers_template: {
          "x-csrf-token": "super-secret-token",
        },
        body: {
          authenticity_token: "super-secret-token",
          item_id: "sku_1",
        },
        idempotency: "unsafe",
        verification_status: "verified",
        reliability_score: 1,
        description: "Submit checkout",
      },
    ],
  };
}

function makeWorkflowArtifact(): WorkflowArtifact {
  return {
    artifact_version: "1",
    skill_id: "skill-export",
    domain: "example.com",
    intent_signature: "submit checkout",
    captured_at: new Date().toISOString(),
    final_url: "https://example.com/checkout?cart_id=secret-cart",
    auth_state: {
      auth_profile_ref: "example.com-session",
      cookie_names: ["csrftoken"],
      header_names: ["x-csrf-token"],
      authenticated: true,
    },
    evidence: {
      observed_request_count: 1,
      observed_request_urls: ["https://example.com/api/checkout"],
      har_lineage_ids: ["har-1"],
      trigger_urls: ["https://example.com/checkout?cart_id=secret-cart"],
      js_bundle_urls: [],
      dom_form_hints: [],
      meta_hints: [],
      bootstrap_hints: [],
    },
    recipes: [
      {
        recipe_id: "recipe-1",
        endpoint_id: "checkout-submit",
        preferred: true,
        provenance_backed: true,
        last_successful_strategy: "server",
        steps: [
          { step_id: "step-1", strategy: "server", provenance: "observed-request" },
          { step_id: "step-2", strategy: "browser-action", provenance: "dom-form", trigger_url: "https://example.com/checkout?cart_id=secret-cart" },
        ],
        token_bindings: [
          {
            binding_id: "binding-1",
            target_location: "header",
            target_name: "x-csrf-token",
            refresh_on_statuses: [401, 403],
            candidates: [
              {
                source_kind: "cookie",
                source_name: "csrftoken",
                observed_value: "super-secret-token",
                confidence: 0.99,
              },
            ],
            selected_source_kind: "cookie",
            selected_source_name: "csrftoken",
          },
        ],
        mutation_guard: {
          confirm_unsafe_required: true,
          provenance_backed: true,
          auth_required: true,
          parameter_mapping_confident: true,
        },
      },
    ],
  };
}

afterEach(() => {
  resetPassivePublishQueueForTests();
  if (originalConfigDir == null) delete process.env.UNBROWSE_CONFIG_DIR;
  else process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow publish export", () => {
  it("censors endpoint values while preserving route and binding maps", () => {
    const artifact = buildWorkflowPublishArtifact(makeSkill(), makeWorkflowArtifact(), {
      publishStatus: "captured",
    });

    expect(artifact.publish_status).toBe("captured");
    expect(artifact.sanitized_endpoints[0]?.headers_template?.["x-csrf-token"]).toBe("");
    expect((artifact.sanitized_endpoints[0]?.body as Record<string, unknown>)?.authenticity_token).toBe("example-value");
    expect(artifact.recipes[0]?.token_bindings[0]?.candidates[0]?.source_name).toBe("csrftoken");
    expect(JSON.stringify(artifact)).not.toContain("super-secret-token");
  });

  it("persists a publish export and upgrades status on passive publish", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unbrowse-workflow-export-"));
    tempDirs.push(tmp);
    process.env.UNBROWSE_CONFIG_DIR = tmp;

    const skill = makeSkill();
    const workflowArtifact = makeWorkflowArtifact();
    writeWorkflowArtifact(workflowArtifact);
    writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(skill, workflowArtifact, {
      publishStatus: "captured",
    }));

    await queuePassiveSkillPublish(skill, {
      deps: {
        publishSkill: async (draft: SkillManifest) => ({
          ...draft,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: "1.0.0",
        }),
        cachePublishedSkill: () => {},
        validateManifest: async () => ({ valid: true, hardErrors: [], softWarnings: [] }),
      },
    });

    const exported = readWorkflowPublishArtifact(skill.skill_id) as WorkflowPublishArtifact;
    expect(exported.publish_status).toBe("published");
    expect(exported.published_at).toBeDefined();

    const serialized = readFileSync(join(tmp, "workflow-exports", `${skill.skill_id}.json`), "utf-8");
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).toContain("\"token_bindings\"");
  });
});
