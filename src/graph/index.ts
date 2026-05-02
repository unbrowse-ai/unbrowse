import type {
  AgentAvailableOperation,
  AgentPrefetchOperation,
  AgentSkillChunkView,
  AgentWorkflowDagOperation,
  AgentWorkflowDagView,
  EndpointDescriptor,
  EndpointSemanticDescriptor,
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

function stripFileExtension(segment: string): string {
  return segment.replace(/\.[a-z0-9]{1,8}$/i, "");
}

function sanitizeBindingName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
}

function isStructuralPathSegment(segment?: string): boolean {
  if (!segment) return true;
  return /^(api|v\d+|www|en|es|fr|de|ja|zh|ko|latest|dex|search)$/i.test(segment);
}

function looksLikeAcademicYear(segment: string): boolean {
  return /^\d{4}-\d{4}$/.test(segment);
}

function looksLikeCodeIdentifier(segment: string): boolean {
  return /^[A-Z]{2,}\d[A-Z0-9]*$/i.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment);
}

function inferPathBindingName(candidate: NonNullable<EndpointDescriptor["_path_binding_candidates"]>[number]): string {
  const value = stripFileExtension(candidate.observed_value);
  const prev = sanitizeBindingName(candidate.preceding_segment ?? "");

  if (looksLikeAcademicYear(value)) return "academic_year";
  if ((prev === "semester" || prev === "semesters") && /^\d{1,2}$/.test(value)) return "semester";
  if ((prev === "module" || prev === "modules") && looksLikeCodeIdentifier(value)) return "module_code";
  if ((prev === "course" || prev === "courses") && looksLikeCodeIdentifier(value)) return "course_code";
  if ((prev === "class" || prev === "classes") && looksLikeCodeIdentifier(value)) return "class_code";

  if (!isStructuralPathSegment(prev)) {
    const singular = sanitizeBindingName(singularize(prev));
    if (singular) return singular;
  }

  if (candidate.placeholder_hint === "urn") return "urn";
  if (candidate.placeholder_hint === "list") return "list";
  return "id";
}

function ensureUniqueBindingName(name: string, usedNames: Set<string>): string {
  const base = sanitizeBindingName(name) || "id";
  let unique = base;
  let counter = 2;
  while (usedNames.has(unique)) unique = `${base}_${counter++}`;
  usedNames.add(unique);
  return unique;
}

function replaceTemplateBinding(urlTemplate: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return urlTemplate.replace(new RegExp(`\\{${escaped}\\}`, "g"), `{${to}}`);
}

export function resolveEndpointPathBindings(endpoint: EndpointDescriptor): EndpointDescriptor {
  const candidates = endpoint._path_binding_candidates ?? [];
  if (candidates.length === 0) return endpoint;

  let urlTemplate = endpoint.url_template;
  const nextPathParams = { ...(endpoint.path_params ?? {}) };
  const candidatePlaceholders = new Set(candidates.map((candidate) => candidate.placeholder));
  const usedNames = new Set<string>([
    ...Object.keys(nextPathParams).filter((key) => !candidatePlaceholders.has(key) && !/^path_\d+$/.test(key)),
    ...Array.from(urlTemplate.matchAll(/\{([^}]+)\}/g)).map((match) => match[1]).filter((key) => !candidatePlaceholders.has(key) && !/^path_\d+$/.test(key)),
  ]);

  for (const candidate of candidates) {
    const oldKey = candidate.placeholder;
    const newKey = ensureUniqueBindingName(inferPathBindingName(candidate), usedNames);
    if (oldKey === newKey) {
      usedNames.add(newKey);
      continue;
    }
    urlTemplate = replaceTemplateBinding(urlTemplate, oldKey, newKey);
    if (Object.prototype.hasOwnProperty.call(nextPathParams, oldKey)) {
      nextPathParams[newKey] = nextPathParams[oldKey];
      delete nextPathParams[oldKey];
    }
  }

  return {
    ...endpoint,
    url_template: urlTemplate,
    ...(Object.keys(nextPathParams).length > 0 ? { path_params: nextPathParams } : { path_params: undefined }),
  };
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

function isCapturedArtifactDescription(description?: string): boolean {
  const normalized = normalizeTokenText(description ?? "").toLowerCase().trim();
  return /^captured (?:search form |page )?artifact for\b/.test(normalized);
}

function isGenericDescription(description?: string): boolean {
  const normalized = normalizeTokenText(description ?? "").toLowerCase().trim();
  if (!normalized) return true;
  if (isCapturedArtifactDescription(normalized)) return true;
  if (/^(search form|page content) for\b/.test(normalized)) return true;
  if (/^returns details for\b/.test(normalized)) return true;
  if (/^returns [a-z0-9 ]+ data\b/.test(normalized)) return true;
  if (/\bwith data\b/.test(normalized)) return true;
  if (/\busing (?:variables|queryid|decorationid)\b/.test(normalized)) return true;
  if (/^searches [a-z0-9 ]+ with\b/.test(normalized) && /\b(elements|data|queryid)\b/.test(normalized)) return true;
  return false;
}

