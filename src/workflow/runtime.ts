import type {
  TokenBinding,
  WorkflowArtifact,
  WorkflowParameterSpec,
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

export interface WorkflowParamValidationError {
  name: string;
  reason: string;
  allowed_values?: Array<string | number | boolean>;
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

function valueForSpec(
  spec: WorkflowParameterSpec,
  params: Record<string, unknown>,
): unknown {
  const value = params[spec.name];
  return value === undefined ? spec.default_value : value;
}

function matchesSpecType(spec: WorkflowParameterSpec, value: unknown): boolean {
  if (value == null) return true;
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" || value === "true" || value === "false";
    case "integer":
      return typeof value === "number"
        ? Number.isInteger(value)
        : typeof value === "string" && /^-?\d+$/.test(value);
    case "number":
      return typeof value === "number"
        ? Number.isFinite(value)
        : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "string":
    default:
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  }
}

function matchesSpecFormat(spec: WorkflowParameterSpec, value: unknown): boolean {
  if (value == null || spec.format == null) return true;
  const sample = String(value);
  switch (spec.format) {
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(sample);
    case "url":
      return /^https?:\/\//i.test(sample);
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sample);
    default:
      return true;
  }
}

export function validateWorkflowReplayParams(
  recipe: WorkflowRecipe,
  params: Record<string, unknown>,
): WorkflowParamValidationError[] {
  const errors: WorkflowParamValidationError[] = [];
  for (const spec of recipe.replay_contract.parameter_specs) {
    if (!spec.user_supplied) continue;
    const value = valueForSpec(spec, params);
    if (spec.required && (value == null || value === "")) {
      errors.push({ name: spec.name, reason: "required" });
      continue;
    }
    if (value == null || value === "") continue;
    if (spec.enum_values?.length && !spec.enum_values.some((candidate) => String(candidate) === String(value))) {
      errors.push({
        name: spec.name,
        reason: "invalid_enum",
        allowed_values: spec.enum_values,
      });
      continue;
    }
    if (!matchesSpecType(spec, value)) {
      errors.push({ name: spec.name, reason: `expected_${spec.type}` });
      continue;
    }
    if (!matchesSpecFormat(spec, value)) {
      errors.push({ name: spec.name, reason: `expected_format_${spec.format}` });
    }
  }
  return errors;
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
