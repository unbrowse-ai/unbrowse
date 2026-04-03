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
  WorkflowDomOptionHint,
  WorkflowMetaHint,
  WorkflowNextStateSpec,
  WorkflowParameterConstraint,
  WorkflowParameterSourceHint,
  WorkflowParameterSpec,
  WorkflowPrerequisiteSpec,
  WorkflowReplayContract,
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
  dom_option_hints: WorkflowDomOptionHint[];
  meta_hints: WorkflowMetaHint[];
  bootstrap_hints: WorkflowBootstrapHint[];
}

function domSelectorForField(
  tagName: string,
  fieldName?: string,
  fieldId?: string,
): string | undefined {
  if (fieldId) return `#${fieldId}`;
  if (fieldName) return `${tagName}[name="${fieldName}"]`;
  return undefined;
}

export function extractHtmlWorkflowHints(html?: string): HtmlWorkflowHints {
  if (!html) return { dom_form_hints: [], dom_option_hints: [], meta_hints: [], bootstrap_hints: [] };
  const $ = load(html);
  const dom_form_hints: WorkflowDomFieldHint[] = [];
  const dom_option_hints: WorkflowDomOptionHint[] = [];
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
      selector: domSelectorForField(
        el.tagName?.toLowerCase?.() ?? "input",
        field_name,
        $(el).attr("id") ?? undefined,
      ),
      required: $(el).attr("required") != null,
      pattern: $(el).attr("pattern") ?? undefined,
      min: $(el).attr("min") ?? undefined,
      max: $(el).attr("max") ?? undefined,
    });
  });

  const optionMap = new Map<string, WorkflowDomOptionHint>();
  $("select[name], input[type='radio'][name], input[type='checkbox'][name]").each((_, el) => {
    const field_name = ($(el).attr("name") || "").trim();
    if (!field_name) return;
    const form_selector = $(el).closest("form").attr("id")
      ? `form#${$(el).closest("form").attr("id")}`
      : undefined;
    const key = `${form_selector ?? ""}::${field_name}`;
    const existing = optionMap.get(key) ?? {
      form_selector,
      field_name,
      values: [],
      labels: [],
      field_type: $(el).attr("type") ?? (el.tagName?.toLowerCase?.() === "select" ? "select" : undefined),
    };
    if (el.tagName?.toLowerCase?.() === "select") {
      $(el).find("option").each((_, optionEl) => {
        const value = ($(optionEl).attr("value") || $(optionEl).text() || "").trim();
        if (!value) return;
        if (!existing.values.includes(value)) existing.values.push(value);
        const label = $(optionEl).text().trim();
        if (label && !existing.labels?.includes(label)) existing.labels?.push(label);
      });
    } else {
      const value = ($(el).attr("value") || "").trim();
      if (value && !existing.values.includes(value)) existing.values.push(value);
      const label = $(el).closest("label").text().trim();
      if (label && !existing.labels?.includes(label)) existing.labels?.push(label);
    }
    optionMap.set(key, existing);
  });
  dom_option_hints.push(...optionMap.values().filter((hint) => hint.values.length > 0));

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

  return { dom_form_hints, dom_option_hints, meta_hints, bootstrap_hints };
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

function isSensitiveWorkflowField(name: string): boolean {
  return TOKEN_NAME_RE.test(name);
}

function inferValueType(value: unknown): WorkflowParameterSpec["type"] {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  if (typeof value === "string") {
    if (/^(true|false)$/i.test(value)) return "boolean";
    if (/^-?\d+$/.test(value)) return "integer";
    if (/^-?\d+\.\d+$/.test(value)) return "number";
  }
  return "string";
}

function inferValueFormat(name: string, value: unknown): string | undefined {
  const sample = typeof value === "string" ? value : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) return "date";
  if (sample && /^https?:\/\//i.test(sample)) return "url";
  if (sample && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sample)) return "email";
  if (/date/i.test(name) && /^\d{4}-\d{2}-\d{2}$/.test(sample)) return "date";
  return undefined;
}

