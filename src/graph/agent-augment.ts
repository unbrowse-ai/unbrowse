import type { EndpointDescriptor, OperationBinding } from "../types/index.js";
import { resolveEndpointSemantic } from "./index.js";
import { readDomainNote } from "../extraction/domain-notes.js";
import { getApiKey, buildReleaseAttestationHeaders } from "../client/index.js";
import {
  CODE_HASH,
  DEFAULT_BACKEND_URL,
  GIT_SHA,
  RELEASE_MANIFEST_BASE64,
  RELEASE_MANIFEST_SIGNATURE,
  TRACE_VERSION,
} from "../version.js";

// The semantic-augmentation prompt + model orchestration moved
// server-side (backend/src/services/semantic-augment.ts +
// POST /v1/graph/augment-semantic). The client now sends the
// already-sanitized endpoint skeleton UP and applies the enriched
// metadata it gets DOWN. This keeps the prompt out of the npm bundle
// and lets the model be swapped via server env (NEBIUS_API_KEY /
// UNBROWSE_AGENT_SEMANTIC_MODEL) without a client release. Augmentation
// stays best-effort and non-blocking: any failure returns the
// endpoints unchanged so the caller's local heuristic
// (generateLocalDescription) remains the description source.
const API_URL = process.env.UNBROWSE_API_URL || process.env.UNBROWSE_BACKEND_URL || DEFAULT_BACKEND_URL;
const AUGMENT_PATH = "/v1/graph/augment-semantic";
const ENABLED = process.env.UNBROWSE_AGENT_SEMANTIC_AUGMENT !== "0";
const AUGMENT_TIMEOUT_MS = Number(process.env.UNBROWSE_AGENT_SEMANTIC_TIMEOUT_MS ?? 9000);
const MAX_AUGMENT_ENDPOINTS = Math.max(1, Number(process.env.UNBROWSE_AGENT_SEMANTIC_MAX_ENDPOINTS ?? 6));
const MAX_AUGMENT_PAYLOAD_CHARS = Math.max(4000, Number(process.env.UNBROWSE_AGENT_SEMANTIC_MAX_PAYLOAD_CHARS ?? 24000));
const NOISE_ENDPOINT_HINTS = /(analytics|telemetry|beacon|metrics|cookie[_-]?sync|lr[_-]?sync|setuid|consent|cms\b|ups\/|guce\.|doubleverify|pubmatic|optable|pixel|experiments?|config|settings|heartbeat|ping\b|track|sync\b|auth\b|login\b)/i;
const DATA_ENDPOINT_HINTS = /(\/api\/|graphql|\/ws\/|\/v\d+\/|\/quote\b|\/chart\b|\/search\b|\/feed\b|\/results\b|\/items?\b|\/products?\b|\/repos?\b|\/users?\b|\/channels?\b|\/guilds?\b|\/servers?\b)/i;
const GENERIC_SEMANTIC_TYPES = new Set(["identifier", "input", "resource", "entity", "item"]);

type LlmBinding = {
  key?: string;
  semantic_type?: string;
  required?: boolean;
  source?: string;
  example_value?: string;
};

type LlmEndpointSemantic = {
  endpoint_id?: string;
  action_kind?: string;
  resource_kind?: string;
  description_out?: string;
  requires?: LlmBinding[];
  provides?: LlmBinding[];
  negative_tags?: string[];
};

type AugmentBackendResponse = {
  endpoints?: LlmEndpointSemantic[];
};

export type AgentSemanticAugmentOptions = {
  intent?: string;
  domain?: string;
  /**
   * Injection point for tests: stubs the backend augment call. In
   * production this is the global `fetch`; the request goes to
   * `${API_URL}${AUGMENT_PATH}`.
   */
  fetchImpl?: typeof fetch;
};

function compact(value: unknown, depth = 0): unknown {
  if (depth > 2 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => compact(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 10)
        .map(([key, next]) => [key, compact(next, depth + 1)]),
    );
  }
  if (typeof value === "string" && value.length > 180) return `${value.slice(0, 177)}...`;
  return value;
}

function tokenizeIntent(intent: string | undefined): string[] {
  return (intent ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !["get", "list", "find", "with", "from", "that", "this"].includes(token));
}