function classifyDescriptionInput(description?: string): {
  source: "agent" | "auto" | "missing";
  warning?: string;
} {
  const normalized = normalizeTokenText(description ?? "").trim();
  if (!normalized) {
    return {
      source: "missing",
      warning: "Description missing. Review before trusting or publishing.",
    };
  }
  if (isCapturedArtifactDescription(normalized)) {
    return {
      source: "auto",
      warning: "Auto-generated from a captured page artifact. Review before trusting or publishing.",
    };
  }
  if (isGenericDescription(normalized)) {
    return {
      source: "auto",
      warning: "Auto-generated description. Review before trusting or publishing.",
    };
  }
  return { source: "agent" };
}

export function getEndpointDescriptionMetadata(endpoint: Pick<EndpointDescriptor, "description" | "semantic">): {
  display: string;
  source: "agent" | "auto" | "missing";
  needs_review: boolean;
  warning?: string;
} {
  const input = classifyDescriptionInput(endpoint.description);
  // Trust the LLM augmenter's semantic layer when it has run.
  const agentAugmented = endpoint.semantic?.description_source === "agent";
  // Schema-grounded auto descriptions (with real response fields) don't need
  // external LLM review — the calling agent IS the LLM that reviews them.
  const schemaGrounded = !!(endpoint.semantic?.example_fields?.length || endpoint.semantic?.response_summary);
  const display = (input.source === "agent" || agentAugmented
    ? endpoint.semantic?.description_out ?? endpoint.description ?? ""
    : endpoint.semantic?.description_out ?? endpoint.description ?? "").trim();
  const source = display ? (input.source === "agent" || agentAugmented ? "agent" : "auto") : "missing";
  // Honor explicit description_needs_review flag from the semantic layer
  // (set by the auto-augmenter when its confidence is low). Without this,
  // auto-generated descriptions that ARE schema-grounded silently bypass review.
  const explicitlyNeedsReview = endpoint.semantic?.description_needs_review === true;
  return {
    display,
    source,
    needs_review:
      explicitlyNeedsReview ||
      source === "missing" ||
      (source === "auto" && !schemaGrounded),
    ...(source !== "agent" && !schemaGrounded
      ? { warning: input.warning ?? "Auto-generated description. Review before trusting or publishing." }
      : {}),
  };
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

function inferBindingSemanticType(key: string): string {
  if (key === "academic_year") return "academic_year";
  if (key === "semester") return "semester";
  if (/^(module|course|class)_code$/.test(key)) return key;
  if (key.endsWith("_id") || key === "id" || key === "urn") return "identifier";
  return "input";
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
      semantic_type: inferBindingSemanticType(key),
    });
  };
  for (const key of Object.keys(endpoint.path_params ?? {})) add(key, "path_params", false);
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

const BINDING_ENTITY_ALIASES: Record<string, string> = {
  repo: "repository",
  repository: "repository",
  owner: "repository",
  profile: "profile",
  person: "profile",
  member: "profile",
  user: "profile",
  account: "profile",
  org: "company",
  organization: "company",
  company: "company",
  listing: "listing",
  item: "listing",
  product: "listing",
  guild: "guild",
  server: "guild",
  channel: "channel",
  conversation: "channel",
  thread: "channel",
  post: "post",
  tweet: "post",
  status: "post",
  update: "post",
  topic: "topic",
  trend: "topic",
};

function isGenericBindingKey(key: string | undefined): boolean {
  if (!key) return true;
  return /^(id|ids|url|urls|page|cursor|offset|limit|slug(?:_\d+)?|pathname|domain|query|q|type|name)$/.test(key);
}

const PAGINATION_KEYS = new Set(["cursor", "page", "offset", "page_token", "next_cursor", "after", "before", "start", "next_page", "continuation_token", "skip", "from", "scroll_id"]);
function isPaginationBindingKey(key: string): boolean {
  return PAGINATION_KEYS.has(key) || /^(next_|prev_|previous_)/.test(key) || /_cursor$/.test(key);
}

function classifyEdgeKind(source: SkillOperationNode, target: SkillOperationNode, bindingKey: string): SkillOperationEdge["kind"] {
  if (source.operation_id === target.operation_id && isPaginationBindingKey(bindingKey)) return "pagination";
  const LIST_ACTIONS = new Set(["list", "search", "timeline", "trending", "feed"]);
  const DETAIL_ACTIONS = new Set(["detail", "fetch"]);
  if (LIST_ACTIONS.has(source.action_kind) && DETAIL_ACTIONS.has(target.action_kind) && source.resource_kind === target.resource_kind && source.resource_kind !== "resource") return "parent_child";
  if (target.auth_required && /^(auth|login|token|session|oauth)$/.test(source.action_kind)) return "auth";
  return "dependency";
}

