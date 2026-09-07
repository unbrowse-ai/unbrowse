import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillManifest, WorkflowArtifact, WorkflowPublishArtifact } from "../src/types/index.js";

mock.module("nanoid", () => ({
  nanoid: () => "test-nanoid",
}));

mock.module("../src/client/index.js", () => ({
  validateManifest: async () => ({ valid: true, hardErrors: [], softWarnings: [] }),
  getApiKey: () => "local-only",
  publishSkill: async (draft: SkillManifest) => ({
    ...draft,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: draft.version ?? "1.0.0",
    warnings: draft.endpoints?.length ? [] : ["skipped_publish_empty_endpoints"],
  }),
  cachePublishedSkill: () => {},
  findExistingSkillForDomain: () => null,
  publishGraphEdges: async () => {},
}));

mock.module("../src/orchestrator/index.js", () => ({
  resolveAndExecute: async () => ({
    result: { ok: true },
    trace: { success: true },
    source: "marketplace",
    skill: undefined,
  }),
  writeSkillSnapshot: () => {},
  domainSkillCache: new Map(),
  persistDomainCache: () => {},
  getDomainReuseKey: (value?: string) => value ?? "",
  sameRouteScope: () => true,
  scopedCacheKey: (_scope: string, key: string) => key,
  snapshotPathForCacheKey: (key: string) => `/tmp/${key}.json`,
  generateLocalDescription: () => "generated description",
}));

const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;
const originalConfigPath = process.env.UNBROWSE_CONFIG_PATH;
const originalUnbrowseHome = process.env.UNBROWSE_HOME;
const suiteHome = mkdtempSync(join(tmpdir(), "unbrowse-workflow-suite-"));
process.env.UNBROWSE_HOME = suiteHome;

const { writeWorkflowArtifact } = await import("../src/workflow/artifact.js");
const { buildWorkflowPublishArtifact, readWorkflowPublishArtifact, writeWorkflowPublishArtifact } = await import("../src/workflow/publish.js");
const { queuePassiveSkillPublish, resetPassivePublishQueueForTests, passivePublishArtifactFingerprint } = await import("../src/orchestrator/passive-publish.js");
const { issueRoutePublishPermit, transitionRouteLifecycle } = await import("../src/runtime/route-lifecycle.js");
const { indexSkillLocally, publishIndexedSkill } = await import("../src/lib/indexer-core/index.js");

const tempDirs: string[] = [];

async function enableExplicitPublishing(dir: string): Promise<void> {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    contribution: { share_pointers: true, auto_review: true, passive_index: true, set_via: "mode-command" },
    capture_pipeline: { auto_publish_checkpoints: true },
  }));
  process.env.UNBROWSE_CONFIG_DIR = dir;
  process.env.UNBROWSE_CONFIG_PATH = configPath;
  const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
  _clearContributionCacheForTests();
}

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
    domain: "github.com",
    description: "workflow export skill",
    owner_type: "agent",
    base_price_usd: 0.001,
    owner_compensation_opt_in: true,
    endpoints: [
      {
        endpoint_id: "checkout-submit",
        method: "POST",
        url_template: "https://github.com/api/checkout",
        trigger_url: "https://github.com/checkout?cart_id=secret-cart",
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
        response_schema: {
          type: "object",
          properties: {
            ok: { type: "boolean", inferred_from_samples: 1 },
          },
          inferred_from_samples: 1,
        },
        semantic: {
          action_kind: "create",
          resource_kind: "checkout",
          description_out: "Submit checkout",
          description_source: "agent",
          description_needs_review: false,
        },
      },
    ],
  };
}

