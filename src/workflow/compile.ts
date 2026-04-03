import { nanoid } from "nanoid";
import { load } from "cheerio";
import type { CaptureResult, RawRequest } from "../capture/index.js";
import type {
  EndpointDescriptor,
  SkillManifest,
  TokenBinding,
  WorkflowActionStep,
  WorkflowArtifact,
  WorkflowBootstrapHint,
  WorkflowDomFieldHint,
  WorkflowMetaHint,
  WorkflowRecipe,
  WorkflowStep,
  WorkflowStepStrategy,
  WorkflowTokenCandidate,
} from "../types/index.js";

const TOKEN_NAME_RE = /(csrf|xsrf|authenticity|nonce|crumb|signature|token|session)/i;

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        return idx === -1 ? [part, ""] : [part.slice(0, idx).trim(), part.slice(idx + 1).trim()];
      }),
  );
}

function parseRequestBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    try {
      const params = new URLSearchParams(raw);
      const out: Record<string, unknown> = {};
      for (const [key, value] of params) out[key] = value;
      return Object.keys(out).length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  }
}

function collectPrimitivePaths(
  value: unknown,
  prefix = "",
  out: WorkflowBootstrapHint[] = [],
): WorkflowBootstrapHint[] {
  if (value == null) return out;
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((entry, index) => collectPrimitivePaths(entry, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof value === "object") {
    Object.entries(value as Record<string, unknown>)
      .slice(0, 12)
      .forEach(([key, next]) => collectPrimitivePaths(next, prefix ? `${prefix}.${key}` : key, out));
    return out;
  }
  if (typeof value === "string" && TOKEN_NAME_RE.test(prefix)) {
    out.push({ path: prefix, value });
  }
  return out;
}

export interface HtmlWorkflowHints {
  dom_form_hints: WorkflowDomFieldHint[];
  meta_hints: WorkflowMetaHint[];
  bootstrap_hints: WorkflowBootstrapHint[];
}

export function extractHtmlWorkflowHints(html?: string): HtmlWorkflowHints {
  if (!html) return { dom_form_hints: [], meta_hints: [], bootstrap_hints: [] };
  const $ = load(html);
  const dom_form_hints: WorkflowDomFieldHint[] = [];
  const meta_hints: WorkflowMetaHint[] = [];
  const bootstrap_hints: WorkflowBootstrapHint[] = [];

  $("input[type='hidden'], input[name]").each((_, el) => {
    const field_name = $(el).attr("name")?.trim();
    if (!field_name) return;
    if (!TOKEN_NAME_RE.test(field_name)) return;
    dom_form_hints.push({
      form_selector: $(el).closest("form").attr("id")
        ? `form#${$(el).closest("form").attr("id")}`
        : undefined,
      field_name,
      value: $(el).attr("value") ?? undefined,
      field_type: $(el).attr("type") ?? undefined,
    });
  });

  $("meta[name], meta[property]").each((_, el) => {
    const key = ($(el).attr("name") || $(el).attr("property") || "").trim();
    const value = ($(el).attr("content") || "").trim();
    if (!key || !value || !TOKEN_NAME_RE.test(key)) return;
    meta_hints.push({ key, value });
  });

  $("script[type='application/json'], script[type='application/ld+json']").each((_, el) => {
    const text = $(el).contents().text().trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      collectPrimitivePaths(parsed, "", bootstrap_hints);
    } catch {
      /* ignore */
    }
  });

  const inlineMatches = html.matchAll(/["']([A-Za-z0-9_.-]*(?:csrf|xsrf|token|nonce|crumb|signature)[A-Za-z0-9_.-]*)["']\s*:\s*["']([^"']+)["']/gi);
  for (const match of inlineMatches) {
    bootstrap_hints.push({ path: match[1], value: match[2] });
  }

  return { dom_form_hints, meta_hints, bootstrap_hints };
}

function stripTemplate(urlTemplate: string): string {
  return urlTemplate.replace(/\{[^}]+\}/g, "");
}

function requestMatchesEndpoint(req: RawRequest, endpoint: EndpointDescriptor): boolean {
  if (req.method.toUpperCase() !== endpoint.method.toUpperCase()) return false;
  try {
    const reqUrl = new URL(req.url);
    const endpointUrl = new URL(stripTemplate(endpoint.url_template));
    if (reqUrl.origin !== endpointUrl.origin) return false;
    return reqUrl.pathname.startsWith(endpointUrl.pathname) || endpointUrl.pathname.startsWith(reqUrl.pathname);
  } catch {
    return false;
  }
}

function candidateConfidence(targetName: string, sourceName: string, exactValueMatch: boolean): number {
  let score = exactValueMatch ? 0.95 : 0.45;
  if (normalizeName(targetName) === normalizeName(sourceName)) score += 0.15;
  if (normalizeName(targetName).includes(normalizeName(sourceName)) || normalizeName(sourceName).includes(normalizeName(targetName))) score += 0.1;
  return Math.min(score, 0.99);
}

function inferTokenBindingsForRequest(
  req: RawRequest,
  htmlHints: HtmlWorkflowHints,
): TokenBinding[] {
  const headers = Object.fromEntries(Object.entries(req.request_headers).map(([key, value]) => [key.toLowerCase(), value]));
  const body = parseRequestBody(req.request_body);
  const responseHeaders = Object.fromEntries(Object.entries(req.response_headers).map(([key, value]) => [key.toLowerCase(), value]));
  const cookies = parseCookieHeader(headers.cookie);

  const sources: Array<{ kind: WorkflowTokenCandidate["source_kind"]; name: string; value?: string; path?: string }> = [
    ...Object.entries(cookies).map(([name, value]) => ({ kind: "cookie" as const, name, value })),
    ...Object.entries(responseHeaders).map(([name, value]) => ({ kind: "response_header" as const, name, value })),
    ...htmlHints.dom_form_hints.map((hint) => ({ kind: "hidden_input" as const, name: hint.field_name, value: hint.value, path: hint.form_selector })),
    ...htmlHints.meta_hints.map((hint) => ({ kind: "meta" as const, name: hint.key, value: hint.value })),
    ...htmlHints.bootstrap_hints.map((hint) => ({ kind: "bootstrap_json" as const, name: hint.path.split(".").pop() ?? hint.path, value: hint.value, path: hint.path })),
  ];

  const targets: Array<{ location: "header" | "body"; name: string; value?: string }> = [
    ...Object.entries(headers)
      .filter(([name]) => name !== "cookie")
      .filter(([name, value]) => TOKEN_NAME_RE.test(name) || sources.some((source) => source.value && source.value === value))
      .map(([name, value]) => ({ location: "header" as const, name, value })),
    ...Object.entries(body ?? {})
      .filter(([name, value]) => TOKEN_NAME_RE.test(name) || sources.some((source) => source.value && source.value === String(value)))
      .map(([name, value]) => ({ location: "body" as const, name, value: value == null ? undefined : String(value) })),
  ];

  return targets.map((target) => {
    const candidates = sources
      .filter((source) => {
        if (!source.value) return normalizeName(target.name).includes(normalizeName(source.name));
        return source.value === target.value || normalizeName(target.name).includes(normalizeName(source.name)) || normalizeName(source.name).includes(normalizeName(target.name));
      })
      .map((source) => ({
        source_kind: source.kind,
        source_name: source.name,
        source_path: source.path,
        observed_value: source.value,
        confidence: candidateConfidence(target.name, source.name, source.value === target.value),
      }))
      .sort((lhs, rhs) => rhs.confidence - lhs.confidence);

    return {
      binding_id: nanoid(),
      target_location: target.location,
      target_name: target.name,
      refresh_on_statuses: [401, 403, 419, 422],
      candidates,
    };
  }).filter((binding) => binding.candidates.length > 0);
}

function deriveActionSequence(
  matchedRequests: RawRequest[],
  endpoint: EndpointDescriptor,
): WorkflowActionStep[] | undefined {
  const withProvenance = matchedRequests
    .filter((req) => req.triggered_by_action)
    .sort((lhs, rhs) => (lhs.triggered_by_step ?? 0) - (rhs.triggered_by_step ?? 0));
  if (withProvenance.length > 0) {
    return withProvenance.map((req) => ({
      action: req.triggered_by_action!,
      step_index: req.triggered_by_step,
      ref: req.triggered_by_ref,
    }));
  }
  if (endpoint.search_form) {
    return [
      ...endpoint.search_form.fields.map((field, index) => ({
        action: "fill",
        selector: field.selector,
        value: `{${field.name}}`,
        step_index: index,
      })),
      { action: "submit", selector: endpoint.search_form.submit_selector, step_index: endpoint.search_form.fields.length },
    ];
  }
  return undefined;
}

function deriveWorkflowSteps(
  endpoint: EndpointDescriptor,
  matchedRequests: RawRequest[],
): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const actionSequence = deriveActionSequence(matchedRequests, endpoint);
  const addStep = (strategy: WorkflowStepStrategy, provenance: WorkflowStep["provenance"], triggerUrl?: string) => {
    if (steps.some((step) => step.strategy === strategy && step.trigger_url === triggerUrl)) return;
    steps.push({
      step_id: nanoid(),
      strategy,
      provenance,
      ...(triggerUrl ? { trigger_url: triggerUrl } : {}),
      ...(strategy === "browser-action" && actionSequence ? { action_sequence: actionSequence } : {}),
    });
  };

  if (endpoint.exec_strategy) addStep(endpoint.exec_strategy === "browser" ? "browser-fetch" : endpoint.exec_strategy, "learned-runtime", endpoint.trigger_url);
  addStep("server", matchedRequests.length > 0 ? "observed-request" : "bundle-inferred");
  if (endpoint.trigger_url) addStep("trigger-intercept", matchedRequests.length > 0 ? "observed-request" : "trigger-url", endpoint.trigger_url);
  if (actionSequence) addStep("browser-action", endpoint.search_form ? "dom-form" : "observed-request", endpoint.trigger_url);
  addStep("browser-fetch", matchedRequests.length > 0 ? "observed-request" : endpoint.search_form ? "dom-form" : "bundle-inferred", endpoint.trigger_url);
  return steps;
}

function parameterMappingConfident(endpoint: EndpointDescriptor): boolean {
  return endpoint.method === "GET"
    || !!endpoint.search_form
    || Object.keys(endpoint.body_params ?? {}).length > 0
    || Object.keys(endpoint.path_params ?? {}).length > 0
    || Object.keys(endpoint.query ?? {}).length > 0
    || !!endpoint.body;
}

function operationIdForEndpoint(skill: SkillManifest, endpointId: string): string | undefined {
  return skill.operation_graph?.operations.find((operation) => operation.endpoint_id === endpointId)?.operation_id;
}

function buildRecipe(
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
  matchedRequests: RawRequest[],
  htmlHints: HtmlWorkflowHints,
): WorkflowRecipe {
  const token_bindings = endpoint.method === "GET" ? [] : matchedRequests.flatMap((req) => inferTokenBindingsForRequest(req, htmlHints));
  const provenance_backed = matchedRequests.length > 0 || !!endpoint.trigger_url || !!endpoint.search_form || !!endpoint.dom_extraction;
  const auth_required = !!skill.auth_profile_ref || !!endpoint.semantic?.auth_required || token_bindings.length > 0;
  const parameter_mapping = parameterMappingConfident(endpoint);
  return {
    recipe_id: nanoid(),
    endpoint_id: endpoint.endpoint_id,
    operation_id: operationIdForEndpoint(skill, endpoint.endpoint_id),
    preferred: false,
    provenance_backed,
    steps: deriveWorkflowSteps(endpoint, matchedRequests),
    token_bindings,
    mutation_guard: {
      confirm_unsafe_required: endpoint.method !== "GET" && endpoint.idempotency === "unsafe",
      provenance_backed,
      auth_required,
      parameter_mapping_confident: parameter_mapping,
      ...(!provenance_backed && endpoint.method !== "GET" ? { block_reason: "mutation requires provenance-backed workflow recipe" } : {}),
    },
  };
}

export function buildWorkflowArtifactFromCapture(
  skill: SkillManifest,
  capture: Pick<CaptureResult, "requests" | "har_lineage_id" | "final_url" | "html" | "js_bundles" | "cookies">,
  options?: { authHeaders?: Record<string, string> },
): WorkflowArtifact {
  const htmlHints = extractHtmlWorkflowHints(capture.html);
  const recipes = skill.endpoints.map((endpoint) => buildRecipe(
    skill,
    endpoint,
    capture.requests.filter((req) => requestMatchesEndpoint(req, endpoint)),
    htmlHints,
  ));
  if (recipes.length > 0) recipes[0].preferred = true;

  return {
    artifact_version: "1",
    skill_id: skill.skill_id,
    domain: skill.domain,
    intent_signature: skill.intent_signature,
    captured_at: new Date().toISOString(),
    final_url: capture.final_url,
    auth_state: {
      auth_profile_ref: skill.auth_profile_ref,
      cookie_names: (capture.cookies ?? []).map((cookie) => cookie.name),
      header_names: Object.keys(options?.authHeaders ?? {}),
      authenticated: (capture.cookies?.length ?? 0) > 0 || Object.keys(options?.authHeaders ?? {}).length > 0,
    },
    evidence: {
      observed_request_count: capture.requests.length,
      observed_request_urls: capture.requests.slice(0, 100).map((req) => req.url),
      har_lineage_ids: [capture.har_lineage_id],
      trigger_urls: Array.from(new Set(skill.endpoints.map((endpoint) => endpoint.trigger_url).filter((value): value is string => !!value))),
      js_bundle_urls: capture.js_bundles ? Array.from(capture.js_bundles.keys()).slice(0, 40) : [],
      dom_form_hints: htmlHints.dom_form_hints,
      meta_hints: htmlHints.meta_hints,
      bootstrap_hints: htmlHints.bootstrap_hints,
    },
    recipes,
  };
}