function isGenericSemanticType(type: string | undefined): boolean {
  if (!type) return true;
  return /^(identifier|input|resource|value|string|number|flag)$/.test(type);
}

function canonicalBindingEntity(entity?: string): string | undefined {
  if (!entity) return undefined;
  const normalized = singularize(entity.toLowerCase().replace(/[^a-z0-9_]+/g, "_"));
  return BINDING_ENTITY_ALIASES[normalized] ?? normalized;
}

function bindingValueKind(binding: OperationBinding): string | undefined {
  const semanticType = binding.semantic_type?.toLowerCase();
  const key = binding.key.toLowerCase();
  if (semanticType === "query_text" || /^(q|query|keyword|keywords|search_term)$/.test(key)) return "query";
  if (
    semanticType === "identifier" ||
    /_identifier$/.test(semanticType ?? "") ||
    /(^|_)(id|identifier|urn)$/.test(key) ||
    /^(public_identifier|entity_urn|rest_id)$/.test(key)
  ) return "identifier";
  if (/_name$/.test(semanticType ?? "") || /^(name|full_name|title)$/.test(key)) return "name";
  if (/_url$/.test(semanticType ?? "") || /^(url|link|canonical_url|path)$/.test(key)) return "url";
  if (/_option_value$/.test(semanticType ?? "") || /_value$/.test(key)) return "option_value";
  if (/_option$/.test(semanticType ?? "")) return "option";
  if (/_owner$/.test(semanticType ?? "") || /^(owner|owner_login|author|author_username|author_screen_name)$/.test(key)) return "owner";
  return undefined;
}

function bindingEntityKind(binding: OperationBinding): string | undefined {
  const semanticType = binding.semantic_type?.toLowerCase();
  if (semanticType && !isGenericSemanticType(semanticType)) {
    const semanticMatch = semanticType.match(/^(.*)_(identifier|name|url|owner|option|option_value)$/);
    if (semanticMatch) return canonicalBindingEntity(semanticMatch[1]);
    if (semanticType === "query_text") return "query";
  }

  const key = binding.key.toLowerCase();
  if (/^(public_identifier|profile_id|member_id|person_id|user_id|account_id|screen_name|username|handle)$/.test(key)) {
    return "profile";
  }
  if (/^(repo|repo_id|repository|repository_id|repository_name|owner|owner_login)$/.test(key)) {
    return "repository";
  }
  if (/^(company_id|organization_id|org_id|company_name|organization_name)$/.test(key)) {
    return "company";
  }
  if (/^(listing_id|item_id|product_id|listing_name|product_name)$/.test(key)) {
    return "listing";
  }
  if (/^(channel_id|conversation_id|thread_id|channel_name)$/.test(key)) {
    return "channel";
  }
  if (/^(guild_id|server_id|guild_name|server_name)$/.test(key)) {
    return "guild";
  }
  if (/^(post_id|tweet_id|status_id|update_id|post_url)$/.test(key)) {
    return "post";
  }
  if (/^(topic_id|topic_name|trend_id|trend_name)$/.test(key)) {
    return "topic";
  }

  const stripped = key
    .replace(/^(public|entity|canonical|selected|current)_/, "")
    .replace(/_(id|identifier|name|url|slug|urn|value|option|owner)$/, "");
  if (!stripped || isGenericBindingKey(stripped)) return undefined;
  return canonicalBindingEntity(stripped);
}

function bindingFamilyKey(binding: OperationBinding): string | undefined {
  const entity = bindingEntityKind(binding);
  const valueKind = bindingValueKind(binding);
  if (!entity || !valueKind) return undefined;
  return `${entity}:${valueKind}`;
}

function bindingLeafAliases(binding: OperationBinding): string[] {
  const key = binding.key.toLowerCase();
  const aliases = new Set<string>([key]);
  const entity = bindingEntityKind(binding);
  const valueKind = bindingValueKind(binding);

  if (valueKind === "identifier") {
    aliases.add("id");
    if (entity === "profile") {
      for (const alias of ["user_id", "profile_id", "member_id", "account_id", "public_identifier", "rest_id", "screen_name", "username", "handle"]) {
        aliases.add(alias);
      }
    }
    if (entity === "repository") {
      for (const alias of ["repo_id", "repository_id", "id"]) aliases.add(alias);
    }
    if (entity === "listing") {
      for (const alias of ["listing_id", "item_id", "product_id", "id"]) aliases.add(alias);
    }
    if (entity === "company") {
      for (const alias of ["company_id", "organization_id", "org_id", "id"]) aliases.add(alias);
    }
  }

  if (valueKind === "name") {
    aliases.add("name");
    aliases.add("title");
  }

  if (valueKind === "url") {
    aliases.add("url");
    aliases.add("link");
    aliases.add("canonical_url");
  }

  return [...aliases];
}