function makeWorkflowArtifact(): WorkflowArtifact {
  return {
    artifact_version: "1",
    skill_id: "skill-export",
    domain: "github.com",
    intent_signature: "submit checkout",
    captured_at: new Date().toISOString(),
    final_url: "https://github.com/checkout?cart_id=secret-cart",
    auth_state: {
      auth_profile_ref: "github.com-session",
      cookie_names: ["csrftoken"],
      header_names: ["x-csrf-token"],
      authenticated: true,
    },
    evidence: {
      observed_request_count: 1,
      observed_request_urls: ["https://github.com/api/checkout"],
      har_lineage_ids: ["har-1"],
      trigger_urls: ["https://github.com/checkout?cart_id=secret-cart"],
      js_bundle_urls: [],
      dom_form_hints: [],
      dom_option_hints: [],
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
          { step_id: "step-2", strategy: "browser-action", provenance: "dom-form", trigger_url: "https://github.com/checkout?cart_id=secret-cart" },
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
        replay_contract: {
          explicit_replay_only: true,
          exposure_stage: "publish",
          dependency_bindings: ["item_id", "x-csrf-token"],
          search_terms: ["post", "checkout", "item_id", "x-csrf-token"],
          parameter_specs: [
            {
              name: "item_id",
              location: "body",
              description: "Observed body parameter for POST https://github.com/api/checkout.",
              type: "string",
              required: true,
              user_supplied: true,
              default_value: "sku_1",
              example_value: "sku_1",
              source_hints: [{ source_kind: "body_default", source_name: "item_id", confidence: 0.95 }],
            },
            {
              name: "x-csrf-token",
              location: "header",
              description: "Derived header parameter populated from cookie:csrftoken.",
              type: "string",
              required: true,
              user_supplied: false,
              derived_from: ["cookie:csrftoken"],
              source_hints: [{ source_kind: "cookie", source_name: "csrftoken", confidence: 0.99 }],
            },
          ],
          prerequisite_specs: [
            {
              prerequisite_id: "pr-1",
              kind: "authenticated-session",
              name: "authenticated_session",
              description: "Requires authenticated browser or stored auth state before replay.",
              required: true,
              derived_from: "github.com-session",
            },
          ],
          next_state: [
            {
              kind: "page_url",
              value: "https://github.com/checkout?cart_id=secret-cart",
              description: "Observed page destination after successful traversal.",
            },
          ],
          payment_requirement: {
            status: "x402_required",
            price_usd: "0.001",
            currency: "USDC",
            wallet_required: true,
            provider_hint: "lobster.cash-compatible x402 wallet",
            confirmation_field: "payment_verified",
            reason: "Published replay for skill-export/checkout-submit is priced through the marketplace payment lane.",
          },
        },
      },
    ],
  };
}

afterEach(async () => {
  resetPassivePublishQueueForTests();
  if (originalConfigDir == null) delete process.env.UNBROWSE_CONFIG_DIR;
  else process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
  if (originalConfigPath == null) delete process.env.UNBROWSE_CONFIG_PATH;
  else process.env.UNBROWSE_CONFIG_PATH = originalConfigPath;
  const { _clearContributionCacheForTests } = await import("../src/config/contribution.js");
  _clearContributionCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (originalUnbrowseHome == null) delete process.env.UNBROWSE_HOME;
  else process.env.UNBROWSE_HOME = originalUnbrowseHome;
  rmSync(suiteHome, { recursive: true, force: true });
});

