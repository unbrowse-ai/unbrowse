import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CaptureResult } from "../src/capture/index.js";
import type { SkillManifest } from "../src/types/index.js";
import { mergeWorkflowArtifacts, readWorkflowArtifact, recordWorkflowRecipeOutcome, writeWorkflowArtifact } from "../src/workflow/artifact.js";
import { buildWorkflowArtifactFromCapture } from "../src/workflow/compile.js";
import { needsWorkflowTokenRefresh, pickWorkflowRecipe, resolveWorkflowBindings, validateWorkflowReplayParams } from "../src/workflow/runtime.js";

function makeSkill(): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "skill-workflow",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: now,
    updated_at: now,
    name: "workflow-skill",
    intent_signature: "submit checkout",
    domain: "example.com",
    description: "workflow skill",
    owner_type: "agent",
    auth_profile_ref: "example.com-session",
    endpoints: [
      {
        endpoint_id: "checkout-submit",
        method: "POST",
        url_template: "https://example.com/api/checkout",
        trigger_url: "https://example.com/checkout",
        body: {
          item_id: "{item_id}",
          authenticity_token: "{authenticity_token}",
        },
        body_params: {
          item_id: "sku_1",
        },
        idempotency: "unsafe",
        verification_status: "verified",
        reliability_score: 1,
      },
    ],
  };
}

