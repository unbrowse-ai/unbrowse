import type {
  AgentAvailableOperation,
  AgentSkillChunkView,
  EndpointDescriptor,
  OperationBinding,
  ResponseSchema,
  SkillChunk,
  SkillManifest,
  SkillOperationEdge,
  SkillOperationGraph,
  SkillOperationNode,
} from "../types/index.js";
import { normalizeQueryBindingKey } from "../template-params.js";

function normalizeTokenText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2");
}

function tokenize(text: string): string[] {
  return normalizeTokenText(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("ges") || word.endsWith("zes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function pluralize(word: string): string {
  if (word === "person") return "people";
  if (word === "repository") return "repositories";
  if (word === "status") return "statuses";
  if (word.endsWith("y") && word.length > 2 && !/[aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (word.endsWith("s")) return word;
  return `${word}s`;
}

function humanizeToken(token: string): string {
  return normalizeTokenText(token.replace(/[{}]/g, "").replace(/[_-]+/g, " ")).toLowerCase().trim();
}

function compactExample(value: unknown, depth = 0): unknown {
  if (depth > 2 || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 2).map((item) => compactExample(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
    return Object.fromEntries(entries.map(([k, v]) => [k, compactExample(v, depth + 1)]));
  }
  if (typeof value === "string" && value.length > 160) return `${value.slice(0, 157)}...`;
  return value;
}

function flattenFields(value: unknown, prefix = "", out: string[] = []): string[] {
  if (value == null) return out;
  if (Array.isArray(value)) {
    if (value.length > 0) flattenFields(value[0], `${prefix}[]`, out);
    return out;
  }
  if (typeof value !== "object") {
    if (prefix) out.push(prefix);
    return out;
  }
  for (const [key, next] of Object.entries(value as Record<string, unknown>).slice(0, 10)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (next && typeof next === "object") flattenFields(next, path, out);
    else out.push(path);
  }
  return out;
}

function summarizeSchemaFields(schema?: ResponseSchema): string[] {
  if (!schema) return [];
  if (schema.properties) {
    const out: string[] = [];
    for (const [key, val] of Object.entries(schema.properties)) {
      out.push(key);
      if (val.properties) {
        for (const nested of Object.keys(val.properties).slice(0, 5)) out.push(`${key}.${nested}`);
      } else if (val.items?.properties) {
        for (const nested of Object.keys(val.items.properties).slice(0, 5)) out.push(`${key}[].${nested}`);
      }
    }
    return out;
  }
  if (schema.items?.properties) {
    return Object.keys(schema.items.properties).map((key) => `[].${key}`);
  }
  return [];
}

function inferActionKind(text: string): string {
  if (/\b(feed|timeline|stream|inbox)\b/.test(text)) return "timeline";
  if (/\b(search|find|lookup)\b/.test(text)) return "search";
  if (/\b(list|browse|index|catalog|channels|guilds|messages|posts|repos|repositories)\b/.test(text)) return "list";
  if (/\b(trending|top|latest|popular|hot)\b/.test(text)) return "trending";
  if (/\b(status|health|incident|maintenance)\b/.test(text)) return "status";
  if (/\b(create|post|send|submit)\b/.test(text)) return "create";
  if (/\b(update|patch|edit)\b/.test(text)) return "update";
  if (/\b(delete|remove)\b/.test(text)) return "delete";
  if (/\b(detail|details|info|profile|show|get)\b/.test(text)) return "detail";
  return "fetch";
}

function inferResourceKind(text: string, urlTemplate?: string): string {
  const pathHint = inferPathResourceHint(urlTemplate);
  if (pathHint) return pathHint;
  if (/\b(form|dropdown|select|option|field)\b/.test(text)) return "form";
  if (/\bpeople\b/.test(text)) return "person";
  if (/\b(feed|timeline|stream|home|update|updates|commentary|actor|socialdetail)\b/.test(text)) return "post";
  const candidates = [
    "channel", "guild", "message", "thread", "conversation", "repo", "repository",
    "profile", "person", "user", "post", "comment", "listing", "document", "issue", "job",
    "article", "video", "product", "event", "notification", "topic", "status", "form", "option",
    "referral", "promotion", "entitlement", "billing", "payment", "preference", "setting",
    "experiment", "assignment", "config",
  ];
  for (const candidate of candidates) {
    if (new RegExp(`\\b${candidate}s?\\b`).test(text)) return candidate;
  }
  return "resource";
}

function inferNegativeTags(text: string): string[] {
  const tags: string[] = [];
  if (/\b(experiment|assignment|fingerprint|feature)\b/.test(text)) tags.push("experiment");
  if (/\b(status|incident|maintenance)\b/.test(text)) tags.push("status");
  if (/\b(config|settings|manifest|bootstrap)\b/.test(text)) tags.push("config");
  if (/\b(auth|login|csrf|session|oauth|bearer|authorization)\b|access[_-]?token|refresh[_-]?token|id[_-]?token/.test(text)) tags.push("auth");
  if (/\b(telemetry|analytics|metrics|science|beacon|tracking)\b/.test(text)) tags.push("telemetry");
  if (/\b(thirdparty|syncs?|clientsignal|impression|tracklix)\b/.test(text)) tags.push("telemetry");
  if (/\b(helper|launcher|onboarding|setup)\b/.test(text)) tags.push("helper");
  if (/\b(allowlist|pagekey|controlurn)\b/.test(text)) tags.push("helper");
  if (/\b(recommendation|recommendations|suggested|sidebar)\b/.test(text)) tags.push("recommendation");
  if (/\b(settings|preferences|badge_count|counts|counter)\b/.test(text)) tags.push("settings");
  if (/\b(message|messaging|dm|conversation|mailbox|inbox)\b/.test(text)) tags.push("messaging");
  if (/\b(promoted|promotion|ads?)\b/.test(text)) tags.push("ads");
  if (/\b(affinit|promotions?|referrals?|entitlements?|billing|subscriptions?|collectibles?|gifts?|perk)\b/.test(text)) tags.push("adjacent");
  return unique(tags);
}

function inferPathResourceHint(urlTemplate?: string): string | null {
  if (!urlTemplate) return null;
  try {
    const pathname = new URL(urlTemplate).pathname;
    const generic = new Set([
      "api", "graphql", "rpc", "rest", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9",
      "users", "user", "me", "@me", "self", "app", "apps", "i",
    ]);
    const candidates = new Set([
      "channel", "guild", "message", "thread", "conversation", "repo", "repository",
      "profile", "person", "user", "post", "comment", "listing", "document", "issue", "job",
      "article", "video", "product", "event", "notification", "topic", "status", "form", "option",
      "referral", "promotion", "entitlement", "billing", "payment", "preference", "setting",
      "experiment", "assignment", "config",
    ]);
    const segments = pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const raw = humanizeToken(segments[i] ?? "");
      const token = singularize(raw);
      if (!token || generic.has(token)) continue;
      if (/^\d+$/.test(token) || /^[0-9a-f-]{8,}$/.test(token) || /^(true|false)$/.test(token)) continue;
      if (/^\{.+\}$/.test(segments[i] ?? "")) continue;
      if (token === "server") return "guild";
      if (candidates.has(token)) return token;
    }
  } catch {
    return null;
  }
  return null;
}

function fieldLeaf(field: string): string {
  return field.replace(/\[\]/g, "").split(".").pop()?.toLowerCase() ?? "";
}

function summarizeDescriptionFields(fields: string[]): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const leaf = fieldLeaf(field);
    if (!leaf || seen.has(leaf)) continue;
    if (/^(data|item|items|result|results|response|entry|entries|node|nodes|edge|edges|payload|value|values|__typename|type|flags?)$/.test(leaf)) continue;
    let label = "";
    if (/(^|_)id$/.test(leaf) || leaf === "id") label = "ids";
    else if (leaf === "name" || /_name$/.test(leaf)) label = "names";
    else if (leaf === "title") label = "titles";
    else if (/^(username|screen_name|handle|login|slug|public_identifier)$/.test(leaf)) label = "handles";
    else if (/^(content|body|text|message)$/.test(leaf)) label = "content";
    else if (/^(description|headline|summary)$/.test(leaf)) label = leaf === "headline" ? "headlines" : `${leaf}s`;
    else if (/^(status|indicator|state)$/.test(leaf)) label = "status";
    else if (/^(price|amount|value|score)$/.test(leaf)) label = leaf === "value" ? "values" : `${leaf}s`;
    else if (/(_count|count|total)$/.test(leaf)) label = "counts";
    else if (/^(created_at|updated_at|timestamp|date)$/.test(leaf)) label = "timestamps";
    else label = humanizeToken(leaf);
    if (seen.has(label)) continue;
    seen.add(leaf);
    seen.add(label);
    labels.push(label);
    if (labels.length >= 3) break;
  }
  return labels;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels[0]}, ${labels[1]}, and ${labels[2]}`;
}

function descriptionSubject(resourceKind: string, actionKind: string, text: string): string {
  const pathHint = inferPathResourceHint(text);
  const base = resourceKind && resourceKind !== "resource" ? resourceKind : (pathHint ?? "resource");
  const normalized = base === "repo" ? "repository" : base;
  return ["search", "list", "timeline", "trending"].includes(actionKind) ? pluralize(normalized) : normalized;
}

function isGenericDescription(description?: string): boolean {
  const normalized = normalizeTokenText(description ?? "").toLowerCase().trim();
  if (!normalized) return true;
  if (/^returns details for\b/.test(normalized)) return true;
  if (/^returns [a-z0-9 ]+ data\b/.test(normalized)) return true;
  if (/\bwith data\b/.test(normalized)) return true;
  if (/\busing (?:variables|queryid|decorationid)\b/.test(normalized)) return true;
  if (/^searches [a-z0-9 ]+ with\b/.test(normalized) && /\b(elements|data|queryid)\b/.test(normalized)) return true;
  return false;
}

function buildSemanticDescription(
  endpoint: EndpointDescriptor,
  actionKind: string,
  resourceKind: string,
  fields: string[],
): string {
  const subject = descriptionSubject(resourceKind, actionKind, endpoint.url_template);
  let description: string;
  switch (actionKind) {
    case "search":
      description = `Searches ${subject}`;
      break;
    case "timeline":
      description = `Returns ${subject} timeline`;
      break;
    case "trending":
      description = `Returns trending ${subject}`;
      break;
    case "detail":
      description = `Returns ${subject} details`;
      break;
    case "status":
      description = resourceKind === "status" ? "Returns status" : `Returns ${subject} status`;
      break;
    case "create":
      description = `Creates ${subject}`;
      break;
    case "update":
      description = `Updates ${subject}`;
      break;
    case "delete":
      description = `Deletes ${subject}`;
      break;
    default:
      description = `Returns ${subject}`;
      break;
  }
  const fieldLabels = summarizeDescriptionFields(fields);
  return fieldLabels.length > 0 ? `${description} with ${joinLabels(fieldLabels)}` : description;
}

function inferRequires(endpoint: EndpointDescriptor): OperationBinding[] {
  const requires: OperationBinding[] = [];
  const seen = new Set<string>();
  const add = (key: string, source: string, required = true) => {
    if (!key || seen.has(key) || key === "endpoint_id") return;
    seen.add(key);
    requires.push({
      key,
      required,
      source,
      semantic_type: key.endsWith("_id") || key === "id" ? "identifier" : "input",
    });
  };
  for (const key of Object.keys(endpoint.path_params ?? {})) add(key, "path_params");
  for (const key of Object.keys(endpoint.query ?? {})) add(normalizeQueryBindingKey(key), "query", false);
  for (const match of endpoint.url_template.matchAll(/\{([^}]+)\}/g)) add(match[1], "url_template");
  return requires;
}

function inferProvidesFromFields(fields: string[], resourceKind: string): OperationBinding[] {
  const provides: OperationBinding[] = [];
  const seen = new Set<string>();
  const add = (key: string, semanticType: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    provides.push({ key, semantic_type: semanticType, source: "response" });
  };
  const addFormBinding = (key: string) => {
    add(key, `${key}_option`);
    add(`${key}_value`, `${key}_option_value`);
  };
  const inferFormBindingKey = (field: string): string | null => {
    const normalized = field.replace(/\[\]/g, "");
    const match = normalized.match(/(?:^|\.)([a-z0-9_]+?)(?:_options?|_dropdowns?|_select)?\.(?:options?|choices?)\.(?:value|label)$/i)
      ?? normalized.match(/(?:^|\.)([a-z0-9_]+?)(?:_options?|_dropdowns?|_select)?\.(?:value|label)$/i);
    if (!match) return null;
    const key = singularize(match[1].toLowerCase())
      .replace(/^(field|form|filter)_/, "")
      .replace(/_(field|form|filter)$/, "");
    if (!key || ["option", "options", "choice", "choices", "value", "label"].includes(key)) return null;
    return key;
  };
  const resourceAliases: Record<string, string[]> = {
    repository: ["repo", "repository"],
    repo: ["repo", "repository"],
    person: ["person", "profile", "user", "member"],
    profile: ["profile", "user", "member", "person"],
    user: ["user", "profile", "member", "person"],
    post: ["post", "status", "tweet"],
    topic: ["topic", "trend"],
    listing: ["listing", "item", "product"],
    guild: ["guild", "server"],
    channel: ["channel", "conversation", "thread"],
    message: ["message", "post"],
  };
  const aliases = resourceAliases[resourceKind] ?? [resourceKind];
  for (const field of fields) {
    const key = field.replace(/\[\]/g, "").split(".").pop() ?? field;
    if (/(^|_)(id)$/.test(key)) add(key, `${resourceKind}_identifier`);
    else if (/_id$/.test(key)) add(key, `${key.replace(/_id$/, "")}_identifier`);
    else if (/^(rest_id|public_identifier|entity_urn|urn|slug|screen_name|username|handle)$/.test(key)) {
      add(key, `${resourceKind}_identifier`);
      for (const alias of aliases) add(`${alias}_id`, `${alias}_identifier`);
    } else if (/^(full_name|name|title)$/.test(key)) {
      for (const alias of aliases) add(`${alias}_name`, `${alias}_name`);
    } else if (/^(url|link|canonical_url)$/.test(key)) {
      for (const alias of aliases) add(`${alias}_url`, `${alias}_url`);
    } else if (/^(query|q|keyword|keywords|search_term)$/.test(key)) {
      add("query", "query_text");
    } else if (/^(owner|owner_login|login|author|author_username|author_screen_name)$/.test(key)) {
      add(key, `${resourceKind}_owner`);
      add("owner", `${resourceKind}_owner`);
    } else if (/^(repo|repository|repo_name|repository_name)$/.test(key)) {
      add("repo", "repository_name");
    } else if (/^(domain|hostname|host)$/.test(key)) {
      add("domain", "domain");
    } else if (/(slug|name|title|url|path)$/.test(key)) add(key, key);

    const formKey = inferFormBindingKey(field);
    if (formKey) addFormBinding(formKey);
  }
  if (!seen.has(`${resourceKind}_id`) && fields.some((field) => /(^|\.)(id|rest_id|public_identifier|urn)(\.|$)/.test(field))) {
    add(`${resourceKind}_id`, `${resourceKind}_identifier`);
    for (const alias of aliases) add(`${alias}_id`, `${alias}_identifier`);
  }
  if ((resourceKind === "repository" || aliases.includes("repository")) && fields.some((field) => /(full_name|name|title)/.test(field))) {
    add("repo", "repository_name");
    add("repository_name", "repository_name");
  }
  if ((resourceKind === "profile" || aliases.includes("profile")) && fields.some((field) => /(public_identifier|slug|username|handle|name)/.test(field))) {
    add("public_identifier", "profile_identifier");
    add("profile_id", "profile_identifier");
  }
  if ((resourceKind === "topic" || aliases.includes("topic")) && fields.some((field) => /(name|title|trend|topic)/.test(field))) {
    add("topic_name", "topic_name");
  }
  if ((resourceKind === "channel" || aliases.includes("channel")) && fields.some((field) => /(id|name|channel)/.test(field))) {
    add("channel_id", "channel_identifier");
    add("channel_name", "channel_name");
  }
  if (resourceKind === "form") {
    for (const field of fields) {
      const formKey = inferFormBindingKey(field);
      if (formKey) addFormBinding(formKey);
    }
  }
  return provides.slice(0, 8);
}

function semanticText(endpoint: EndpointDescriptor): string {
  return [
    endpoint.method,
    endpoint.url_template,
    endpoint.description ?? "",
    ...(endpoint.semantic?.example_fields ?? []),
  ].join(" ");
}

function bindingIdentity(binding: OperationBinding): string {
  return [
    binding.key,
    binding.source ?? "",
    binding.semantic_type ?? "",
    binding.type ?? "",
    binding.required ? "1" : "0",
  ].join("|");
}

function isGenericBindingKey(key: string | undefined): boolean {
  if (!key) return true;
  return /^(id|ids|url|urls|page|cursor|offset|limit|slug(?:_\d+)?|pathname|domain|query|q|type|name)$/.test(key);
}

function isGenericSemanticType(type: string | undefined): boolean {
  if (!type) return true;
  return /^(identifier|input|resource|value|string|number|flag)$/.test(type);
}

function mergeBindings(primary: OperationBinding[] = [], secondary: OperationBinding[] = []): OperationBinding[] {
  const merged: OperationBinding[] = [];
  const seen = new Set<string>();
  for (const binding of [...primary, ...secondary]) {
    const id = bindingIdentity(binding);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(binding);
  }
  return merged;
}

function semanticSupportScore(text: string, label?: string): number {
  if (!label) return -1;
  const tokens = unique(tokenize(label).map(singularize));
  if (tokens.length === 0) return -1;
  let score = 0;
  for (const token of tokens) {
    if (new RegExp(`\\b${token}\\b`).test(text)) score += 2;
  }
  return score;
}

function chooseSemanticKind(
  existing: string | undefined,
  inferred: string | undefined,
  text: string,
  genericKinds: Set<string>,
): string {
  if (!existing) return inferred ?? "";
  if (!inferred || existing === inferred) return existing;

  const existingLower = existing.toLowerCase();
  const inferredLower = inferred.toLowerCase();
  const existingGeneric = genericKinds.has(existingLower);
  const inferredGeneric = genericKinds.has(inferredLower);

  if (existingGeneric && !inferredGeneric) return inferred;

  const existingSupport = semanticSupportScore(text, existingLower);
  const inferredSupport = semanticSupportScore(text, inferredLower);

  if (inferredGeneric && !existingGeneric) {
    return existingSupport > inferredSupport ? existing : inferred;
  }

  if (inferredSupport !== existingSupport) return inferredSupport > existingSupport ? inferred : existing;
  return inferred;
}

export function inferEndpointSemantic(
  endpoint: EndpointDescriptor,
  opts?: {
    sampleResponse?: unknown;
    sampleRequest?: unknown;
    observedAt?: string;
    sampleRequestUrl?: string;
  },
): EndpointDescriptor["semantic"] {
  const fields = unique([
    ...summarizeSchemaFields(endpoint.response_schema),
    ...flattenFields(compactExample(opts?.sampleResponse ?? endpoint.semantic?.example_response_compact)),
  ]).slice(0, 20);
  const text = normalizeTokenText(`${semanticText(endpoint)} ${fields.join(" ")}`).toLowerCase();
  const actionKind = inferActionKind(text);
  const resourceKind = inferResourceKind(text, endpoint.url_template);
  const requires = inferRequires(endpoint);
  const provides = inferProvidesFromFields(fields, resourceKind);
  const negativeTags = inferNegativeTags(text);
  const generatedDescription = buildSemanticDescription(endpoint, actionKind, resourceKind, fields);
  const descriptionOut = endpoint.description && !isGenericDescription(endpoint.description)
    ? endpoint.description
    : generatedDescription;
  const descriptionIn = requires.length > 0
    ? `Requires ${requires.map((binding) => binding.key).join(", ")}`
    : "No additional inputs required";

  return {
    action_kind: actionKind,
    resource_kind: resourceKind,
    description_in: descriptionIn,
    description_out: descriptionOut,
    response_summary: fields.slice(0, 8).join(", "),
    example_request: compactExample(opts?.sampleRequest),
    example_response_compact: compactExample(opts?.sampleResponse ?? endpoint.semantic?.example_response_compact),
    example_fields: fields,
    requires,
    provides,
    negative_tags: negativeTags,
    confidence: fields.length > 0 ? 0.8 : 0.4,
    observed_at: opts?.observedAt,
    sample_request_url: opts?.sampleRequestUrl,
  };
}

export function resolveEndpointSemantic(
  endpoint: EndpointDescriptor,
  opts?: {
    sampleResponse?: unknown;
    sampleRequest?: unknown;
    observedAt?: string;
    sampleRequestUrl?: string;
  },
): EndpointDescriptor["semantic"] {
  const existing = endpoint.semantic;
  const inferred = inferEndpointSemantic(endpoint, {
    sampleResponse: opts?.sampleResponse ?? existing?.example_response_compact,
    sampleRequest: opts?.sampleRequest ?? existing?.example_request,
    observedAt: opts?.observedAt ?? existing?.observed_at,
    sampleRequestUrl: opts?.sampleRequestUrl ?? existing?.sample_request_url,
  });
  const supportText = normalizeTokenText([
    endpoint.method,
    endpoint.url_template,
    endpoint.description ?? "",
    existing?.description_out ?? "",
    inferred.description_out ?? "",
    existing?.response_summary ?? "",
    inferred.response_summary ?? "",
    ...(existing?.example_fields ?? []),
    ...(inferred.example_fields ?? []),
  ].join(" ")).toLowerCase();

  return {
    ...existing,
    ...inferred,
    action_kind: chooseSemanticKind(existing?.action_kind, inferred.action_kind, supportText, new Set(["fetch"])),
    resource_kind: chooseSemanticKind(existing?.resource_kind, inferred.resource_kind, supportText, new Set(["resource"])),
    description_in: inferred.description_in || existing?.description_in,
    description_out: inferred.description_out || existing?.description_out,
    response_summary: inferred.response_summary || existing?.response_summary,
    example_request: opts?.sampleRequest ?? existing?.example_request ?? inferred.example_request,
    example_response_compact: opts?.sampleResponse ?? existing?.example_response_compact ?? inferred.example_response_compact,
    example_fields: unique([...(inferred.example_fields ?? []), ...(existing?.example_fields ?? [])]).slice(0, 20),
    requires: mergeBindings(existing?.requires, inferred.requires),
    provides: mergeBindings(existing?.provides, inferred.provides),
    negative_tags: [...(inferred.negative_tags ?? [])],
    confidence: Math.max(existing?.confidence ?? 0, inferred.confidence ?? 0),
    observed_at: opts?.observedAt ?? existing?.observed_at ?? inferred.observed_at,
    sample_request_url: opts?.sampleRequestUrl ?? existing?.sample_request_url ?? inferred.sample_request_url,
    auth_required: existing?.auth_required ?? inferred.auth_required ?? false,
  };
}

function buildOperationNode(endpoint: EndpointDescriptor): SkillOperationNode {
  const semantic = resolveEndpointSemantic(endpoint);
  return {
    operation_id: endpoint.endpoint_id,
    endpoint_id: endpoint.endpoint_id,
    method: endpoint.method,
    url_template: endpoint.url_template,
    trigger_url: endpoint.trigger_url,
    action_kind: semantic.action_kind,
    resource_kind: semantic.resource_kind,
    description_in: semantic.description_in,
    description_out: semantic.description_out,
    response_summary: semantic.response_summary,
    requires: semantic.requires ?? [],
    provides: semantic.provides ?? [],
    negative_tags: semantic.negative_tags ?? [],
    example_request: semantic.example_request,
    example_response_compact: semantic.example_response_compact,
    example_fields: semantic.example_fields ?? [],
    confidence: semantic.confidence ?? 0.5,
    observed_at: semantic.observed_at,
    auth_required: semantic.auth_required ?? false,
  };
}

function operationScore(op: SkillOperationNode, intent?: string): number {
  if (!intent) return 0;
  const intentTokens = tokenize(intent);
  const opTokens = tokenize([
    op.action_kind,
    op.resource_kind,
    op.description_out ?? "",
    op.response_summary ?? "",
    ...(op.example_fields ?? []),
  ].join(" "));
  let score = 0;
  for (const token of intentTokens) if (opTokens.includes(singularize(token))) score += 2;
  score -= operationSoftPenalty(op, intent);
  return score;
}

function intentHasAny(intent: string | undefined, patterns: string[]): boolean {
  if (!intent) return false;
  const lowered = intent.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern));
}

function operationTextBlob(op: SkillOperationNode): string {
  return [
    op.method,
    op.url_template,
    op.trigger_url ?? "",
    op.action_kind,
    op.resource_kind,
    op.description_in ?? "",
    op.description_out ?? "",
    op.response_summary ?? "",
    ...(op.example_fields ?? []),
    ...(op.negative_tags ?? []),
  ].join(" ").toLowerCase();
}

export function isOperationHardExcluded(op: SkillOperationNode, intent?: string): boolean {
  const text = operationTextBlob(op);
  const tags = new Set(op.negative_tags ?? []);
  if (tags.has("telemetry") || tags.has("ads")) return true;
  if (tags.has("experiment") && !intentHasAny(intent, ["experiment", "feature flag", "assignment"])) return true;
  if (tags.has("auth") && !intentHasAny(intent, ["auth", "login", "session", "token", "csrf"])) return true;
  if (tags.has("status") && !intentHasAny(intent, ["status", "health", "incident", "maintenance"])) return true;
  if (tags.has("config") && !intentHasAny(intent, ["config", "setting", "settings", "preference", "preferences"])) return true;
  if (/\b(intercom|ping|beacon|track|tracking|telemetry|metrics|log\.json|promoted_content)\b/.test(text)) return true;
  return false;
}

export function operationSoftPenalty(op: SkillOperationNode, intent?: string): number {
  const text = operationTextBlob(op);
  const tags = new Set(op.negative_tags ?? []);
  let penalty = 0;
  if (tags.has("helper")) penalty += 6;
  if (tags.has("recommendation") && !intentHasAny(intent, ["recommend", "suggest", "sidebar"])) penalty += 7;
  if (tags.has("settings") && !intentHasAny(intent, ["setting", "settings", "preference", "preferences"])) penalty += 8;
  if (tags.has("messaging") && !intentHasAny(intent, ["message", "dm", "conversation", "mailbox", "inbox", "channel"])) penalty += 6;
  if (tags.has("adjacent")) penalty += 6;
  if (/\b(helper|recommendation|sidebar|badge(?:_count)?|notification(?:s)?|verifiedorg|subscription|preferences?|settings?)\b/.test(text)) penalty += 5;
  return penalty;
}

function isBefore(lhs?: string, rhs?: string): boolean {
  if (!lhs || !rhs) return true;
  return new Date(lhs).getTime() <= new Date(rhs).getTime();
}

export function buildSkillOperationGraph(endpoints: EndpointDescriptor[]): SkillOperationGraph {
  const operations = endpoints.map(buildOperationNode);
  const edges: SkillOperationEdge[] = [];
  const seenEdges = new Set<string>();
  for (const target of operations) {
    for (const required of target.requires) {
      for (const source of operations) {
        if (source.operation_id === target.operation_id) continue;
        const match = source.provides.find((provided) => {
          const exactKeyMatch = provided.key === required.key && !isGenericBindingKey(required.key);
          const semanticMatch =
            !!provided.semantic_type &&
            !!required.semantic_type &&
            provided.semantic_type === required.semantic_type &&
            !isGenericSemanticType(required.semantic_type);
          return exactKeyMatch || semanticMatch;
        });
        if (!match) continue;
        if (!isBefore(source.observed_at, target.observed_at)) continue;
        const edgeId = `${source.operation_id}:${target.operation_id}:${required.key}`;
        if (seenEdges.has(edgeId)) continue;
        seenEdges.add(edgeId);
        edges.push({
          edge_id: edgeId,
          from_operation_id: source.operation_id,
          to_operation_id: target.operation_id,
          binding_key: required.key,
          kind: match.key === required.key ? "dependency" : "hint",
          confidence: match.key === required.key ? 0.9 : 0.6,
        });
      }
    }
  }
  const entryOperationIds = operations
    .filter((operation) => operation.requires.length === 0 || operation.requires.every((binding) => binding.source === "query"))
    .map((operation) => operation.operation_id);

  return {
    generated_at: new Date().toISOString(),
    entry_operation_ids: entryOperationIds,
    operations,
    edges,
  };
}

export function ensureSkillOperationGraph(skill: SkillManifest): SkillOperationGraph {
  if (skill.endpoints.length > 0) return buildSkillOperationGraph(skill.endpoints);
  if (skill.operation_graph?.operations?.length) return skill.operation_graph;
  return buildSkillOperationGraph(skill.endpoints);
}

export function knownBindingsFromInputs(
  params: Record<string, unknown> = {},
  contextUrl?: string,
): Record<string, unknown> {
  const known: Record<string, unknown> = { ...params };
  if (!contextUrl) return known;
  try {
    const url = new URL(contextUrl);
    known.url = contextUrl;
    known.domain = url.hostname;
    known.pathname = url.pathname;
    let index = 1;
    for (const seg of url.pathname.split("/").filter(Boolean)) {
      known[`slug_${index++}`] = seg;
    }
    for (const [key, value] of url.searchParams.entries()) {
      if (known[key] == null) known[key] = value;
      const normalized = normalizeQueryBindingKey(key);
      if (known[normalized] == null) known[normalized] = value;
    }
  } catch { /* ignore */ }
  return known;
}

function isRunnable(operation: SkillOperationNode, bindings: Record<string, unknown>): boolean {
  return operation.requires.every((binding) => {
    if (!binding.required) return true;
    const value = bindings[binding.key];
    return value != null && value !== "";
  });
}

export function getSkillChunk(
  skill: SkillManifest,
  opts?: {
    intent?: string;
    seed_operation_id?: string;
    known_bindings?: Record<string, unknown>;
    max_operations?: number;
  },
): SkillChunk {
  const graph = ensureSkillOperationGraph(skill);
  const known = opts?.known_bindings ?? {};
  const maxOperations = opts?.max_operations ?? 6;
  const filtered = graph.operations.filter((operation) => !isOperationHardExcluded(operation, opts?.intent));
  const candidateOps = filtered.length > 0 ? filtered : graph.operations;
  const scored = [...candidateOps].sort((a, b) => operationScore(b, opts?.intent) - operationScore(a, opts?.intent));
  const seedIds = opts?.seed_operation_id
    ? [opts.seed_operation_id]
    : scored.slice(0, Math.max(1, Math.min(3, scored.length))).map((op) => op.operation_id);
  const queue = [...seedIds];
  const seen = new Set<string>(seedIds);
  while (queue.length > 0 && seen.size < maxOperations) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.from_operation_id !== current && edge.to_operation_id !== current) continue;
      const neighbor = edge.from_operation_id === current ? edge.to_operation_id : edge.from_operation_id;
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      queue.push(neighbor);
      if (seen.size >= maxOperations) break;
    }
  }
  const operations = graph.operations.filter((operation) => seen.has(operation.operation_id) && !isOperationHardExcluded(operation, opts?.intent));
  const edges = graph.edges.filter((edge) => seen.has(edge.from_operation_id) && seen.has(edge.to_operation_id));
  const visibleOperations = operations.length > 0 ? operations : graph.operations.filter((operation) => seen.has(operation.operation_id));
  const availableOperationIds = operations
    .filter((operation) => isRunnable(operation, known))
    .sort((a, b) => operationScore(b, opts?.intent) - operationScore(a, opts?.intent))
    .map((operation) => operation.operation_id);
  const missingBindings = unique(
    visibleOperations.flatMap((operation) =>
      operation.requires
        .filter((binding) => binding.required && (known[binding.key] == null || known[binding.key] === ""))
        .map((binding) => binding.key)
    )
  );
  return {
    skill_id: skill.skill_id,
    intent: opts?.intent,
    available_operation_ids: availableOperationIds,
    missing_bindings: missingBindings,
    operations: visibleOperations,
    edges,
  };
}

function summarizeBindingKeys(bindings: OperationBinding[] | undefined): string[] {
  return unique((bindings ?? []).map((binding) => binding.key));
}

function readableOperationTitle(operation: SkillOperationNode): string {
  const action = operation.action_kind.replace(/_/g, " ");
  const resource = operation.resource_kind.replace(/_/g, " ");
  return `${action} ${resource}`.trim();
}

function toAgentAvailableOperation(operation: SkillOperationNode): AgentAvailableOperation {
  const required = summarizeBindingKeys(operation.requires);
  const yields = summarizeBindingKeys(operation.provides);
  return {
    operation_id: operation.operation_id,
    method: operation.method,
    action_kind: operation.action_kind,
    resource_kind: operation.resource_kind,
    title: readableOperationTitle(operation),
    why_available: required.length === 0
      ? "Runnable now; no missing dependencies."
      : `Runnable now; required bindings already known: ${required.join(", ")}.`,
    url_template: operation.url_template,
    requires: required,
    yields,
    example_request: operation.example_request,
    example_response_compact: operation.example_response_compact,
  };
}

export function toAgentSkillChunkView(chunk: SkillChunk): AgentSkillChunkView {
  const availableOperations = chunk.available_operation_ids
    .map((operationId) => chunk.operations.find((operation) => operation.operation_id === operationId))
    .filter((operation): operation is SkillOperationNode => !!operation)
    .map(toAgentAvailableOperation);

  return {
    skill_id: chunk.skill_id,
    intent: chunk.intent,
    missing_bindings: chunk.missing_bindings,
    suggested_next_operation_id: availableOperations[0]?.operation_id,
    available_operations: availableOperations,
  };
}