function describeEndpoint(endpoint: EndpointDescriptor): string {
  const semantic = resolveEndpointSemantic(endpoint);
  return [
    endpoint.method,
    endpoint.url_template,
    endpoint.trigger_url,
    endpoint.description,
    semantic.action_kind,
    semantic.resource_kind,
    semantic.description_out,
    ...(semantic.example_fields ?? []),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();
}

function endpointScore(endpoint: EndpointDescriptor, intent: string | undefined, domain: string | undefined): number {
  const semantic = resolveEndpointSemantic(endpoint);
  const haystack = describeEndpoint(endpoint);
  const intentTokens = tokenizeIntent(intent);
  let score = 0;

  if (endpoint.response_schema) score += 30;
  if (endpoint.dom_extraction) score += 25;
  if (endpoint.trigger_url) score += 10;
  if (DATA_ENDPOINT_HINTS.test(endpoint.url_template)) score += 18;
  if (/GET|WS/.test(endpoint.method)) score += 6;
  if (endpoint.reliability_score != null) score += endpoint.reliability_score * 10;

  if (domain && haystack.includes(domain.toLowerCase())) score += 8;
  for (const token of intentTokens) {
    if (haystack.includes(token)) score += 6;
  }

  const semanticTypes = [
    ...(semantic.requires ?? []).map((binding) => binding.semantic_type),
    ...(semantic.provides ?? []).map((binding) => binding.semantic_type),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (semanticTypes.some((value) => !GENERIC_SEMANTIC_TYPES.has(value))) score += 8;

  if (semantic.negative_tags?.length) score -= semantic.negative_tags.length * 6;
  if (NOISE_ENDPOINT_HINTS.test(haystack)) score -= 40;
  if (endpoint.method === "POST" && !endpoint.response_schema) score -= 12;

  return score;
}

function buildEndpointPayload(endpoint: EndpointDescriptor) {
  const semantic = resolveEndpointSemantic(endpoint);
  return {
    endpoint_id: endpoint.endpoint_id,
    method: endpoint.method,
    url_template: endpoint.url_template,
    trigger_url: endpoint.trigger_url,
    description: endpoint.description,
    current_semantic: {
      action_kind: semantic.action_kind,
      resource_kind: semantic.resource_kind,
      description_out: semantic.description_out,
      requires: semantic.requires,
      provides: semantic.provides,
      negative_tags: semantic.negative_tags,
    },
    sample_request: compact(semantic.example_request),
    sample_response: compact(semantic.example_response_compact),
    example_fields: semantic.example_fields?.slice(0, 12) ?? [],
  };
}

function selectEndpointsForAugment(
  endpoints: EndpointDescriptor[],
  intent: string | undefined,
  domain: string | undefined,
): EndpointDescriptor[] {
  const ranked = [...endpoints]
    .map((endpoint) => ({ endpoint, score: endpointScore(endpoint, intent, domain) }))
    .sort((a, b) => b.score - a.score);

  let selected = ranked
    .filter((entry) => entry.score > -20)
    .slice(0, MAX_AUGMENT_ENDPOINTS)
    .map((entry) => entry.endpoint);

  if (selected.length === 0) {
    selected = ranked.slice(0, Math.min(MAX_AUGMENT_ENDPOINTS, ranked.length)).map((entry) => entry.endpoint);
  }

  while (selected.length > 1) {
    const payload = JSON.stringify({
      intent,
      domain,
      endpoints: selected.map((endpoint) => buildEndpointPayload(endpoint)),
    });
    if (payload.length <= MAX_AUGMENT_PAYLOAD_CHARS) break;
    selected = selected.slice(0, -1);
  }

  return selected;
}

function validBindingKeys(endpoint: EndpointDescriptor): Set<string> {
  const semantic = resolveEndpointSemantic(endpoint);
  return new Set([
    ...(semantic.requires ?? []).map((binding) => binding.key),
    ...(semantic.provides ?? []).map((binding) => binding.key),
  ]);
}

function mergeBindings(
  existing: OperationBinding[] | undefined,
  incoming: LlmBinding[] | undefined,
  allowedKeys: Set<string>,
): OperationBinding[] {
  if (!existing?.length) return existing ?? [];
  if (!incoming?.length) return existing;
  const byKey = new Map(existing.map((binding) => [binding.key, binding]));
  for (const binding of incoming) {
    const key = typeof binding.key === "string" ? binding.key : "";
    if (!key || !allowedKeys.has(key)) continue;
    const current = byKey.get(key);
    if (!current) continue;
    byKey.set(key, {
      ...current,
      ...(typeof binding.semantic_type === "string" && binding.semantic_type ? { semantic_type: binding.semantic_type } : {}),
      ...(typeof binding.required === "boolean" ? { required: binding.required } : {}),
      ...(typeof binding.source === "string" && binding.source ? { source: binding.source } : {}),
      ...(typeof binding.example_value === "string" && binding.example_value ? { example_value: binding.example_value } : {}),
    });
  }
  return existing.map((binding) => byKey.get(binding.key) ?? binding);
}

function sanitizeSemanticUpdate(endpoint: EndpointDescriptor, update: LlmEndpointSemantic): EndpointDescriptor {
  const semantic = resolveEndpointSemantic(endpoint);
  const allowedKeys = validBindingKeys(endpoint);
  const nextSemantic = {
    ...semantic,
    ...(typeof update.action_kind === "string" && update.action_kind ? { action_kind: update.action_kind } : {}),
    ...(typeof update.resource_kind === "string" && update.resource_kind ? { resource_kind: update.resource_kind } : {}),
    ...(() => {
      if (typeof update.description_out !== "string" || !update.description_out) return {};
      const description_id_pattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const hasLeakedId = description_id_pattern.test(update.description_out) ||
        /\b[A-Za-z0-9_-]{24,}\b/.test(update.description_out);
      return hasLeakedId ? {} : { description_out: update.description_out };
    })(),
    ...(Array.isArray(update.negative_tags) ? { negative_tags: update.negative_tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0).slice(0, 8) } : {}),
    requires: mergeBindings(semantic.requires, update.requires, allowedKeys),
    provides: mergeBindings(semantic.provides, update.provides, allowedKeys),
    confidence: Math.max(semantic.confidence ?? 0, 0.9),
    // Authoritative provenance marker -- the LLM augmenter has actually
    // run and authored description_out. Downstream renderers
    // (getEndpointDescriptionMetadata, computeSemanticDescriptor) read
    // ONLY this field to claim description_source === "agent"; prose
    // inference no longer false-labels endpoints that look human-written
    // but never went through the augmenter.
    description_source: "agent" as const,
    description_needs_review: false,
  };
  return {
    ...endpoint,
    semantic: nextSemantic,
    description: nextSemantic.description_out ?? endpoint.description,
  };
}

/**
 * POST the selected endpoint skeletons to the server-side augmentation
 * route. The server owns the prompt + model orchestration. Returns the
 * enriched per-endpoint metadata, or null on any failure (the caller
 * then keeps endpoints unchanged -- best-effort, non-blocking).
 */
async function callBackendAugment(
  endpoints: EndpointDescriptor[],
  intent: string | undefined,
  domain: string | undefined,
  fetchImpl: typeof fetch,
  notePreamble: string,
): Promise<AugmentBackendResponse | null> {
  const endpointPayload = endpoints.map((endpoint) => buildEndpointPayload(endpoint));
  const key = getApiKey();
  const releaseAttestationHeaders = buildReleaseAttestationHeaders(
    RELEASE_MANIFEST_BASE64,
    RELEASE_MANIFEST_SIGNATURE,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUGMENT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${API_URL}${AUGMENT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "X-Unbrowse-Trace-Version": TRACE_VERSION,
        "X-Unbrowse-Code-Hash": CODE_HASH,
        "X-Unbrowse-Git-Sha": GIT_SHA,
        ...releaseAttestationHeaders,
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        intent,
        domain,
        note_preamble: notePreamble || undefined,
        endpoints: endpointPayload,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) return null;
  const body = (await res.json()) as AugmentBackendResponse;
  return body;
}

export async function augmentEndpointsWithAgent(
  endpoints: EndpointDescriptor[],
  opts: AgentSemanticAugmentOptions = {},
): Promise<EndpointDescriptor[]> {
  if (!ENABLED || endpoints.length === 0) return endpoints;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const selected = selectEndpointsForAugment(endpoints, opts.intent, opts.domain);
  if (selected.length === 0) return endpoints;
  // Prior-knowledge preamble: LLM-prose markdown written by the
  // notes-summarizer after past captures of this domain. Read
  // client-side (local notes file), passed UP to the server which
  // injects it as additional LLM context only -- the deterministic
  // ranker never sees it. See src/extraction/domain-notes.ts.
  let notePreamble = "";
  if (opts.domain) {
    try {
      const note = readDomainNote(opts.domain);
      if (note?.body) {
        notePreamble =
          `## Prior knowledge for ${opts.domain}\n\n` +
          `The LLM that captured this site previously wrote these notes. They may help disambiguate field meanings or flag known traps:\n\n` +
          `${note.body}\n\n---\n\n`;
      }
    } catch {
      // best-effort
    }
  }
  try {
    const response = await callBackendAugment(selected, opts.intent, opts.domain, fetchImpl, notePreamble);
    if (!response?.endpoints?.length) return endpoints;
    const updates = new Map(
      response.endpoints
        .filter((item): item is LlmEndpointSemantic & { endpoint_id: string } => typeof item.endpoint_id === "string" && item.endpoint_id.length > 0)
        .map((item) => [item.endpoint_id, item]),
    );
    return endpoints.map((endpoint) => {
      const update = updates.get(endpoint.endpoint_id);
      return update ? sanitizeSemanticUpdate(endpoint, update) : endpoint;
    });
  } catch {
    return endpoints;
  }
}
