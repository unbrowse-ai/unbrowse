import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { sanitizeForPublish } from "../publish/sanitize.js";
import type {
  EndpointDescriptor,
  SkillManifest,
  WorkflowArtifact,
  WorkflowPublishArtifact,
  WorkflowPublishRecipe,
  WorkflowPublishStatus,
} from "../types/index.js";

function sanitizeProfileName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function getConfigDir(): string {
  if (process.env.UNBROWSE_CONFIG_DIR) return process.env.UNBROWSE_CONFIG_DIR;
  const profile = sanitizeProfileName(process.env.UNBROWSE_PROFILE ?? "");
  return profile
    ? join(homedir(), ".unbrowse", "profiles", profile)
    : join(homedir(), ".unbrowse");
}

function getWorkflowExportDir(): string {
  return process.env.UNBROWSE_WORKFLOW_EXPORT_DIR
    ?? join(getConfigDir(), "workflow-exports");
}

export function workflowPublishArtifactPathForSkill(skillId: string): string {
  return join(getWorkflowExportDir(), `${skillId}.json`);
}

export function readWorkflowPublishArtifact(skillId: string): WorkflowPublishArtifact | null {
  const target = workflowPublishArtifactPathForSkill(skillId);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, "utf-8")) as WorkflowPublishArtifact;
  } catch {
    return null;
  }
}

export function listWorkflowPublishArtifacts(): string[] {
  const dir = getWorkflowExportDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(dir, entry));
}