function normalizeObservedScalar(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length < 4 && !/^\d+$/.test(trimmed)) return null;
  const lowered = trimmed.toLowerCase();
  if (["true", "false", "null", "undefined", "nan"].includes(lowered)) return null;
  if (/^[a-z_]+$/i.test(trimmed) && trimmed.length < 8) return null;
  return /^\d+$/.test(trimmed) ? trimmed : lowered;
}

function collectBindingObservedValues(
  value: unknown,
  binding: OperationBinding,
  out = new Set<string>(),
  prefix = "",
): Set<string> {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      collectBindingObservedValues(item, binding, out, `${prefix}[]`);
    }
    return out;
  }
  if (typeof value !== "object") {
    const normalized = normalizeObservedScalar(value);
    if (normalized && prefix) {
      const leaf = prefix.replace(/\[\]/g, "").split(".").pop()?.toLowerCase() ?? "";
      if (bindingLeafAliases(binding).includes(leaf)) out.add(normalized);
    }
    return out;
  }

  for (const [key, next] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    const path = prefix ? `${prefix}.${key}` : key;
    collectBindingObservedValues(next, binding, out, path);
  }
  return out;
}

function hasObservedValueOverlap(
  source: SkillOperationNode,
  target: SkillOperationNode,
  provided: OperationBinding,
  required: OperationBinding,
): boolean {
  const sourceValues = collectBindingObservedValues(source.example_response_compact, provided);
  const targetValues = collectBindingObservedValues(target.example_request, required);
  if (sourceValues.size === 0 || targetValues.size === 0) return false;
  for (const value of sourceValues) {
    if (targetValues.has(value)) return true;
  }
  return false;
}

function observedValueMatchConfidence(
  source: SkillOperationNode,
  target: SkillOperationNode,
  provided: OperationBinding,
  required: OperationBinding,
): number {
  if (!hasObservedValueOverlap(source, target, provided, required)) return 0;

  let confidence = 0.72;
  const providedFamily = bindingFamilyKey(provided);
  const requiredFamily = bindingFamilyKey(required);
  if (providedFamily && requiredFamily && providedFamily === requiredFamily) confidence += 0.1;

  const sourceEntity = bindingEntityKind(provided);
  const targetEntity = bindingEntityKind(required);
  if (sourceEntity && targetEntity && sourceEntity === targetEntity) confidence += 0.06;

  if (source.resource_kind === target.resource_kind && source.resource_kind !== "resource") confidence += 0.05;
  if (provided.key === required.key && !isGenericBindingKey(required.key)) confidence += 0.04;

  return Math.min(confidence, 0.88);
}