describe("workflow publish export", () => {
  it("censors endpoint values while preserving route and binding maps", () => {
    const artifact = buildWorkflowPublishArtifact(makeSkill(), makeWorkflowArtifact(), {
      publishStatus: "captured",
    });

    expect(artifact.publish_status).toBe("captured");
    expect(artifact.sanitized_endpoints[0]?.headers_template?.["x-csrf-token"] ?? "").toBe("");
    expect((artifact.sanitized_endpoints[0]?.body as Record<string, unknown>)?.authenticity_token).toBe("example-value");
    expect(artifact.recipes[0]?.token_bindings[0]?.candidates[0]?.source_name).toBe("csrftoken");
    expect(artifact.recipes[0]?.replay_contract.parameter_specs[0]?.name).toBe("item_id");
    expect(artifact.recipes[0]?.replay_contract.dependency_bindings).toEqual(["item_id", "x-csrf-token"]);
    expect(artifact.recipes[0]?.replay_contract.payment_requirement).toEqual({
      status: "x402_required",
      price_usd: "0.001",
      currency: "USDC",
      wallet_required: true,
      provider_hint: "lobster.cash-compatible x402 wallet",
      confirmation_field: "payment_verified",
      reason: "Published replay for skill-export/checkout-submit is priced through the marketplace payment lane.",
    });
    expect(artifact.recipes[0]?.usage_notes.some((note) => note.includes("payment: x402 0.001 USDC"))).toBe(true);
    expect(artifact.recipes[0]?.usage_notes.some((note) => note.includes("replay: explicit only"))).toBe(true);
    expect(artifact.workflow_summary.included_endpoint_count).toBe(1);
    expect(artifact.workflow_summary.root_endpoint_ids).toEqual([]);
    expect(artifact.workflow_summary.closure_added_count).toBe(0);
    expect(JSON.stringify(artifact)).not.toContain("super-secret-token");
  });

  it("filters publish export to the selected DAG closure", () => {
    const now = new Date().toISOString();
    const skill = makeSkill();
    skill.endpoints.push({
      endpoint_id: "checkout-status",
      method: "GET",
      url_template: "https://github.com/api/checkout/status/{item_id}",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      description: "Get checkout status",
      response_schema: {
        type: "object",
        properties: { ok: { type: "boolean", inferred_from_samples: 1 } },
        inferred_from_samples: 1,
      },
      semantic: {
        action_kind: "detail",
        resource_kind: "checkout",
        description_out: "Get checkout status",
        description_source: "agent",
        description_needs_review: false,
      },
    } as SkillManifest["endpoints"][number]);
    skill.operation_graph = {
      generated_at: now,
      entry_operation_ids: ["checkout-submit"],
      operations: [
        {
          operation_id: "checkout-submit",
          endpoint_id: "checkout-submit",
          method: "POST",
          url_template: "https://github.com/api/checkout",
          action_kind: "create",
          resource_kind: "checkout",
          requires: [],
          provides: [],
          confidence: 0.99,
        },
        {
          operation_id: "checkout-status",
          endpoint_id: "checkout-status",
          method: "GET",
          url_template: "https://github.com/api/checkout/status/{item_id}",
          action_kind: "detail",
          resource_kind: "checkout",
          requires: [],
          provides: [],
          confidence: 0.99,
        },
      ],
      edges: [
        {
          edge_id: "checkout-submit:checkout-status:item_id",
          from_operation_id: "checkout-submit",
          to_operation_id: "checkout-status",
          binding_key: "item_id",
          kind: "dependency",
          confidence: 0.9,
        },
      ],
    };

    const workflowArtifact = makeWorkflowArtifact();
    workflowArtifact.recipes.push({
      ...workflowArtifact.recipes[0]!,
      recipe_id: "recipe-2",
      endpoint_id: "checkout-status",
      preferred: false,
      mutation_guard: {
        confirm_unsafe_required: false,
        provenance_backed: true,
        auth_required: true,
        parameter_mapping_confident: true,
      },
      replay_contract: {
        ...workflowArtifact.recipes[0]!.replay_contract,
        parameter_specs: [
          {
            name: "item_id",
            location: "path",
            description: "Observed path parameter for GET https://github.com/api/checkout/status/{item_id}.",
            type: "string",
            required: true,
            user_supplied: false,
            derived_from: ["response:checkout-submit.item_id"],
            source_hints: [{ source_kind: "response_header", source_name: "item_id", confidence: 0.9 }],
          },
        ],
      },
    });

    const artifact = buildWorkflowPublishArtifact(skill, workflowArtifact, {
      publishStatus: "published",
      endpointIds: ["checkout-submit", "checkout-status"],
      rootEndpointIds: ["checkout-submit"],
    });

    expect(artifact.sanitized_endpoints.map((endpoint) => endpoint.endpoint_id)).toEqual([
      "checkout-submit",
      "checkout-status",
    ]);
    expect(artifact.recipes.map((recipe) => recipe.endpoint_id)).toEqual([
      "checkout-submit",
      "checkout-status",
    ]);
    expect(artifact.workflow_summary.root_endpoint_ids).toEqual(["checkout-submit"]);
    expect(artifact.workflow_summary.closure_added_count).toBe(1);
    expect(artifact.docs.bullets.some((bullet) => bullet.includes("publish closure: 1 root step + 1 DAG-linked dependent step"))).toBe(true);
  });

  it("persists a publish export and upgrades status on passive publish", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unbrowse-workflow-export-"));
    tempDirs.push(tmp);
    await enableExplicitPublishing(tmp);

    const skill = makeSkill();
    const workflowArtifact = makeWorkflowArtifact();
    writeWorkflowArtifact(workflowArtifact);
    writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(skill, workflowArtifact, {
      publishStatus: "captured",
    }));

    const routeIdentity = {
      principal_scope: "principal:workflow-export-test",
      skill_id: skill.skill_id,
      endpoint_fingerprint: `${skill.endpoints[0]!.method}:${skill.endpoints[0]!.url_template}`,
      intent_shape_hash: skill.intent_signature,
    };
    const lifecycleFile = join(tmp, "route-lifecycle.json");
    await transitionRouteLifecycle(routeIdentity, {
      type: "browser_observed", baseline_fingerprint: "baseline", dag_fingerprint: "dag",
    }, { file: lifecycleFile });
    await transitionRouteLifecycle(routeIdentity, {
      type: "api_validation_succeeded", baseline_fingerprint: "baseline", dag_fingerprint: "dag",
    }, { file: lifecycleFile });
    const publishPermit = await issueRoutePublishPermit(
      routeIdentity,
      passivePublishArtifactFingerprint(skill),
      { file: lifecycleFile },
    );

    await queuePassiveSkillPublish(skill, {
      parity: "pass",
      publish_permit: publishPermit,
      route_identity: routeIdentity,
      lifecycle_store: { file: lifecycleFile },
      deps: {
        publishSkill: async (draft: SkillManifest) => ({
          ...draft,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: "1.0.0",
          published_remotely: true,
        } as SkillManifest & { published_remotely: boolean }),
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

  it("keeps legacy explicit publish local without lifecycle proof", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unbrowse-workflow-indexed-"));
    tempDirs.push(tmp);
    await enableExplicitPublishing(tmp);

    const skill = makeSkill();
    skill.endpoints.push({
      endpoint_id: "checkout-status",
      method: "GET",
      url_template: "https://github.com/api/checkout/status/{item_id}",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      description: "Get checkout status",
      response_schema: {
        type: "object",
        properties: { ok: { type: "boolean", inferred_from_samples: 1 } },
        inferred_from_samples: 1,
      },
      semantic: {
        action_kind: "detail",
        resource_kind: "checkout",
        description_out: "Get checkout status",
        description_source: "agent",
        description_needs_review: false,
      },
    } as SkillManifest["endpoints"][number]);
    skill.operation_graph = {
      generated_at: new Date().toISOString(),
      entry_operation_ids: ["checkout-submit"],
      operations: [
        {
          operation_id: "checkout-submit",
          endpoint_id: "checkout-submit",
          method: "POST",
          url_template: "https://github.com/api/checkout",
          action_kind: "create",
          resource_kind: "checkout",
          requires: [],
          provides: [],
          confidence: 0.99,
        },
        {
          operation_id: "checkout-status",
          endpoint_id: "checkout-status",
          method: "GET",
          url_template: "https://github.com/api/checkout/status/{item_id}",
          action_kind: "detail",
          resource_kind: "checkout",
          requires: [],
          provides: [],
          confidence: 0.99,
        },
      ],
      edges: [
        {
          edge_id: "checkout-submit:checkout-status:item_id",
          from_operation_id: "checkout-submit",
          to_operation_id: "checkout-status",
          binding_key: "item_id",
          kind: "dependency",
          confidence: 0.9,
        },
      ],
    };
    const workflowArtifact = makeWorkflowArtifact();
    workflowArtifact.recipes.push({
      ...workflowArtifact.recipes[0]!,
      recipe_id: "recipe-2",
      endpoint_id: "checkout-status",
      preferred: false,
      mutation_guard: {
        confirm_unsafe_required: false,
        provenance_backed: true,
        auth_required: true,
        parameter_mapping_confident: true,
      },
      replay_contract: {
        ...workflowArtifact.recipes[0]!.replay_contract,
        parameter_specs: [
          {
            name: "item_id",
            location: "path",
            description: "Observed path parameter for GET https://github.com/api/checkout/status/{item_id}.",
            type: "string",
            required: true,
            user_supplied: false,
            derived_from: ["response:checkout-submit.item_id"],
            source_hints: [{ source_kind: "response_header", source_name: "item_id", confidence: 0.9 }],
          },
        ],
      },
    });
    writeWorkflowArtifact(workflowArtifact);

    const indexed = await indexSkillLocally({
      skill,
      domain: skill.domain,
      intent: skill.intent_signature,
      cacheKey: `test:${skill.domain}`,
    });

    let exported = readWorkflowPublishArtifact(skill.skill_id) as WorkflowPublishArtifact;
    expect(exported.publish_status).toBe("indexed");
    expect(exported.published_at).toBeUndefined();

    const published = await publishIndexedSkill(indexed);
    expect(published.published).toBe(false);
    expect(published.publishStatus).toBe("indexed");

    exported = readWorkflowPublishArtifact(skill.skill_id) as WorkflowPublishArtifact;
    expect(exported.publish_status).toBe("indexed");
    expect(exported.published_at).toBeUndefined();
    expect(exported.workflow_summary.included_endpoint_count).toBe(2);
    expect(exported.workflow_summary.root_endpoint_ids).toEqual([
      "checkout-status",
      "checkout-submit",
    ]);
    expect(exported.workflow_summary.closure_added_count).toBe(0);
    expect(exported.recipes.map((recipe) => recipe.endpoint_id)).toEqual([
      "checkout-submit",
      "checkout-status",
    ]);
  });

  it("keeps unreviewed legacy publication local before validation", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unbrowse-workflow-review-gate-"));
    tempDirs.push(tmp);
    await enableExplicitPublishing(tmp);

    const skill = makeSkill();
    skill.endpoints[0] = {
      ...skill.endpoints[0]!,
      description: "Search form for github.com",
      response_schema: {
        type: "array",
        inferred_from_samples: 1,
        items: {
          type: "object",
          inferred_from_samples: 1,
          properties: {
            type: { type: "string", inferred_from_samples: 1 },
            data: { type: "array", inferred_from_samples: 1, items: { type: "string", inferred_from_samples: 1 } },
            relevance_score: { type: "number", inferred_from_samples: 1 },
          },
        },
      },
      semantic: {
        action_kind: "timeline",
        resource_kind: "form",
        description_in: "No additional inputs required",
        description_out: "Returns forms timeline with relevance score",
        description_source: "auto",
        description_needs_review: true,
        description_warning: "Auto-generated description. Review before trusting or publishing.",
        response_summary: "[].type, [].data, [].relevance_score, [].data[]",
        example_fields: ["[].type", "[].data", "[].relevance_score"],
        requires: [],
        provides: [],
        negative_tags: [],
        confidence: 0.8,
        observed_at: new Date().toISOString(),
      },
    };

    const indexed = await indexSkillLocally({
      skill,
      domain: skill.domain,
      intent: skill.intent_signature,
      cacheKey: `test:${skill.domain}:needs-review`,
    });

    const published = await publishIndexedSkill(indexed);
    expect(published.published).toBe(false);
    expect(published.publishStatus).toBe("indexed");
    expect(published.validationErrors).toBeUndefined();

    const exported = readWorkflowPublishArtifact(skill.skill_id) as WorkflowPublishArtifact;
    expect(exported.publish_status).toBe("indexed");
    expect(exported.validation_errors).toBeUndefined();
  });
});
