import type {
  TokenBinding,
  WorkflowArtifact,
  WorkflowRecipe,
  WorkflowStep,
  WorkflowStepStrategy,
} from "../types/index.js";

export interface WorkflowRuntimeContext {
  cookies: Array<{ name: string; value: string; domain: string }>;
  authHeaders: Record<string, string>;
  body?: unknown;
  artifact: WorkflowArtifact;
}

export interface ResolvedWorkflowBindings {
  extraHeaders: Record<string, string>;
  bodyOverride?: unknown;
  selectedBindings: Array<{ target_name: string; source_kind: string; source_name: string }>;
}

function cloneBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map((entry) => cloneBody(entry));
  return { ...(body as Record<string, unknown>) };
}

function resolveBindingValue(
  binding: TokenBinding,
  context: WorkflowRuntimeContext,
): { value?: string; source_kind?: string; source_name?: string } {
  for (const candidate of binding.candidates) {
    if (candidate.source_kind === "cookie") {
      const cookie = context.cookies.find((entry) => entry.name.toLowerCase() === candidate.source_name.toLowerCase());
      if (cookie?.value != null) return { value: cookie.value, source_kind: candidate.source_kind, source_name: candidate.source_name };
    }
    if (candidate.source_kind === "request_header" || candidate.source_kind === "response_header") {
      const header = Object.entries(context.authHeaders).find(([key]) => key.toLowerCase() === candidate.source_name.toLowerCase());
      if (header?.[1] != null) return { value: header[1], source_kind: candidate.source_kind, source_name: candidate.source_name };
    }
    if (candidate.source_kind === "hidden_input") {
      const hint = context.artifact.evidence.dom_form_hints.find((entry) => entry.field_name.toLowerCase() === candidate.source_name.toLowerCase());
      if (hint?.value != null) return { value: hint.value, source_kind: candidate.source_kind, source_name: candidate.source_name };
    }
    if (candidate.source_kind === "meta") {
      const hint = context.artifact.evidence.meta_hints.find((entry) => entry.key.toLowerCase() === candidate.source_name.toLowerCase());
      if (hint?.value != null) return { value: hint.value, source_kind: candidate.source_kind, source_name: candidate.source_name };
    }
    if (candidate.source_kind === "bootstrap_json") {
      const hint = context.artifact.evidence.bootstrap_hints.find((entry) => entry.path === candidate.source_path || entry.path.toLowerCase().endsWith(candidate.source_name.toLowerCase()));
      if (hint?.value != null) return { value: hint.value, source_kind: candidate.source_kind, source_name: candidate.source_name };
    }
    if (candidate.source_kind === "request_body" && candidate.observed_value != null) {
      return { value: candidate.observed_value, source_kind: candidate.source_kind, source_name: candidate.source_name };
    }
  }
  return {};
}

export function resolveWorkflowBindings(
  recipe: WorkflowRecipe,
  context: WorkflowRuntimeContext,
): ResolvedWorkflowBindings {
  const extraHeaders: Record<string, string> = {};
  let bodyOverride = cloneBody(context.body);
  const selectedBindings: ResolvedWorkflowBindings["selectedBindings"] = [];

  for (const binding of recipe.token_bindings) {
    const resolved = resolveBindingValue(binding, context);
    if (resolved.value == null || !resolved.source_kind || !resolved.source_name) continue;
    selectedBindings.push({
      target_name: binding.target_name,
      source_kind: resolved.source_kind,
      source_name: resolved.source_name,
    });
    if (binding.target_location === "header") {
      extraHeaders[binding.target_name.toLowerCase()] = resolved.value;
      continue;
    }
    if (!bodyOverride || typeof bodyOverride !== "object" || Array.isArray(bodyOverride)) {
      bodyOverride = {};
    }
    (bodyOverride as Record<string, unknown>)[binding.target_name] = resolved.value;
  }

  return { extraHeaders, bodyOverride, selectedBindings };
}

export function needsWorkflowTokenRefresh(status: number): boolean {
  return status === 401 || status === 403 || status === 419 || status === 422;
}

export function pickWorkflowRecipe(
  artifact: WorkflowArtifact | null,
  endpointId: string,
): WorkflowRecipe | null {
  if (!artifact) return null;
  const exact = artifact.recipes.find((recipe) => recipe.endpoint_id === endpointId);
  if (!exact) return null;
  const preferredStrategy = exact.last_successful_strategy;
  const steps = preferredStrategy
    ? [...exact.steps].sort((lhs, rhs) => {
        if (lhs.strategy === preferredStrategy) return -1;
        if (rhs.strategy === preferredStrategy) return 1;
        return 0;
      })
    : exact.steps;
  return { ...exact, steps };
}

export function translateWorkflowStrategy(
  strategy: WorkflowStepStrategy,
): "server" | "trigger-intercept" | "browser" {
  switch (strategy) {
    case "server":
      return "server";
    case "trigger-intercept":
      return "trigger-intercept";
    case "browser-action":
    case "browser-fetch":
    default:
      return "browser";
  }
}

export function strategyLabel(step: WorkflowStep): string {
  return step.strategy;
}
