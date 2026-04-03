import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "../logger.js";
import type { WorkflowArtifact, WorkflowRecipe, WorkflowStepStrategy } from "../types/index.js";

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

function getWorkflowArtifactDir(): string {
  return process.env.UNBROWSE_WORKFLOW_ARTIFACT_DIR
    ?? join(getConfigDir(), "workflow-artifacts");
}

export function workflowArtifactPathForSkill(skillId: string): string {
  return join(getWorkflowArtifactDir(), `${skillId}.json`);
}

export function readWorkflowArtifact(skillId: string): WorkflowArtifact | null {
  const path = workflowArtifactPathForSkill(skillId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as WorkflowArtifact;
  } catch {
    return null;
  }
}

export function writeWorkflowArtifact(artifact: WorkflowArtifact): string | undefined {
  try {
    const dir = getWorkflowArtifactDir();
    mkdirSync(dir, { recursive: true });
    const target = workflowArtifactPathForSkill(artifact.skill_id);
    writeFileSync(target, JSON.stringify(artifact, null, 2), "utf-8");
    if (process.env.UNBROWSE_DEBUG_WORKFLOW === "1") {
      log("workflow", `wrote artifact ${artifact.skill_id} -> ${target} (${artifact.recipes.length} recipes)`);
    }
    return target;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("workflow", `artifact write failed for ${artifact.skill_id}: ${message}`);
    return undefined;
  }
}

function mergeRecipeState(
  nextRecipe: WorkflowRecipe,
  prevRecipe?: WorkflowRecipe,
): WorkflowRecipe {
  if (!prevRecipe) return nextRecipe;
  const previousSteps = new Map(prevRecipe.steps.map((step) => [step.strategy, step]));
  const mergedSteps = nextRecipe.steps.map((step) => {
    const previous = previousSteps.get(step.strategy);
    if (!previous) return step;
    return {
      ...step,
      success_count: previous.success_count ?? step.success_count,
      failure_count: previous.failure_count ?? step.failure_count,
      last_status: previous.last_status ?? step.last_status,
      last_error: previous.last_error ?? step.last_error,
      last_used_at: previous.last_used_at ?? step.last_used_at,
    };
  });

  if (prevRecipe.last_successful_strategy) {
    mergedSteps.sort((lhs, rhs) => {
      if (lhs.strategy === prevRecipe.last_successful_strategy) return -1;
      if (rhs.strategy === prevRecipe.last_successful_strategy) return 1;
      return 0;
    });
  }

  return {
    ...nextRecipe,
    steps: mergedSteps,
    preferred: prevRecipe.preferred || nextRecipe.preferred,
    last_successful_strategy: prevRecipe.last_successful_strategy ?? nextRecipe.last_successful_strategy,
    last_used_at: prevRecipe.last_used_at ?? nextRecipe.last_used_at,
  };
}

export function mergeWorkflowArtifacts(
  nextArtifact: WorkflowArtifact,
  prevArtifact?: WorkflowArtifact | null,
): WorkflowArtifact {
  if (!prevArtifact || prevArtifact.skill_id !== nextArtifact.skill_id) return nextArtifact;
  const previousRecipes = new Map(prevArtifact.recipes.map((recipe) => [recipe.endpoint_id, recipe]));
  return {
    ...nextArtifact,
    recipes: nextArtifact.recipes.map((recipe) => mergeRecipeState(recipe, previousRecipes.get(recipe.endpoint_id))),
  };
}

export function recordWorkflowRecipeOutcome(
  artifact: WorkflowArtifact,
  endpointId: string,
  strategy: WorkflowStepStrategy,
  outcome: {
    success: boolean;
    status?: number;
    error?: string;
    selectedBindings?: Array<{ target_name: string; source_kind: string; source_name: string }>;
  },
): WorkflowArtifact {
  const now = new Date().toISOString();
  return {
    ...artifact,
    recipes: artifact.recipes.map((recipe) => {
      if (recipe.endpoint_id !== endpointId) return recipe;
      return {
        ...recipe,
        preferred: outcome.success ? true : recipe.preferred,
        last_successful_strategy: outcome.success ? strategy : recipe.last_successful_strategy,
        last_used_at: now,
        token_bindings: recipe.token_bindings.map((binding) => {
          const selected = outcome.selectedBindings?.find((entry) => entry.target_name === binding.target_name);
          if (!selected) return binding;
          return {
            ...binding,
            selected_source_kind: selected.source_kind as typeof binding.selected_source_kind,
            selected_source_name: selected.source_name,
          };
        }),
        steps: recipe.steps
          .map((step) => {
            if (step.strategy !== strategy) return step;
            return {
              ...step,
              success_count: (step.success_count ?? 0) + (outcome.success ? 1 : 0),
              failure_count: (step.failure_count ?? 0) + (outcome.success ? 0 : 1),
              last_status: outcome.status ?? step.last_status,
              last_error: outcome.error,
              last_used_at: now,
            };
          })
          .sort((lhs, rhs) => {
            if (outcome.success && lhs.strategy === strategy) return -1;
            if (outcome.success && rhs.strategy === strategy) return 1;
            return 0;
          }),
      };
    }),
  };
}

export function listWorkflowArtifacts(): string[] {
  const dir = getWorkflowArtifactDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(dir, entry));
}
