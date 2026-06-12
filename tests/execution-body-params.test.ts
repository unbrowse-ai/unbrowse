import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSkill } from "../src/execution/index.js";
import type { SkillManifest, WorkflowArtifact } from "../src/types/index.js";
import { writeWorkflowArtifact } from "../src/workflow/artifact.js";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.UNBROWSE_CONFIG_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSkill(): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "skill-action",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: now,
    updated_at: now,
    name: "action-skill",
    intent_signature: "create note",
    domain: "example.com",
    description: "action skill",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id: "create-note",
        method: "POST",
        url_template: "https://example.com/api/notes",
        body: {
          title: "{title}",
          description: "{description}",
          completed: false,
        },
        body_params: {
          title: "hello",
          description: "world",
        },
        idempotency: "unsafe",
        verification_status: "verified",
        reliability_score: 1,
      },
    ],
  };
}

describe("execution body param defaults", () => {
  it("uses reverse-engineered body param defaults during dry run", async () => {
    const out = await executeSkill(makeSkill(), {}, undefined, { dry_run: true });
    expect((out.result as Record<string, unknown>).dry_run).toBe(true);
    expect((out.result as Record<string, any>).would_execute.body).toEqual({
      title: "hello",
      description: "world",
      completed: false,
    });
  });

  it("rejects invalid explicit replay params against the published contract before network execution", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unbrowse-exec-contract-"));
    tempDirs.push(tmp);
    process.env.UNBROWSE_CONFIG_DIR = tmp;

    const skill: SkillManifest = {
      ...makeSkill(),
      skill_id: "skill-replay-contract",
      endpoints: [
        {
          endpoint_id: "list-notes",
          method: "GET",
          url_template: "https://example.com/api/notes?audience={audience}",
          query: { audience: "resident" },
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 1,
          response_schema: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string", inferred_from_samples: 1 } },
              inferred_from_samples: 1,
            },
            inferred_from_samples: 1,
          },
        },
      ],
    };

    const artifact: WorkflowArtifact = {
      artifact_version: "1",
      skill_id: skill.skill_id,
      domain: skill.domain,
      intent_signature: skill.intent_signature,
      captured_at: new Date().toISOString(),
      final_url: "https://example.com/notes",
      auth_state: { cookie_names: [], header_names: [], authenticated: false },
      evidence: {
        observed_request_count: 1,
        observed_request_urls: ["https://example.com/api/notes?audience=resident"],
        har_lineage_ids: ["har-1"],
        trigger_urls: [],
        js_bundle_urls: [],
        dom_form_hints: [],
        dom_option_hints: [],
        meta_hints: [],
        bootstrap_hints: [],
      },
      recipes: [
        {
          recipe_id: "recipe-1",
          endpoint_id: "list-notes",
          preferred: true,
          provenance_backed: true,
          steps: [{ step_id: "step-1", strategy: "server", provenance: "observed-request" }],
          token_bindings: [],
          mutation_guard: {
            confirm_unsafe_required: false,
            provenance_backed: true,
            auth_required: false,
            parameter_mapping_confident: true,
          },
          replay_contract: {
            explicit_replay_only: true,
            exposure_stage: "publish",
            dependency_bindings: [],
            search_terms: [],
            parameter_specs: [
              {
                name: "audience",
                location: "query",
                description: "Observed query parameter for GET https://example.com/api/notes.",
                type: "string",
                required: true,
                user_supplied: true,
                default_value: "resident",
                example_value: "resident",
                enum_values: ["resident", "non-resident"],
                source_hints: [{ source_kind: "query_default", source_name: "audience", confidence: 0.95 }],
              },
            ],
            prerequisite_specs: [],
            next_state: [{ kind: "response_schema", value: "title", description: "Observed response shape summary for replay validation." }],
            payment_requirement: {
              status: "free",
              wallet_required: false,
              reason: "No x402 payment requirement was recorded for this replay contract at publish time.",
            },
          },
        },
      ],
    };
    writeWorkflowArtifact(artifact);

    const out = await executeSkill(skill, { audience: "tourist" }, { raw: true });
    expect((out.result as Record<string, unknown>).error).toBe("invalid_replay_params");
    expect((out.result as Record<string, any>).validation_errors).toEqual([
      { name: "audience", reason: "invalid_enum", allowed_values: ["resident", "non-resident"] },
    ]);
  });
});
