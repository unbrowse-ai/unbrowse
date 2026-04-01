import { buildSkillOperationGraph } from "../graph/index.js";
import { validateManifest, publishSkill, cachePublishedSkill, publishGraphEdges } from "../client/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
import {
  writeSkillSnapshot,
  domainSkillCache,
  persistDomainCache,
  getDomainReuseKey,
  scopedCacheKey,
  snapshotPathForCacheKey,
  generateLocalDescription,
} from "../orchestrator/index.js";
import { getRegistrableDomain } from "../domain.js";
import type { SkillManifest, EndpointDescriptor } from "../types/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const UNBROWSE_CONFIG_PATH = join(homedir(), ".unbrowse", "config.json");

/** Read agent_id from local config — used for contributor attribution on publish. */
function getLocalAgentId(): string | undefined {
  try {
    const config = JSON.parse(readFileSync(UNBROWSE_CONFIG_PATH, "utf-8"));
    return config.agent_id ?? undefined;
  } catch {
    return undefined;
  }
}
/**
 * Strip PII and user-specific data from endpoints before publishing to marketplace.
 * Keeps: URL templates, method, schema structure, semantic metadata (action/resource kinds,
 *        requires/provides, field paths, descriptions).
 * Strips: example response data, actual query values, sample URLs with query params,
 *         request bodies, header values.
 */
/**
 * Strip PII and user-specific data from endpoints before publishing to marketplace.
 * Deterministic baseline — the agent sanitizer builds on top of this.
 */
// Patterns that identify secret/token values regardless of field name
const SECRET_VALUE_PATTERNS = [
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,       // JWT tokens
  /^Bearer\s+\S+/i,                                       // Bearer tokens
  /^Basic\s+[A-Za-z0-9+/=]+/i,                           // Basic auth
  /^ghp_[A-Za-z0-9]{36}/,                                // GitHub PAT
  /^sk-[A-Za-z0-9]{20,}/,                                // OpenAI/Stripe secret keys
  /^pk_(live|test)_[A-Za-z0-9]+/,                        // Stripe publishable keys
  /^xox[bsrp]-[A-Za-z0-9-]+/,                           // Slack tokens
  /^AKIA[A-Z0-9]{16}/,                                   // AWS access key
  /^[A-Za-z0-9+/]{40,}={0,2}$/,                         // Base64 encoded secrets (long)
  /^v2\.[A-Za-z0-9_-]{20,}/,                             // Various API v2 tokens
];

// Field name patterns that indicate the value is a secret
const SECRET_KEY_PATTERNS = /^(api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|password|passwd|session[_-]?id|session[_-]?token|csrf[_-]?token|client[_-]?secret|bearer|refresh[_-]?token|id[_-]?token|jwt|nonce|otp|pin|ssn|credit[_-]?card)$/i;

/**
 * Returns true if a value looks like a secret/token/credential.
 */
export function looksLikeSecret(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length < 8) return false;
  if (SECRET_KEY_PATTERNS.test(key)) return true;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Recursively walk an object and replace secret-looking values with "[REDACTED]".
 * Returns a new object — does not mutate the input.
 */
export function redactSecrets(obj: unknown, parentKey = ""): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return looksLikeSecret(parentKey, obj) ? "[REDACTED]" : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item, i) => redactSecrets(item, parentKey));
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = redactSecrets(v, k);
    }
    return result;
  }
  return obj;
}

/**
 * Strip PII and user-specific data from endpoints before publishing to marketplace.
 * Deterministic baseline — the agent sanitizer builds on top of this.
 *
 * Layer 1: Redact secrets (tokens, keys, JWTs) from ALL string values
 * Layer 2: Strip example responses, query defaults, sample URLs
 */
/**
 * Synthesize a plausible placeholder value for a given real value.
 * Preserves type and rough shape so agents can understand the endpoint.
 */
function synthesizePlaceholder(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return Number.isInteger(value) ? 12345 : 99.99;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (looksLikeSecret(key, value)) return "[REDACTED]";
    // Email-like
    if (/@/.test(value)) return "user@example.com";
    // URL-like
    if (/^https?:\/\//.test(value)) return "https://example.com/item/123";
    // UUID-like
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(value)) return "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    // Numeric string
    if (/^\d+$/.test(value)) return "12345";
    // Date-like
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "2026-01-15T00:00:00Z";
    // Short identifier
    if (value.length <= 8) return "abc123";
    // General text — return a generic of similar length
    if (value.length > 100) return "Example description text for this item.";
    return "example-value";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? [synthesizeExample(value[0], 0)] : [];
  }
  if (typeof value === "object") {
    return synthesizeExample(value, 0);
  }
  return value;
}