function potentialBindingMatchConfidence(
  source: SkillOperationNode,
  target: SkillOperationNode,
  provided: OperationBinding,
  required: OperationBinding,
): number {
  const providedFamily = bindingFamilyKey(provided);
  const requiredFamily = bindingFamilyKey(required);
  if (!providedFamily || !requiredFamily || providedFamily !== requiredFamily) return 0;

  const entity = bindingEntityKind(required);
  const valueKind = bindingValueKind(required);
  if (!entity || !valueKind) return 0;
  if (isGenericBindingKey(required.key) && isGenericBindingKey(provided.key)) return 0;

  let confidence = 0.62;
  if (source.resource_kind === target.resource_kind && source.resource_kind !== "resource") confidence += 0.08;
  if (source.resource_kind === entity || target.resource_kind === entity) confidence += 0.05;
  if (source.method === "GET" && target.method === "GET") confidence += 0.03;
  return Math.min(confidence, 0.78);
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
): EndpointSemanticDescriptor {
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
  const descriptionInput = classifyDescriptionInput(endpoint.description);
  const descriptionOut = descriptionInput.source === "agent"
    ? endpoint.description
    : generatedDescription;
  const descriptionIn = requires.length > 0
    ? `Requires ${requires.map((binding) => binding.key).join(", ")}`
    : "No additional inputs required";
  const descriptionSource: "agent" | "auto" | "missing" =
    descriptionInput.source === "agent"
      ? "agent"
      : (descriptionOut ? "auto" : "missing");

  return {
    action_kind: actionKind,
    resource_kind: resourceKind,
    description_in: descriptionIn,
    description_out: descriptionOut,
    description_source: descriptionSource,
    description_needs_review: descriptionSource !== "agent",
    ...(descriptionSource !== "agent"
      ? { description_warning: descriptionInput.warning ?? "Auto-generated description. Review before trusting or publishing." }
      : {}),
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
    auth_required: !!(
      endpoint.auth_tokens?.length ||
      Object.keys(endpoint.headers_template ?? {}).some((h) => /auth|csrf|token|bearer/i.test(h))
    ),
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
): EndpointSemanticDescriptor {
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
    description_source: inferred.description_source || existing?.description_source,
    description_needs_review: inferred.description_needs_review ?? existing?.description_needs_review,
    description_warning: inferred.description_warning || existing?.description_warning,
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
  const normalizedRequires = (() => {
    const byBinding = new Map<string, OperationBinding>();
    for (const binding of semantic.requires ?? []) {
      const pathParamValue = (endpoint.path_params as Record<string, string> | undefined)?.[binding.key];
      const defaultedPathParam =
        binding.source === "path_params" &&
        typeof pathParamValue === "string" && pathParamValue !== "";
      const normalized = defaultedPathParam ? { ...binding, required: false } : binding;
      const id = [normalized.key, normalized.source ?? "", normalized.semantic_type ?? ""].join("|");
      const existing = byBinding.get(id);
      if (!existing) {
        byBinding.set(id, normalized);
        continue;
      }
      byBinding.set(id, {
        ...existing,
        required: existing.required && normalized.required,
      });
    }
    return [...byBinding.values()];
  })();
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
    requires: normalizedRequires,
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
  const intentLower = intent.toLowerCase();
  const intentTokens = tokenize(intent);
  // Include url_template + trigger_url + method so path keywords (e.g. /search,
  // GraphQL op names, REST resource segments) factor into the shortlist score.
  // Without this the shortlist sees only description_out/response_summary which
  // are often empty or generic on cached skills, so noise endpoints (Viewer,
  // GetUserClaims) outrank task-specific ones (SearchTimeline, UserByScreenName).
  const opText = [
    op.method,
    op.url_template,
    op.trigger_url ?? "",
    op.action_kind,
    op.resource_kind,
    op.description_in ?? "",
    op.description_out ?? "",
    op.response_summary ?? "",
    ...(op.example_fields ?? []),
  ].join(" ");
  const opTokens = tokenize(opText);
  const opTextLower = opText.toLowerCase();
  let score = 0;
  for (const token of intentTokens) if (opTokens.includes(singularize(token))) score += 2;

  // === Mirrored heuristics from rankEndpoints (execution/index.ts) ===
  // The shortlist must agree with what selectBestEndpoint will pick at execute
  // time, otherwise the agent sees endpoint A as #1 but execute runs endpoint B.
  const looksLikeApiEndpoint = /\/api\/|graphql|\/rest\/|\/rpc\/|voyager/i.test(op.url_template);
  const urlPath = (() => { try { return new URL(op.url_template).pathname.toLowerCase(); } catch { return op.url_template.toLowerCase(); } })();

  // Search/list/feed + posts/tweets intent → reward search/timeline/feed-style ops
  if (/\b(search|list|find|feed|timeline|stream|home|latest|trending|discover|browse)\b/i.test(intentLower) &&
      /\b(post|posts|tweet|tweets|status|statuses|update|updates|article|articles)\b/i.test(intentLower)) {
    if (looksLikeApiEndpoint && /(search|timeline|feed|stream|result|results|entries|posts|tweets|statuses|updates)/i.test(opTextLower)) {
      score += 18;
    }
    if (/(sidebar|recommend|recommendations|usersbyrestids|userclaims|viewer|spotlight|pinned)/i.test(opTextLower)) {
      score -= 14;
    }
  }

  // "tweets from <handle>" / "posts by <user>" / "<user> profile" → user-timeline pattern.
  // Detect entity-detail intents that imply a per-user feed.
  if (/\b(tweets|posts|statuses|updates)\s+(from|by|of)\b/i.test(intentLower) ||
      /\b(profile|user|member)\b/i.test(intentLower)) {
    if (/(userbyscreenname|userbyresttid|usertweets|userprofile|memberprofile|public_identifier|screen_name|screenname|username)/i.test(opTextLower)) {
      score += 16;
    }
    // Home/main feeds are wrong for per-user intent
    if (/(hometimeline|mainfeed|main_feed|globalnav|launchpad)/i.test(opTextLower)) {
      score -= 10;
    }
  }

  // Auth/identity ops (Viewer, GetUserClaims, csrf, session) — almost never the user-facing answer
  if (/(getuserclaims|^viewer$|\bviewer\b|csrf|sessiontoken|usercredential)/i.test(opTextLower) &&
      !/\b(auth|login|session|token|csrf|whoami|me)\b/i.test(intentLower)) {
    score -= 12;
  }

  // Path-segment keyword bonus — if the URL path contains an intent token, it's a strong signal
  if (urlPath) {
    for (const token of intentTokens) {
      const t = singularize(token);
      if (t.length >= 3 && urlPath.includes(t)) {
        score += 4;
        break;
      }
    }
  }

  // Reward dom_extraction for list intents on pages without API capture
  if (/\b(list|search|find|browse|trending|latest)\b/i.test(intentLower) && /\bsearch\b|\btrending\b|\bdiscover\b/i.test(urlPath)) {
    score += 4;
  }

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
  // A9/A11 — telemetry-event patterns with `_` separator (log_event, track_event,
  // page_view, app_open_times, etc.) that don't match \b...\b due to `_` being
  // a word char.
  if (/\/(log[-_]?events?|track[-_]?events?|click[-_]?events?|page[-_]?views?|impressions?|user[-_]?actions?|client[-_]?logs?|error[-_]?logs?|stats[-_]?events?)\b/i.test(text)) return true;
  if (/\/(app[-_]?open[-_]?times?|app[-_]?launch[-_]?times?|session[-_]?times?|usage[-_]?stats?)\b/i.test(text)) return true;
  if (/\/(eligibility|feature[-_]?gates?|feature[-_]?config|ab[-_]?tests?|experiments?[-_]?state)\b/i.test(text)) return true;
  if (/\/(global[-_]?footer|global[-_]?header|page[-_]?chrome|nav[-_]?config|footer[-_]?config|header[-_]?config)\b/i.test(text)) return true;
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

function parseObservedTime(value?: string): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    return trimmed.length <= 10 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(trimmed).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isBefore(lhs?: string, rhs?: string): boolean {
  const left = parseObservedTime(lhs);
  const right = parseObservedTime(rhs);
  if (left == null || right == null) return true;
  return left <= right;
}

export function buildSkillOperationGraph(endpoints: EndpointDescriptor[]): SkillOperationGraph {
  const operations = endpoints.map(buildOperationNode);
  const edges: SkillOperationEdge[] = [];
  const seenEdges = new Set<string>();
  for (const target of operations) {
    for (const required of target.requires) {
      for (const source of operations) {
        if (source.operation_id === target.operation_id && !isPaginationBindingKey(required.key)) continue;
        const directMatch = source.provides.find((provided) => {
          const exactKeyMatch = provided.key === required.key && !isGenericBindingKey(required.key);
          const semanticMatch =
            !!provided.semantic_type &&
            !!required.semantic_type &&
            provided.semantic_type === required.semantic_type &&
            !isGenericSemanticType(required.semantic_type);
          const paginationSelfMatch =
            source.operation_id === target.operation_id &&
            provided.key === required.key &&
            isPaginationBindingKey(required.key);
          return exactKeyMatch || semanticMatch || paginationSelfMatch;
        });
        if (source.operation_id !== target.operation_id && !isBefore(source.observed_at, target.observed_at)) continue;
        const potentialMatch = !directMatch
          ? source.provides
            .map((provided) => ({
              provided,
              confidence: potentialBindingMatchConfidence(source, target, provided, required),
            }))
            .filter((candidate) => candidate.confidence > 0)
            .sort((a, b) => b.confidence - a.confidence)[0]
          : undefined;
        const observedValueMatch = source.provides
          .map((provided) => ({
            provided,
            confidence: observedValueMatchConfidence(source, target, provided, required),
          }))
          .filter((candidate) => candidate.confidence > 0)
          .sort((a, b) => b.confidence - a.confidence)[0];
        const match = directMatch ?? observedValueMatch?.provided ?? potentialMatch?.provided;
        if (!match) continue;
        const edgeId = `${source.operation_id}:${target.operation_id}:${required.key}`;
        if (seenEdges.has(edgeId)) continue;
        seenEdges.add(edgeId);
        const exactMatch = match.key === required.key;
        const corroboratedHintConfidence =
          observedValueMatch && (!directMatch || observedValueMatch.provided.key === directMatch.key)
            ? observedValueMatch.confidence
            : 0;
        edges.push({
          edge_id: edgeId,
          from_operation_id: source.operation_id,
          to_operation_id: target.operation_id,
          binding_key: required.key,
          kind: directMatch
            ? (exactMatch ? classifyEdgeKind(source, target, required.key) : "hint")
            : "hint",
          confidence: directMatch
            ? (exactMatch ? 0.9 : Math.max(0.6, corroboratedHintConfidence))
            : (observedValueMatch?.confidence ?? potentialMatch?.confidence ?? 0.6),
        });
      }
    }
  }

  // Operations that are targets of dependency edges are not entry points
  const dependencyTargets = new Set(
    edges.filter((e) => e.kind === "dependency").map((e) => e.to_operation_id),
  );
  const entryOperationIds = operations
    .filter(
      (operation) =>
        !dependencyTargets.has(operation.operation_id) &&
        (operation.requires.length === 0 ||
          operation.requires.every(
            (binding) => binding.source === "query" || binding.source === "path_params",
          )),
    )
    .map((operation) => operation.operation_id);

  return {
    generated_at: new Date().toISOString(),
    entry_operation_ids: entryOperationIds,
    operations,
    edges,
  };
}

export function ensureSkillOperationGraph(skill: SkillManifest): SkillOperationGraph {
  if (skill.operation_graph?.operations?.length) {
    // Rebuild if stored graph is stale (doesn't cover all endpoints)
    const graphOpIds = new Set(skill.operation_graph.operations.map((op) => op.operation_id));
    const allCovered = skill.endpoints.every((ep) => graphOpIds.has(ep.endpoint_id));
    if (allCovered) return skill.operation_graph;
  }
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

export function isRunnable(operation: SkillOperationNode, bindings: Record<string, unknown>): boolean {
  return operation.requires.every((binding) => {
    if (!binding.required) return true;
    const value = bindings[binding.key];
    return value != null && value !== "";
  });
}

function isPrefetchableEdgeKind(kind: SkillOperationEdge["kind"]): boolean {
  return kind === "dependency" || kind === "parent_child" || kind === "pagination";
}

function buildEffectiveBindings(
  operation: SkillOperationNode,
  knownBindings: Record<string, unknown>,
): Record<string, unknown> {
  const effectiveBindings: Record<string, unknown> = { ...knownBindings };
  for (const binding of operation.provides) {
    if (effectiveBindings[binding.key] == null) {
      effectiveBindings[binding.key] = binding.example_value ?? `__from_${operation.operation_id}__`;
    }
  }
  return effectiveBindings;
}

export function getOperationPrefetchTargets(
  graph: SkillOperationGraph,
  resolvedOperationId: string,
  knownBindings: Record<string, unknown>,
  limit = 3,
): Array<{
  operation: SkillOperationNode;
  edge: SkillOperationEdge;
  reason: string;
}> {
  const resolvedOperation = graph.operations.find((operation) => operation.operation_id === resolvedOperationId);
  if (!resolvedOperation) return [];

  const effectiveBindings = buildEffectiveBindings(resolvedOperation, knownBindings);
  const candidates: Array<{
    operation: SkillOperationNode;
    edge: SkillOperationEdge;
    reason: string;
  }> = [];

  for (const edge of graph.edges) {
    if (edge.from_operation_id !== resolvedOperationId) continue;
    if (!isPrefetchableEdgeKind(edge.kind)) continue;

    const targetOperation = graph.operations.find((operation) => operation.operation_id === edge.to_operation_id);
    if (!targetOperation) continue;
    if (targetOperation.method !== "GET") continue;
    if (!isRunnable(targetOperation, effectiveBindings)) continue;

    candidates.push({
      operation: targetOperation,
      edge,
      reason: `${resolvedOperation.action_kind} ${resolvedOperation.resource_kind} -> ${targetOperation.action_kind} ${targetOperation.resource_kind} via ${edge.binding_key}`,
    });
  }

  return candidates
    .sort((a, b) => b.edge.confidence - a.edge.confidence)
    .slice(0, Math.max(0, limit));
}

/**
 * Compute the set of reachable operation IDs given current known bindings.
 *
 * An operation is reachable (A_reachable) if:
 *   1. It has no required bindings (entry point), OR
 *   2. All its required bindings are present in knownBindings, OR
 *   3. All its required bindings can be transitively satisfied — either
 *      directly from knownBindings or from the provides of another
 *      reachable operation.
 *
 * Uses a fixpoint computation: starts with directly-runnable operations,
 * then iteratively adds operations whose requirements are met by the
 * accumulated provides of the reachable set, until no new operations
 * are added.
 */
export function computeReachableEndpoints(
  graph: SkillOperationGraph,
  knownBindings: Record<string, unknown>,
): Set<string> {
  const reachable = new Set<string>();
  if (!graph.operations || graph.operations.length === 0) return reachable;

  // Seed: operations that are directly runnable with current bindings
  for (const op of graph.operations) {
    if (isRunnable(op, knownBindings)) {
      reachable.add(op.operation_id);
    }
  }

  // Fixpoint expansion: iterate until stable
  let changed = true;
  while (changed) {
    changed = false;
    // Collect all binding keys provided by currently reachable operations
    const availableKeys = new Set<string>(Object.keys(knownBindings));
    for (const op of graph.operations) {
      if (!reachable.has(op.operation_id)) continue;
      for (const provided of op.provides) {
        availableKeys.add(provided.key);
      }
    }

    // Check each non-reachable operation
    for (const op of graph.operations) {
      if (reachable.has(op.operation_id)) continue;
      const allSatisfied = op.requires.every((binding) => {
        if (!binding.required) return true;
        // Check direct bindings first
        const directValue = knownBindings[binding.key];
        if (directValue != null && directValue !== "") return true;
        // Check if any reachable operation provides this key
        return availableKeys.has(binding.key);
      });
      if (allSatisfied) {
        reachable.add(op.operation_id);
        changed = true;
      }
    }
  }

  return reachable;
}

export function getSkillChunk(
  skill: SkillManifest,
  opts?: {
    intent?: string;
    seed_operation_id?: string;
    known_bindings?: Record<string, unknown>;
    max_operations?: number;
    include_full_relevant_graph?: boolean;
  },
): SkillChunk {
  const graph = ensureSkillOperationGraph(skill);
  const known = opts?.known_bindings ?? {};
  const filtered = graph.operations.filter((operation) => !isOperationHardExcluded(operation, opts?.intent));
  const candidateOps = filtered.length > 0 ? filtered : graph.operations;
  const maxOperations = opts?.include_full_relevant_graph
    ? Math.max(1, candidateOps.length)
    : (opts?.max_operations ?? 6);
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
  // D4 fix — dedupe operations by (method, url_template). Two captures of the
  // same GraphQL POST (e.g. x.com HomeTimeline) get separate operation_ids
  // but share URL+method; the marketplace publish gate's family-dedup
  // doesn't apply at resolve-time chunk construction, so duplicates were
  // surfacing in available_operations. Keep the higher-scored copy.
  // Caught via harness/recursive/ on x.com.
  const _filtered = graph.operations.filter((operation) => seen.has(operation.operation_id) && !isOperationHardExcluded(operation, opts?.intent));
  const _byKey = new Map<string, SkillOperationNode>();
  for (const op of _filtered) {
    const key = `${op.method}|${op.url_template ?? ""}`;
    const existing = _byKey.get(key);
    if (!existing || operationScore(op, opts?.intent) > operationScore(existing, opts?.intent)) {
      _byKey.set(key, op);
    }
  }
  const operations = Array.from(_byKey.values());
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

function toAgentPrefetchOperation(
  target: { operation: SkillOperationNode; edge: SkillOperationEdge; reason: string },
): AgentPrefetchOperation {
  return {
    operation_id: target.operation.operation_id,
    endpoint_id: target.operation.endpoint_id,
    method: target.operation.method,
    action_kind: target.operation.action_kind,
    resource_kind: target.operation.resource_kind,
    reason: target.reason,
    binding_key: target.edge.binding_key,
    edge_kind: target.edge.kind,
    confidence: target.edge.confidence,
  };
}

export function toAgentWorkflowDagView(
  chunk: SkillChunk,
  graph: SkillOperationGraph,
  knownBindings: Record<string, unknown> = {},
): AgentWorkflowDagView {
  const runnableOperationIds = new Set(chunk.available_operation_ids);
  const operations: AgentWorkflowDagOperation[] = chunk.operations.map((operation) => ({
    operation_id: operation.operation_id,
    endpoint_id: operation.endpoint_id,
    method: operation.method,
    action_kind: operation.action_kind,
    resource_kind: operation.resource_kind,
    title: readableOperationTitle(operation),
    url_template: operation.url_template,
    description_out: operation.description_out,
    requires: summarizeBindingKeys(operation.requires),
    yields: summarizeBindingKeys(operation.provides),
    // C7 fix — when an operation has no required bindings AND its
    // url_template has no unresolved {param} slots, the URL itself IS the
    // operation. Mark it runnable even if isOperationHardExcluded
    // (computed against the FULL graph) excluded it from the chunk's
    // available_operation_ids. Real-world friction: walmart.com homepage
    // SSR payload was reaching the agent as runnable:false despite being
    // directly executable (verified by `unbrowse execute --raw`).
    runnable:
      runnableOperationIds.has(operation.operation_id) ||
      (isRunnable(operation, knownBindings) &&
        !/\{[^}]+\}/.test(operation.url_template ?? "")),
    prefetch_get_operations: getOperationPrefetchTargets(graph, operation.operation_id, knownBindings)
      .filter((target) => chunk.operations.some((candidate) => candidate.operation_id === target.operation.operation_id))
      .map(toAgentPrefetchOperation),
  }));

  return {
    skill_id: chunk.skill_id,
    intent: chunk.intent,
    missing_bindings: chunk.missing_bindings,
    suggested_next_operation_id: chunk.available_operation_ids[0],
    operations,
    edges: chunk.edges.map((edge) => ({
      edge_id: edge.edge_id,
      from_operation_id: edge.from_operation_id,
      to_operation_id: edge.to_operation_id,
      binding_key: edge.binding_key,
      kind: edge.kind,
      confidence: edge.confidence,
    })),
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