function summarizeResponseSchema(endpoint: EndpointDescriptor): string | undefined {
  const objectKeys = Object.keys(endpoint.response_schema?.properties ?? {});
  if (objectKeys.length > 0) return objectKeys.slice(0, 8).join(", ");
  const arrayKeys = Object.keys(endpoint.response_schema?.items?.properties ?? {});
  if (arrayKeys.length > 0) return arrayKeys.slice(0, 8).join(", ");
  return endpoint.response_schema ? endpoint.response_schema.type : undefined;
}

function templatePathParamNames(urlTemplate: string): string[] {
  return [...urlTemplate.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function inferQuerySamples(matchedRequests: RawRequest[]): Map<string, unknown> {
  const samples = new Map<string, unknown>();
  for (const req of matchedRequests) {
    try {
      const url = new URL(req.url);
      for (const [key, value] of url.searchParams.entries()) {
        if (!samples.has(key)) samples.set(key, value);
      }
    } catch {
      /* ignore */
    }
  }
  return samples;
}

function parameterDescription(
  endpoint: EndpointDescriptor,
  name: string,
  location: WorkflowParameterSpec["location"],
  userSupplied: boolean,
  derivedFrom: string[],
): string {
  const semantic = endpoint.semantic?.requires?.find((binding) => binding.key === name)?.description;
  if (semantic) return semantic;
  if (!userSupplied && derivedFrom.length > 0) {
    return `Derived ${location} parameter populated from ${derivedFrom.join(", ")}.`;
  }
  return `Observed ${location} parameter for ${endpoint.method} ${endpoint.url_template}.`;
}

function uniquePrimitiveValues(values: unknown[]): Array<string | number | boolean> {
  const out: Array<string | number | boolean> = [];
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function buildParameterSpecs(
  endpoint: EndpointDescriptor,
  matchedRequests: RawRequest[],
  htmlHints: HtmlWorkflowHints,
  tokenBindings: TokenBinding[],
): WorkflowParameterSpec[] {
  type ParamAccumulator = {
    name: string;
    location: WorkflowParameterSpec["location"];
    values: unknown[];
    defaultValue?: unknown;
    required: boolean;
    userSupplied: boolean;
    derivedFrom: string[];
    constraints: WorkflowParameterConstraint[];
    sourceHints: WorkflowParameterSourceHint[];
  };
  const acc = new Map<string, ParamAccumulator>();
  const getKey = (location: WorkflowParameterSpec["location"], name: string) => `${location}:${name}`;
  const ensure = (location: WorkflowParameterSpec["location"], name: string): ParamAccumulator => {
    const key = getKey(location, name);
    const existing = acc.get(key);
    if (existing) return existing;
    const created: ParamAccumulator = {
      name,
      location,
      values: [],
      required: false,
      userSupplied: !isSensitiveWorkflowField(name),
      derivedFrom: [],
      constraints: [],
      sourceHints: [],
    };
    acc.set(key, created);
    return created;
  };
  const pushConstraint = (target: ParamAccumulator, constraint: WorkflowParameterConstraint): void => {
    if (target.constraints.some((entry) => entry.kind === constraint.kind && entry.value === constraint.value && entry.description === constraint.description)) return;
    target.constraints.push(constraint);
  };
  const pushSourceHint = (target: ParamAccumulator, hint: WorkflowParameterSourceHint): void => {
    if (target.sourceHints.some((entry) => entry.source_kind === hint.source_kind && entry.source_name === hint.source_name && entry.source_path === hint.source_path)) return;
    target.sourceHints.push(hint);
  };
  const querySamples = inferQuerySamples(matchedRequests);

  for (const name of templatePathParamNames(endpoint.url_template)) {
    const target = ensure("path", name);
    target.required = true;
    target.defaultValue = endpoint.path_params?.[name];
    if (endpoint.path_params?.[name] != null) target.values.push(endpoint.path_params[name]);
    pushSourceHint(target, { source_kind: "path_template", source_name: name, confidence: 0.99 });
  }

  for (const [name, value] of Object.entries(endpoint.query ?? {})) {
    const target = ensure("query", name);
    target.defaultValue = value;
    target.values.push(value);
    pushSourceHint(target, { source_kind: "query_default", source_name: name, confidence: 0.9 });
  }
  for (const [name, value] of querySamples.entries()) {
    const target = ensure("query", name);
    target.values.push(value);
    pushSourceHint(target, { source_kind: "observed_query", source_name: name, confidence: 0.99 });
  }

  for (const [name, value] of Object.entries(endpoint.body_params ?? {})) {
    const target = ensure("body", name);
    target.defaultValue = value;
    target.values.push(value);
    target.required = true;
    pushSourceHint(target, { source_kind: "body_default", source_name: name, confidence: 0.95 });
  }
  for (const [name, value] of Object.entries(endpoint.body ?? {})) {
    const target = ensure("body", name);
    target.values.push(value);
    target.required = true;
    pushSourceHint(target, { source_kind: "body_default", source_name: name, confidence: 0.8 });
  }
  for (const req of matchedRequests) {
    for (const [name, value] of Object.entries(parseRequestBody(req.request_body) ?? {})) {
      const target = ensure("body", name);
      target.values.push(value);
      target.required = true;
      pushSourceHint(target, { source_kind: "observed_body", source_name: name, confidence: 0.99 });
    }
  }

  for (const binding of tokenBindings) {
    const location = binding.target_location === "header" ? "header" : "body";
    const target = ensure(location, binding.target_name);
    target.required = true;
    target.userSupplied = false;
    for (const candidate of binding.candidates) {
      pushSourceHint(target, {
        source_kind: candidate.source_kind,
        source_name: candidate.source_name,
        source_path: candidate.source_path,
        confidence: candidate.confidence,
      });
      const derivedLabel = candidate.source_path ? `${candidate.source_kind}:${candidate.source_path}` : `${candidate.source_kind}:${candidate.source_name}`;
      if (!target.derivedFrom.includes(derivedLabel)) target.derivedFrom.push(derivedLabel);
    }
  }

  for (const hint of htmlHints.dom_form_hints) {
    const bodyTarget = acc.get(getKey("body", hint.field_name));
    if (!bodyTarget) continue;
    if (hint.pattern) pushConstraint(bodyTarget, { kind: "pattern", value: hint.pattern });
    if (hint.min) pushConstraint(bodyTarget, { kind: "min", value: hint.min });
    if (hint.max) pushConstraint(bodyTarget, { kind: "max", value: hint.max });
    if (hint.required) bodyTarget.required = true;
    if (hint.selector) {
      if (!bodyTarget.derivedFrom.includes(`dom:${hint.selector}`)) bodyTarget.derivedFrom.push(`dom:${hint.selector}`);
    }
  }

  for (const optionHint of htmlHints.dom_option_hints) {
    const target = acc.get(getKey("body", optionHint.field_name)) ?? acc.get(getKey("query", optionHint.field_name));
    if (!target) continue;
    const values = uniquePrimitiveValues(optionHint.values);
    if (values.length > 0) pushConstraint(target, { kind: "enum", description: `Allowed values observed for ${optionHint.field_name}.` });
    target.values.push(...values);
  }

  for (const binding of endpoint.semantic?.requires ?? []) {
    const target = acc.get(getKey("path", binding.key))
      ?? acc.get(getKey("query", binding.key))
      ?? acc.get(getKey("body", binding.key))
      ?? acc.get(getKey("header", binding.key));
    if (!target) continue;
    if (binding.required) target.required = true;
    if (binding.example_value != null) target.values.push(binding.example_value);
    pushSourceHint(target, { source_kind: "semantic_requires", source_name: binding.key, confidence: 0.7 });
  }

  return Array.from(acc.values()).map((entry) => {
    const sampleValue = entry.values.find((value) => value != null);
    const format = inferValueFormat(entry.name, sampleValue);
    const enumValues = uniquePrimitiveValues(entry.values).slice(0, 12);
    const type = inferValueType(sampleValue);
    const sensitive = isSensitiveWorkflowField(entry.name);
    const constraints = [...entry.constraints];
    if (format) constraints.push({ kind: "format", value: format });
    if (enumValues.length > 1) constraints.push({ kind: "enum", description: `Allowed values observed for ${entry.name}.` });
    return {
      name: entry.name,
      location: entry.location,
      description: parameterDescription(endpoint, entry.name, entry.location, entry.userSupplied, entry.derivedFrom),
      type,
      required: entry.required,
      user_supplied: entry.userSupplied,
      ...(sensitive ? {} : entry.defaultValue !== undefined ? { default_value: entry.defaultValue } : {}),
      ...(sensitive ? {} : sampleValue !== undefined ? { example_value: sampleValue } : {}),
      ...(format ? { format } : {}),
      ...(enumValues.length > 1 ? { enum_values: enumValues } : {}),
      ...(entry.derivedFrom.length > 0 ? { derived_from: entry.derivedFrom } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
      source_hints: entry.sourceHints,
    };
  }).sort((lhs, rhs) => {
    const order = ["path", "query", "body", "header"];
    return order.indexOf(lhs.location) - order.indexOf(rhs.location) || lhs.name.localeCompare(rhs.name);
  });
}

function buildPrerequisiteSpecs(
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
  htmlHints: HtmlWorkflowHints,
  tokenBindings: TokenBinding[],
  actionSequence?: WorkflowActionStep[],
): WorkflowPrerequisiteSpec[] {
  const prerequisites: WorkflowPrerequisiteSpec[] = [];
  if (skill.auth_profile_ref || endpoint.semantic?.auth_required) {
    prerequisites.push({
      prerequisite_id: nanoid(),
      kind: "authenticated-session",
      name: "authenticated_session",
      description: "Requires authenticated browser or stored auth state before replay.",
      required: true,
      derived_from: skill.auth_profile_ref,
    });
  }
  if (endpoint.trigger_url) {
    prerequisites.push({
      prerequisite_id: nanoid(),
      kind: "page-context",
      name: "trigger_url",
      description: "Observed from a specific page context during traversal.",
      required: true,
      derived_from: endpoint.trigger_url,
    });
  }
  for (const binding of tokenBindings) {
    const top = binding.candidates[0];
    prerequisites.push({
      prerequisite_id: nanoid(),
      kind: "token-binding",
      name: binding.target_name,
      description: `Replay derives ${binding.target_name} from observed ${top?.source_kind ?? "token"} state.`,
      required: true,
      source_kind: top?.source_kind,
      source_name: top?.source_name,
      derived_from: top?.source_path,
    });
  }
  for (const hint of htmlHints.dom_form_hints.filter((entry) => entry.required || !!entry.pattern || !!entry.min || !!entry.max)) {
    prerequisites.push({
      prerequisite_id: nanoid(),
      kind: "hidden-field",
      name: hint.field_name,
      description: "Observed DOM field constraint recorded during traversal.",
      required: !!hint.required,
      selector: hint.selector,
      derived_from: hint.form_selector,
    });
  }
  if (actionSequence && actionSequence.length > 0) {
    prerequisites.push({
      prerequisite_id: nanoid(),
      kind: "browser-action",
      name: "action_sequence",
      description: `Observed ${actionSequence.length} browser action${actionSequence.length === 1 ? "" : "s"} before request.`,
      required: false,
    });
  }
  return prerequisites;
}

function buildNextStateSpecs(
  endpoint: EndpointDescriptor,
  finalUrl: string,
): WorkflowNextStateSpec[] {
  const nextState: WorkflowNextStateSpec[] = [];
  if (finalUrl) {
    nextState.push({
      kind: "page_url",
      value: finalUrl,
      description: "Observed page destination after successful traversal.",
    });
  }
  const schemaSummary = summarizeResponseSchema(endpoint);
  if (schemaSummary) {
    nextState.push({
      kind: "response_schema",
      value: schemaSummary,
      description: "Observed response shape summary for replay validation.",
    });
  }
  return nextState;
}

function buildReplayContract(
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
  matchedRequests: RawRequest[],
  htmlHints: HtmlWorkflowHints,
  tokenBindings: TokenBinding[],
  finalUrl: string,
  actionSequence?: WorkflowActionStep[],
): WorkflowReplayContract {
  const dependencyBindings = Array.from(new Set([
    ...templatePathParamNames(endpoint.url_template),
    ...Object.keys(endpoint.query ?? {}).map((key) => key),
    ...Object.keys(endpoint.body_params ?? {}).map((key) => key),
    ...Object.keys(endpoint.body ?? {}).map((key) => key),
    ...(endpoint.semantic?.requires ?? []).map((binding) => binding.key),
    ...(endpoint.semantic?.provides ?? []).map((binding) => binding.key),
    ...tokenBindings.map((binding) => binding.target_name),
  ].filter(Boolean))).sort();
  const searchTerms = Array.from(new Set([
    endpoint.method.toLowerCase(),
    ...endpoint.url_template.toLowerCase().split(/[^a-z0-9{}._-]+/).filter((token) => token.length >= 2),
    ...dependencyBindings.map((binding) => binding.toLowerCase()),
    ...(endpoint.semantic?.example_fields ?? []).map((field) => field.toLowerCase()),
  ])).slice(0, 48);
  return {
    explicit_replay_only: true,
    exposure_stage: "publish",
    dependency_bindings: dependencyBindings,
    search_terms: searchTerms,
    parameter_specs: buildParameterSpecs(endpoint, matchedRequests, htmlHints, tokenBindings),
    prerequisite_specs: buildPrerequisiteSpecs(skill, endpoint, htmlHints, tokenBindings, actionSequence),
    next_state: buildNextStateSpecs(endpoint, finalUrl),
  };
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
  finalUrl: string,
): WorkflowRecipe {
  const token_bindings = endpoint.method === "GET" ? [] : matchedRequests.flatMap((req) => inferTokenBindingsForRequest(req, htmlHints));
  const provenance_backed = matchedRequests.length > 0 || !!endpoint.trigger_url || !!endpoint.search_form || !!endpoint.dom_extraction;
  const auth_required = !!skill.auth_profile_ref || !!endpoint.semantic?.auth_required || token_bindings.length > 0;
  const parameter_mapping = parameterMappingConfident(endpoint);
  const steps = deriveWorkflowSteps(endpoint, matchedRequests);
  const actionSequence = steps.find((step) => step.strategy === "browser-action")?.action_sequence;
  return {
    recipe_id: nanoid(),
    endpoint_id: endpoint.endpoint_id,
    operation_id: operationIdForEndpoint(skill, endpoint.endpoint_id),
    preferred: false,
    provenance_backed,
    steps,
    token_bindings,
    mutation_guard: {
      confirm_unsafe_required: endpoint.method !== "GET" && endpoint.idempotency === "unsafe",
      provenance_backed,
      auth_required,
      parameter_mapping_confident: parameter_mapping,
      ...(!provenance_backed && endpoint.method !== "GET" ? { block_reason: "mutation requires provenance-backed workflow recipe" } : {}),
    },
    replay_contract: buildReplayContract(skill, endpoint, matchedRequests, htmlHints, token_bindings, finalUrl, actionSequence),
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
    capture.final_url,
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
      dom_option_hints: htmlHints.dom_option_hints,
      meta_hints: htmlHints.meta_hints,
      bootstrap_hints: htmlHints.bootstrap_hints,
    },
    recipes,
  };
}
