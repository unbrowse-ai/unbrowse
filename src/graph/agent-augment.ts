import type { EndpointDescriptor, OperationBinding } from "../types/index.js";
import { resolveEndpointSemantic } from "./index.js";

const CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.UNBROWSE_AGENT_SEMANTIC_MODEL ?? process.env.UNBROWSE_AGENT_JUDGE_MODEL ?? "gpt-4.1-mini";
const ENABLED = process.env.UNBROWSE_AGENT_SEMANTIC_AUGMENT !== "0";
const AUGMENT_TIMEOUT_MS = Number(process.env.UNBROWSE_AGENT_SEMANTIC_TIMEOUT_MS ?? 8000);
const MAX_AUGMENT_ENDPOINTS = Math.max(1, Number(process.env.UNBROWSE_AGENT_SEMANTIC_MAX_ENDPOINTS ?? 6));
const MAX_AUGMENT_PAYLOAD_CHARS = Math.max(4000, Number(process.env.UNBROWSE_AGENT_SEMANTIC_MAX_PAYLOAD_CHARS ?? 24000));
const NOISE_ENDPOINT_HINTS = /(analytics|telemetry|beacon|metrics|cookie[_-]?sync|lr[_-]?sync|setuid|consent|cms\b|ups\/|guce\.|doubleverify|pubmatic|optable|pixel|experiments?|config|settings|heartbeat|ping\b|track|sync\b|auth\b|login\b)/i;
const DATA_ENDPOINT_HINTS = /(\/api\/|graphql|\/ws\/|\/v\d+\/|\/quote\b|\/chart\b|\/search\b|\/feed\b|\/results\b|\/items?\b|\/products?\b|\/repos?\b|\/users?\b|\/channels?\b|\/guilds?\b|\/servers?\b)/i;
const GENERIC_SEMANTIC_TYPES = new Set(["identifier", "input", "resource", "entity", "item"]);

type Provider = {
  url: string;
  key: string;
  model: string;
};

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

type LlmResponse = {
  endpoints?: LlmEndpointSemantic[];
};

export type AgentSemanticAugmentOptions = {
  intent?: string;
  domain?: string;
  fetchImpl?: typeof fetch;
  provider?: Provider | null;
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

function availableProviders(): Provider[] {
  const providers = [
    process.env.OPENAI_API_KEY ? { url: OPENAI_CHAT_URL, key: process.env.OPENAI_API_KEY, model: DEFAULT_MODEL } : null,
    process.env.NEBIUS_API_KEY ? { url: CHAT_URL, key: process.env.NEBIUS_API_KEY, model: DEFAULT_MODEL } : null,
  ].filter((provider): provider is Provider => !!provider);
  return providers;
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
    ...(typeof update.description_out === "string" && update.description_out ? { description_out: update.description_out } : {}),
    ...(Array.isArray(update.negative_tags) ? { negative_tags: update.negative_tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0).slice(0, 8) } : {}),
    requires: mergeBindings(semantic.requires, update.requires, allowedKeys),
    provides: mergeBindings(semantic.provides, update.provides, allowedKeys),
    confidence: Math.max(semantic.confidence ?? 0, 0.9),
  };
  return {
    ...endpoint,
    semantic: nextSemantic,
    description: nextSemantic.description_out ?? endpoint.description,
  };
}

async function callAgent(
  provider: Provider,
  endpoints: EndpointDescriptor[],
  intent: string | undefined,
  domain: string | undefined,
  fetchImpl: typeof fetch,
): Promise<LlmResponse | null> {
  const prompt = [
    "You refine learned API skill metadata for a web automation system.",
    "Return JSON only.",
    "Do not invent endpoints or binding keys.",
    "Only reuse keys already present in each endpoint's current requires/provides.",
    "Upgrade generic labels into better action/resource kinds and semantic binding types when grounded by the URL, trigger URL, sample request, sample response, and sibling endpoint context.",
    "Prefer precise semantic types like repository_owner, repository_name, profile_identifier, query_text, product_identifier, recommendation_placement_id.",
    "Reject generic output like identifier, input, resource unless no better grounded type exists.",
    "For each endpoint, produce endpoint_id plus any improved action_kind, resource_kind, description_out, requires, provides, and negative_tags.",
  ].join("\n");

  const endpointPayload = endpoints.map((endpoint) => buildEndpointPayload(endpoint));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUGMENT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(provider.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content: JSON.stringify({
              intent,
              domain,
              endpoints: endpointPayload,
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`semantic_augment_http_${res.status}`);
  const body = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) return null;
  return JSON.parse(content) as LlmResponse;
}

export async function augmentEndpointsWithAgent(
  endpoints: EndpointDescriptor[],
  opts: AgentSemanticAugmentOptions = {},
): Promise<EndpointDescriptor[]> {
  if (!ENABLED || endpoints.length === 0) return endpoints;
  const provider = opts.provider === undefined ? availableProviders()[0] ?? null : opts.provider;
  if (!provider) return endpoints;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const selected = selectEndpointsForAugment(endpoints, opts.intent, opts.domain);
  if (selected.length === 0) return endpoints;
  try {
    const response = await callAgent(provider, selected, opts.intent, opts.domain, fetchImpl);
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