function stripQuery(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function docBullets(
  skill: SkillManifest,
  endpoints: EndpointDescriptor[],
  workflowArtifact: WorkflowArtifact | null,
): string[] {
  const bullets = [
    `${endpoints.length} publishable endpoint${endpoints.length === 1 ? "" : "s"} for ${skill.intent_signature}`,
  ];
  if (workflowArtifact) {
    bullets.push(`${workflowArtifact.recipes.length} workflow recipe${workflowArtifact.recipes.length === 1 ? "" : "s"} captured`);
    const preferred = workflowArtifact.recipes.filter((recipe) => recipe.preferred).map((recipe) => recipe.endpoint_id);
    if (preferred.length > 0) bullets.push(`preferred routes: ${preferred.join(", ")}`);
    const guarded = workflowArtifact.recipes.filter((recipe) => recipe.mutation_guard.confirm_unsafe_required).length;
    if (guarded > 0) bullets.push(`${guarded} mutation recipe${guarded === 1 ? "" : "s"} require confirm_unsafe`);
    const preferredRecipe = workflowArtifact.recipes.find((recipe) => recipe.preferred) ?? workflowArtifact.recipes[0];
    const preferredUsage = preferredRecipe ? usageNotesForRecipe(preferredRecipe)[0] : undefined;
    if (preferredUsage) bullets.push(preferredUsage);
  } else {
    bullets.push("no workflow artifact captured yet");
  }
  return bullets;
}

function usageNotesForRecipe(recipe: WorkflowArtifact["recipes"][number]): string[] {
  const notes: string[] = [];
  const requiredUserParams = recipe.replay_contract.parameter_specs
    .filter((param) => param.user_supplied && param.required)
    .map((param) => `${param.name}:${param.type}${param.enum_values?.length ? `=${param.enum_values.join("|")}` : ""}`);
  if (requiredUserParams.length > 0) {
    notes.push(`params: ${requiredUserParams.join(", ")}`);
  }
  const derivedParams = recipe.replay_contract.parameter_specs
    .filter((param) => !param.user_supplied)
    .map((param) => `${param.name}<=${param.derived_from?.[0] ?? "observed state"}`);
  if (derivedParams.length > 0) {
    notes.push(`derived: ${derivedParams.slice(0, 4).join(", ")}`);
  }
  const prereqs = recipe.replay_contract.prerequisite_specs
    .filter((entry) => entry.required)
    .map((entry) => entry.name);
  if (prereqs.length > 0) {
    notes.push(`prereqs: ${prereqs.slice(0, 4).join(", ")}`);
  }
  notes.push("replay: explicit only; traversal stays browser-native");
  return notes;
}

function buildPublishedRecipes(workflowArtifact: WorkflowArtifact | null): WorkflowPublishRecipe[] {
  if (!workflowArtifact) return [];
  return workflowArtifact.recipes.map((recipe) => ({
    endpoint_id: recipe.endpoint_id,
    operation_id: recipe.operation_id,
    preferred: recipe.preferred,
    provenance_backed: recipe.provenance_backed,
    last_successful_strategy: recipe.last_successful_strategy,
    steps: recipe.steps.map((step) => ({
      strategy: step.strategy,
      provenance: step.provenance,
      trigger_url: stripQuery(step.trigger_url),
      action_count: step.action_sequence?.length ?? 0,
    })),
    mutation_guard: recipe.mutation_guard,
    token_bindings: recipe.token_bindings.map((binding) => ({
      target_location: binding.target_location,
      target_name: binding.target_name,
      refresh_on_statuses: binding.refresh_on_statuses,
      selected_source_kind: binding.selected_source_kind,
      selected_source_name: binding.selected_source_name,
      candidates: binding.candidates.map((candidate) => ({
        source_kind: candidate.source_kind,
        source_name: candidate.source_name,
        source_path: candidate.source_path,
        confidence: candidate.confidence,
        })),
    })),
    replay_contract: recipe.replay_contract,
    usage_notes: usageNotesForRecipe(recipe),
  }));
}

export function buildWorkflowPublishArtifact(
  skill: SkillManifest,
  workflowArtifact: WorkflowArtifact | null,
  options?: {
    publishStatus?: WorkflowPublishStatus;
    publishedAt?: string;
    validationErrors?: string[];
  },
): WorkflowPublishArtifact {
  const sanitizedEndpoints = sanitizeForPublish(skill.endpoints.filter((endpoint) => endpoint.method !== "WS"));
  const recipes = buildPublishedRecipes(workflowArtifact);
  const tokenBindingCount = recipes.reduce((sum, recipe) => sum + recipe.token_bindings.length, 0);
  return {
    export_version: "1",
    generated_at: new Date().toISOString(),
    publish_status: options?.publishStatus ?? "captured",
    ...(options?.publishedAt ? { published_at: options.publishedAt } : {}),
    ...(options?.validationErrors?.length ? { validation_errors: options.validationErrors } : {}),
    skill_id: skill.skill_id,
    domain: skill.domain,
    intent_signature: skill.intent_signature,
    sanitized_endpoints: sanitizedEndpoints,
    workflow_summary: {
      recipe_count: recipes.length,
      preferred_endpoint_ids: recipes.filter((recipe) => recipe.preferred).map((recipe) => recipe.endpoint_id),
      authenticated_capture: workflowArtifact?.auth_state.authenticated ?? false,
      token_binding_count: tokenBindingCount,
      trigger_url_count: workflowArtifact?.evidence.trigger_urls.length ?? 0,
    },
    auth_summary: workflowArtifact?.auth_state ?? {
      cookie_names: [],
      header_names: [],
      authenticated: false,
    },
    recipes,
    docs: {
      headline: `${skill.domain} workflow export`,
      bullets: docBullets(skill, sanitizedEndpoints, workflowArtifact),
    },
  };
}

export function writeWorkflowPublishArtifact(artifact: WorkflowPublishArtifact): string | undefined {
  try {
    const dir = getWorkflowExportDir();
    mkdirSync(dir, { recursive: true });
    const target = workflowPublishArtifactPathForSkill(artifact.skill_id);
    writeFileSync(target, JSON.stringify(artifact, null, 2), "utf-8");
    return target;
  } catch (error) {
    log("workflow", `publish export write failed for ${artifact.skill_id}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