function makeCapture(): CaptureResult {
  return {
    domain: "example.com",
    har_lineage_id: "har-1",
    final_url: "https://example.com/checkout",
    cookies: [
      { name: "csrftoken", value: "captured-cookie", domain: ".example.com" },
      { name: "sessionid", value: "session-1", domain: ".example.com" },
    ],
    html: `
      <html>
        <head>
          <meta name="csrf-token" content="meta-token" />
          <script type="application/json">
            {"page":{"csrfToken":"bootstrap-token","checkout":{"nonce":"boot-nonce"}}}
          </script>
        </head>
        <body>
          <form id="checkout-form" action="/checkout" method="post">
            <input type="hidden" name="authenticity_token" value="dom-token" />
            <input type="hidden" name="item_id" value="sku_1" />
          </form>
        </body>
      </html>
    `,
    requests: [
      {
        url: "https://example.com/api/checkout",
        method: "POST",
        request_headers: {
          cookie: "csrftoken=captured-cookie; sessionid=session-1",
          "x-csrf-token": "captured-cookie",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        request_body: "item_id=sku_1&authenticity_token=captured-cookie",
        response_status: 200,
        response_headers: {
          "content-type": "application/json",
          "x-checkout-nonce": "response-nonce",
        },
        response_body: "{\"ok\":true}",
        timestamp: new Date().toISOString(),
        triggered_by_step: 1,
        triggered_by_action: "click",
        triggered_by_ref: "submit-button",
      },
    ],
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.UNBROWSE_CONFIG_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow artifact compile/runtime", () => {
  it("infers generalized token lineage from cookies, form fields, meta, and bootstrap json", () => {
    const artifact = buildWorkflowArtifactFromCapture(makeSkill(), makeCapture(), {
      authHeaders: { "x-session-proof": "proof-token" },
    });
    const recipe = artifact.recipes[0];
    expect(recipe.mutation_guard.provenance_backed).toBe(true);
    expect(recipe.token_bindings.length).toBeGreaterThanOrEqual(2);

    const headerBinding = recipe.token_bindings.find((binding) => binding.target_name === "x-csrf-token");
    const formBinding = recipe.token_bindings.find((binding) => binding.target_name === "authenticity_token");
    expect(headerBinding?.candidates.some((candidate) => candidate.source_kind === "cookie" && candidate.source_name === "csrftoken")).toBe(true);
    expect(formBinding?.candidates.some((candidate) => candidate.source_kind === "cookie" && candidate.source_name === "csrftoken")).toBe(true);
    expect(formBinding?.candidates.some((candidate) => candidate.source_kind === "hidden_input" && candidate.source_name === "authenticity_token")).toBe(true);
    expect(artifact.evidence.meta_hints.some((hint) => hint.key === "csrf-token")).toBe(true);
    expect(artifact.evidence.bootstrap_hints.some((hint) => hint.path.includes("csrfToken"))).toBe(true);
    expect(recipe.replay_contract.explicit_replay_only).toBe(true);
    expect(recipe.replay_contract.dependency_bindings).toContain("item_id");
    expect(recipe.replay_contract.search_terms).toContain("checkout");
    expect(recipe.replay_contract.parameter_specs.some((param) => param.name === "item_id" && param.user_supplied)).toBe(true);
    expect(recipe.replay_contract.parameter_specs.some((param) => param.name === "authenticity_token" && !param.user_supplied)).toBe(true);
    expect(recipe.replay_contract.prerequisite_specs.some((prereq) => prereq.kind === "token-binding")).toBe(true);
  });

  it("builds provenance-backed browser-action recipes from observed action traces", () => {
    const artifact = buildWorkflowArtifactFromCapture(makeSkill(), makeCapture());
    const recipe = artifact.recipes[0];
    expect(recipe.steps.some((step) => step.strategy === "browser-action")).toBe(true);
    const browserAction = recipe.steps.find((step) => step.strategy === "browser-action");
    expect(browserAction?.action_sequence?.[0]?.action).toBe("click");
    expect(browserAction?.action_sequence?.[0]?.ref).toBe("submit-button");
    expect(recipe.steps.some((step) => step.strategy === "trigger-intercept")).toBe(true);
  });

  it("resolves bindings from freshest runtime auth state instead of stale captured values", () => {
    const artifact = buildWorkflowArtifactFromCapture(makeSkill(), makeCapture());
    const recipe = artifact.recipes[0];
    const resolved = resolveWorkflowBindings(recipe, {
      artifact,
      authHeaders: {},
      cookies: [
        { name: "csrftoken", value: "fresh-cookie", domain: ".example.com" },
        { name: "sessionid", value: "session-2", domain: ".example.com" },
      ],
      body: { item_id: "sku_1" },
    });

    expect(resolved.extraHeaders["x-csrf-token"]).toBe("fresh-cookie");
    expect((resolved.bodyOverride as Record<string, unknown>).authenticity_token).toBe("fresh-cookie");
    expect(resolved.selectedBindings.some((binding) => binding.source_kind === "cookie" && binding.source_name === "csrftoken")).toBe(true);
  });

  it("persists artifacts and promotes the last successful strategy for warm runs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unbrowse-workflow-"));
    tempDirs.push(tmp);
    process.env.UNBROWSE_CONFIG_DIR = tmp;

    const base = buildWorkflowArtifactFromCapture(makeSkill(), makeCapture());
    const merged = mergeWorkflowArtifacts(base, readWorkflowArtifact(base.skill_id));
    writeWorkflowArtifact(merged);

    const updated = recordWorkflowRecipeOutcome(merged, "checkout-submit", "browser-action", {
      success: true,
      status: 200,
      selectedBindings: [{ target_name: "x-csrf-token", source_kind: "cookie", source_name: "csrftoken" }],
    });
    writeWorkflowArtifact(updated);

    const reloaded = readWorkflowArtifact(base.skill_id);
    const recipe = pickWorkflowRecipe(reloaded, "checkout-submit");
    expect(recipe?.steps[0]?.strategy).toBe("browser-action");
    expect(recipe?.last_successful_strategy).toBe("browser-action");
  });

  it("flags token-refresh retry statuses for workflow-backed mutations", () => {
    expect(needsWorkflowTokenRefresh(401)).toBe(true);
    expect(needsWorkflowTokenRefresh(403)).toBe(true);
    expect(needsWorkflowTokenRefresh(419)).toBe(true);
    expect(needsWorkflowTokenRefresh(422)).toBe(true);
    expect(needsWorkflowTokenRefresh(500)).toBe(false);
  });

  it("validates explicit replay params against the compiled contract", () => {
    const artifact = buildWorkflowArtifactFromCapture(makeSkill(), makeCapture());
    const recipe = artifact.recipes[0];
    expect(validateWorkflowReplayParams(recipe, { item_id: "sku_1" })).toEqual([]);
    expect(validateWorkflowReplayParams(recipe, {})).toEqual([]);
    const constrainedRecipe = {
      ...recipe,
      replay_contract: {
        ...recipe.replay_contract,
        parameter_specs: recipe.replay_contract.parameter_specs.map((spec) => spec.name === "item_id"
          ? { ...spec, enum_values: ["sku_1", "sku_2"] }
          : spec),
      },
    };
    expect(validateWorkflowReplayParams(constrainedRecipe, { item_id: "sku_999" })).toEqual([
      { name: "item_id", reason: "invalid_enum", allowed_values: ["sku_1", "sku_2"] },
    ]);
  });
});