/**
 * Recursively synthesize a structurally similar example with placeholder values.
 * Keeps keys and types, replaces actual data with generic equivalents.
 */
export function synthesizeExample(obj: unknown, depth = 0): unknown {
  if (depth > 5) return null; // prevent infinite recursion
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return synthesizePlaceholder("", obj);
  if (Array.isArray(obj)) {
    // Keep at most 2 items to show the shape
    return obj.slice(0, 2).map((item) => synthesizeExample(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = typeof v === "object" && v !== null
      ? synthesizeExample(v, depth + 1)
      : synthesizePlaceholder(k, v);
  }
  return result;
}

/**
 * Strip PII and user-specific data from endpoints before publishing to marketplace.
 * Replaces real data with structurally similar synthetic examples so agents
 * can still understand the endpoint shape.
 *
 * Layer 1: Redact secrets (tokens, keys, JWTs) from ALL string values
 * Layer 2: Synthesize placeholder examples, sanitize query defaults
 */
export function sanitizeForPublish(endpoints: EndpointDescriptor[]): EndpointDescriptor[] {
  return endpoints.map((ep) => {
    const clean = { ...ep };

    // Layer 1: Redact any secret values in headers, query, body
    if (clean.headers_template) {
      clean.headers_template = redactSecrets(clean.headers_template) as Record<string, string>;
    }
    if (clean.query) {
      clean.query = redactSecrets(clean.query) as Record<string, unknown>;
    }
    if (clean.body) {
      clean.body = redactSecrets(clean.body) as Record<string, unknown>;
    }

    // Layer 2: Replace query defaults with generic placeholders
    if (clean.query) {
      clean.query = Object.fromEntries(
        Object.entries(clean.query).map(([k, v]) => [k, typeof v === "string" ? "example" : v]),
      );
    }

    // Replace path_params with generic placeholders
    if (clean.path_params) {
      clean.path_params = Object.fromEntries(
        Object.keys(clean.path_params).map((k) => [k, "example"]),
      );
    }

    // Synthesize body example (keep structure, replace values)
    if (clean.body) clean.body = synthesizeExample(clean.body) as Record<string, unknown>;
    if (clean.body_params) clean.body_params = synthesizeExample(clean.body_params) as Record<string, unknown>;

    // Strip header values — keep keys only (headers are not useful as examples)
    if (clean.headers_template) {
      clean.headers_template = Object.fromEntries(
        Object.keys(clean.headers_template).map((k) => [k, ""]),
      );
    }

    // Strip trigger_url query params (keep origin + path)
    if (clean.trigger_url) {
      try {
        const u = new URL(clean.trigger_url);
        clean.trigger_url = u.origin + u.pathname;
      } catch { /* keep as-is if unparseable */ }
    }

    // Sanitize semantic descriptor — synthesize examples instead of deleting
    if (clean.semantic) {
      const sem = { ...clean.semantic };

      // Synthesize structurally similar examples
      if (sem.example_response_compact) {
        sem.example_response_compact = synthesizeExample(sem.example_response_compact);
      }
      if (sem.example_request) {
        sem.example_request = synthesizeExample(sem.example_request);
      }

      // Replace sample URL query params with placeholders
      if (sem.sample_request_url) {
        try {
          const u = new URL(sem.sample_request_url);
          for (const key of u.searchParams.keys()) {
            u.searchParams.set(key, "example");
          }
          sem.sample_request_url = u.toString();
        } catch { delete sem.sample_request_url; }
      }

      // Strip example_value from bindings (these are real captured values)
      if (sem.requires) {
        sem.requires = sem.requires.map((b) => {
          const { example_value: _, ...rest } = b;
          return rest;
        });
      }
      if (sem.provides) {
        sem.provides = sem.provides.map((b) => {
          const { example_value: _, ...rest } = b;
          return rest;
        });
      }

      clean.semantic = sem;
    }

    return clean;
  });
}

const SANITIZE_SYSTEM = `You are an API reverse-engineering agent. You receive captured API endpoint metadata
and must produce clean, publishable data for a shared API registry.

Your job:
1. Write a clear, one-line description for each endpoint (what it does, not implementation details)
2. Classify each endpoint: action_kind (search/detail/create/update/delete/list) and resource_kind (what entity)
3. Generate a realistic synthetic example_response that matches the endpoint's schema — use plausible but fake data that helps agents understand the response shape. For example:
   - A music search endpoint should have fake song names, artist names, durations
   - A product search should have fake product names, prices, categories
   - A user profile should have fake usernames, bios, join dates
   The examples should look real enough to be useful documentation, but contain zero actual user data.
4. Generate a synthetic example_request with plausible parameter values for the domain.
5. Flag any PII or user-specific data you spot in the input.
6. Return ONLY the JSON structure requested — no explanation.

NEVER copy actual data from the input. Generate fresh plausible values appropriate to the domain.`;

interface AgentSanitizeResult {
  endpoints: Array<{
    endpoint_id: string;
    description: string;
    action_kind: string;
    resource_kind: string;
    example_request?: Record<string, unknown>;
    example_response?: unknown;
    pii_flagged: boolean;
    pii_fields?: string[];
  }>;
}

/**
 * Agent-based endpoint review — sends endpoint shapes to an LLM for
 * description generation, PII scrubbing, and synthetic example creation.
 * Falls back to the deterministic sanitizer if no LLM provider is configured.
 */
/**
 * Agent-based endpoint review — sends endpoint shapes to an LLM for
 * description generation, PII scrubbing, and synthetic example creation.
 * Falls back to the deterministic sanitizer if no LLM provider is configured.
 */
export async function agentSanitizeEndpoints(
  endpoints: EndpointDescriptor[],
  domain: string,
  intents?: string[],
): Promise<EndpointDescriptor[]> {
  // Always apply deterministic sanitization first (redacts secrets, strips real values)
  const cleaned = sanitizeForPublish(endpoints);

  // Build a compact view for the agent — includes field paths and schema, no real data
  const agentInput = cleaned.map((ep) => ({
    endpoint_id: ep.endpoint_id,
    method: ep.method,
    url_template: ep.url_template,
    query_keys: ep.query ? Object.keys(ep.query) : [],
    response_fields: ep.semantic?.example_fields ?? [],
    response_summary: ep.semantic?.response_summary,
    current_description: ep.description,
    current_action_kind: ep.semantic?.action_kind,
    current_resource_kind: ep.semantic?.resource_kind,
  }));

  const intentContext = intents?.length
    ? `\nOriginal user intents that discovered these endpoints: ${JSON.stringify(intents)}\nUse these intents to write descriptions that help other agents find this endpoint for similar tasks.`
    : "";

  const userPrompt = `Domain: ${domain}${intentContext}
Endpoints:
${JSON.stringify(agentInput, null, 2)}

Return JSON: { "endpoints": [{ "endpoint_id": "...", "description": "...", "action_kind": "...", "resource_kind": "...", "example_request": {...}, "example_response": {...}, "pii_flagged": false }] }

Generate realistic synthetic data appropriate for ${domain}. The descriptions should help agents match this endpoint to user intents like: ${intents?.join(", ") ?? "general queries"}.`;

  try {
    const result = await callSanitizeAgent(userPrompt);
    if (!result?.endpoints?.length) return cleaned;

    // Merge agent output back into sanitized endpoints
    const agentMap = new Map(result.endpoints.map((e) => [e.endpoint_id, e]));
    return cleaned.map((ep) => {
      const reviewed = agentMap.get(ep.endpoint_id);
      if (!reviewed) return ep;

      if (reviewed.pii_flagged) {
        console.warn(`[agent-sanitize] PII flagged on ${ep.endpoint_id}: ${reviewed.pii_fields?.join(", ")}`);
      }

      return {
        ...ep,
        description: reviewed.description || ep.description,
        semantic: ep.semantic ? {
          ...ep.semantic,
          action_kind: reviewed.action_kind || ep.semantic.action_kind,
          resource_kind: reviewed.resource_kind || ep.semantic.resource_kind,
          description_out: reviewed.description || ep.semantic.description_out,
          // Agent-generated synthetic examples replace deterministic placeholders
          ...(reviewed.example_response ? { example_response_compact: reviewed.example_response } : {}),
          ...(reviewed.example_request ? { example_request: reviewed.example_request } : {}),
        } : ep.semantic,
      };
    });
  } catch (err) {
    console.warn(`[agent-sanitize] failed, using deterministic fallback: ${(err as Error).message}`);
    return cleaned;
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const NEBIUS_API_KEY = process.env.NEBIUS_API_KEY ?? "";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const NEBIUS_CHAT_URL = "https://api.studio.nebius.com/v1/chat/completions";
const SANITIZE_MODEL = "gpt-4o-mini";

async function callSanitizeAgent(userPrompt: string): Promise<AgentSanitizeResult | null> {
  const providers = [
    OPENAI_API_KEY ? { url: OPENAI_CHAT_URL, key: OPENAI_API_KEY, model: SANITIZE_MODEL } : null,
    NEBIUS_API_KEY ? { url: NEBIUS_CHAT_URL, key: NEBIUS_API_KEY, model: SANITIZE_MODEL } : null,
  ].filter((p): p is { url: string; key: string; model: string } => !!p);
  if (providers.length === 0) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for (const provider of providers) {
      const res = await fetch(provider.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${provider.key}`,
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: 0,
          max_tokens: 2000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SANITIZE_SYSTEM },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content;
      if (!content) continue;
      return JSON.parse(content) as AgentSanitizeResult;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}


const SKILL_SNAPSHOT_DIR = join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");

/**
 * Find existing domain snapshots and merge incoming endpoints into them.
 * Returns a merged skill with all endpoints from both existing snapshots
 * and the incoming skill, or null if no existing snapshot found.
 */
export function findAndMergeDomainSnapshot(
  snapshotDir: string,
  domain: string,
  incoming: SkillManifest,
): SkillManifest | null {
  if (!existsSync(snapshotDir)) return null;
  const targetDomain = getRegistrableDomain(domain);

  let bestExisting: SkillManifest | null = null;
  let bestEndpointCount = 0;

  for (const entry of readdirSync(snapshotDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const candidate = JSON.parse(readFileSync(join(snapshotDir, entry), "utf-8")) as SkillManifest;
      if (getRegistrableDomain(candidate.domain) !== targetDomain) continue;
      if (candidate.execution_type !== "http") continue;
      const epCount = candidate.endpoints?.length ?? 0;
      if (epCount > bestEndpointCount) {
        bestExisting = candidate;
        bestEndpointCount = epCount;
      }
    } catch { /* skip corrupt */ }
  }

  if (!bestExisting) return null;

  const merged = mergeEndpoints(bestExisting.endpoints, incoming.endpoints);
  if (merged.length <= bestEndpointCount) return null; // no new endpoints to add

  return {
    ...bestExisting,
    endpoints: merged,
    intents: Array.from(new Set([
      ...(bestExisting.intents ?? []),
      ...(incoming.intents ?? []),
      incoming.intent_signature,
    ])),
    updated_at: new Date().toISOString(),
  };
}
const indexInFlight = new Map<string, Promise<void>>();

export interface BackgroundIndexJob {
  skill: SkillManifest;
  domain: string;
  intent: string;
  contextUrl?: string;
  clientScope?: string;
  cacheKey: string;
}

/**
 * Queue a skill for background processing: graph building, marketplace
 * validation, and publishing. Non-blocking — returns immediately.
 * Per-domain dedup: only one job per domain runs at a time.
 */
export function queueBackgroundIndex(job: BackgroundIndexJob): void {
  const key = job.domain;
  if (indexInFlight.has(key)) {
    console.log(`[background-index] skipped for ${key}: already in flight`);
    return;
  }

  const work = processIndexJob(job)
    .catch(err =>
      console.error(`[background-index] failed for ${key}: ${(err as Error).message}`)
    )
    .finally(() => indexInFlight.delete(key));

  indexInFlight.set(key, work);
  console.log(`[background-index] queued for ${key}`);
}

async function processIndexJob(job: BackgroundIndexJob): Promise<void> {
  let { skill, domain, clientScope } = job;
  const scope = clientScope ?? "global";
  const scopedKey = scopedCacheKey(scope, job.cacheKey);

  // 0. Merge with existing domain snapshot (accumulate endpoints across captures)
  const merged = findAndMergeDomainSnapshot(SKILL_SNAPSHOT_DIR, domain, skill);
  if (merged) {
    console.log(`[background-index] merged ${skill.endpoints.length} new endpoint(s) into existing ${merged.endpoints.length - skill.endpoints.length} for ${domain}`);
    skill = merged;
  }

  // 1. Build operation graph from ALL accumulated endpoints
  skill.operation_graph = buildSkillOperationGraph(skill.endpoints);

  // 2. Generate local descriptions for BM25 ranking
  for (const ep of skill.endpoints) {
    if (!ep.description) {
      ep.description = generateLocalDescription(ep);
    }
  }

  // 3. Update local snapshot with merged skill + graph + descriptions

  // 4. Sanitize + validate + publish to marketplace (remote, ~1.5s total)
  const publishable = skill.endpoints.filter(ep => ep.method !== "WS");
  if (publishable.length === 0) {
    console.log(`[background-index] no publishable endpoints for ${domain}`);
    return;
  }

  // Falls back to deterministic stripping if no LLM provider is available.
  const intents = Array.from(new Set([job.intent, ...(skill.intents ?? []), skill.intent_signature].filter(Boolean)));
  const sanitized = await agentSanitizeEndpoints(publishable, domain, intents);

  const { operation_graph: _g, ...base } = skill;
  const draft: SkillManifest = { ...base, endpoints: sanitized, indexer_id: getLocalAgentId() };
  const validation = await validateManifest({ ...draft, skill_id: "__validate__" });
  if (!validation.valid) {
    console.warn(
      `[background-index] validation failed for ${domain}: ${validation.hardErrors.join("; ")}`
    );
    return;
  }

  const publishStart = Date.now();
  const published = await publishSkill(draft);
  const publishMs = Date.now() - publishStart;
  console.log(`[background-index] publish latency: ${publishMs}ms for ${domain}`);

  const publishedSkill: SkillManifest = {
    ...published,
    endpoints: skill.endpoints,
    operation_graph: skill.operation_graph,
    ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
  };

  // 5. Update caches with published version (has backend descriptions)
  cachePublishedSkill(publishedSkill, clientScope);
  writeSkillSnapshot(scopedKey, publishedSkill);

  // 6. Publish graph edges via dedicated endpoint (fire-and-forget)
  if (skill.operation_graph?.operations) {
    for (const op of skill.operation_graph.operations) {
      const opEdges = (skill.operation_graph.edges ?? [])
        .filter(e => e.from_operation_id === op.operation_id)
        .map(e => ({
          target_endpoint_id: skill.operation_graph!.operations.find(
            t => t.operation_id === e.to_operation_id
          )?.endpoint_id ?? e.to_operation_id,
          kind: e.kind,
          confidence: e.confidence,
        }));
      if (opEdges.length > 0) {
        publishGraphEdges(domain, {
          endpoint_id: op.endpoint_id,
          method: op.method,
          url_template: op.url_template,
        }, opEdges).catch(() => {});
      }
    }
  }

  // 7. Update domain cache so cross-intent reuse works
  const domainKey = getDomainReuseKey(job.contextUrl ?? domain);
  if (domainKey) {
    domainSkillCache.set(domainKey, {
      skillId: publishedSkill.skill_id,
      localSkillPath: snapshotPathForCacheKey(scopedKey),
      ts: Date.now(),
    });
    persistDomainCache();
  }

  console.log(`[background-index] completed for ${domain} -> ${published.skill_id}`);
}

/** Check if a domain has an indexing job running. */
export function isIndexingInFlight(domain: string): boolean {
  return indexInFlight.has(domain);
}

/** Await all in-flight background index jobs. Call before process exit. */
export async function drainPendingIndexJobs(): Promise<void> {
  const pending = [...indexInFlight.values()];
  if (pending.length === 0) return;
  console.log(`[background-index] draining ${pending.length} pending job(s)...`);
  await Promise.allSettled(pending);
  console.log(`[background-index] all jobs drained`);
}

export function resetIndexQueueForTests(): void {
  indexInFlight.clear();
}
