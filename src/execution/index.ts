import { executeInBrowser } from "../capture/index.js";
import { captureSession } from "../capture/index.js";
import { extractEndpoints } from "../reverse-engineer/index.js";
import { publishSkill } from "../marketplace/index.js";
import { updateEndpointScore } from "../marketplace/index.js";
import { getCredential, storeCredential, deleteCredential } from "../vault/index.js";
import { getStoredAuth } from "../auth/index.js";
import { applyProjection } from "../transform/index.js";
import { detectSchemaDrift } from "../transform/drift.js";
import { recordExecution } from "../client/index.js";
import { validateManifest } from "../client/index.js";
import { withRetry, isRetryableStatus } from "./retry.js";
import type { EndpointDescriptor, ExecutionOptions, ExecutionTrace, ProjectionOptions, SkillManifest } from "../types/index.js";
import { nanoid } from "nanoid";
import { getRegistrableDomain } from "../domain.js";
import { extractFromDOM } from "../extraction/index.js";

export interface ExecutionResult {
  trace: ExecutionTrace;
  result: unknown;
  learned_skill?: SkillManifest;
}

export async function executeSkill(
  skill: SkillManifest,
  params: Record<string, unknown> = {},
  projection?: ProjectionOptions,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  if (skill.execution_type === "browser-capture") {
    return executeBrowserCapture(skill, params);
  }

  // Allow targeting a specific endpoint by ID
  if (params.endpoint_id) {
    const target = skill.endpoints.find((e) => e.endpoint_id === params.endpoint_id);
    if (target) {
      const { endpoint_id: _, ...cleanParams } = params;
      return executeEndpoint(skill, target, cleanParams, projection, options);
    }
  }

  // BUG-004/007 fix: select endpoint by schema richness + intent relevance
  const endpoint = selectBestEndpoint(skill.endpoints, skill.intent_signature, skill.domain);
  return executeEndpoint(skill, endpoint, params, projection, options);
}

async function executeBrowserCapture(
  skill: SkillManifest,
  params: Record<string, unknown>
): Promise<ExecutionResult> {
  const url = String(params.url ?? "");
  const intent = String(params.intent ?? skill.intent_signature);
  if (!url) throw new Error("browser-capture skill requires params.url");

  const startedAt = new Date().toISOString();
  const traceId = nanoid();
  const targetDomain = new URL(url).hostname;

  // BUG-002/003 fix: auto-load vault cookies for the target domain
  let authHeaders = params.auth_headers as Record<string, string> | undefined;
  let cookies = params.cookies as Array<{ name: string; value: string; domain: string }> | undefined;

  // Check vault for stored auth (from prior interactiveLogin)
  if (!cookies || cookies.length === 0) {
    const vaultCookies = await getStoredAuth(targetDomain);
    if (vaultCookies && vaultCookies.length > 0) {
      cookies = vaultCookies;
    }
    // Also try parent domain (e.g. mail.google.com → google.com)
    if (!cookies || cookies.length === 0) {
      const parts = targetDomain.split(".");
      if (parts.length > 2) {
        const parentDomain = getRegistrableDomain(targetDomain);
        const parentCookies = await getStoredAuth(parentDomain);
        if (parentCookies && parentCookies.length > 0) {
          cookies = parentCookies;
        }
      }
    }
  }
  const captured = await captureSession(url, authHeaders, cookies);

  const finalDomain = (() => {
    try { return new URL(captured.final_url).hostname; } catch { return targetDomain; }
  })();
  const AUTH_PROVIDERS = /accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|appleid\.apple\.com|github\.com|facebook\.com/i;
  const LOGIN_PATHS = /\/(login|signin|sign-in|sso|auth|uas\/login|checkpoint|oauth)/i;

  const redirectedToAuth = finalDomain !== targetDomain && AUTH_PROVIDERS.test(finalDomain);
  const redirectedToLogin = captured.final_url !== url && LOGIN_PATHS.test(new URL(captured.final_url).pathname);

  if (redirectedToAuth || redirectedToLogin) {
    const trace: ExecutionTrace = {
      trace_id: traceId,
      skill_id: skill.skill_id,
      endpoint_id: "browser-capture",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      success: false,
      error: "auth_required",
    };
    return {
      trace,
      result: {
        error: "auth_required",
        provider: getRegistrableDomain(finalDomain),
        login_url: captured.final_url,
        message: `Site requires authentication. Call POST /v1/auth/login with {"url": "${captured.final_url}"} to log in interactively, or pass cookies via params.cookies / headers via params.auth_headers.`,
      },
    };
  }

  const endpoints = extractEndpoints(captured.requests, captured.ws_messages);

  const cleanEndpoints = endpoints.filter((ep) => {
    try {
      const host = new URL(ep.url_template).hostname;
      return !AUTH_PROVIDERS.test(host) && !LOGIN_PATHS.test(new URL(ep.url_template).pathname);
    } catch { return true; }
  });

  const domain = captured.domain;

  // Persist session cookies so future executions of this skill stay authenticated
  let auth_profile_ref: string | undefined;
  if (captured.cookies && captured.cookies.length > 0) {
    auth_profile_ref = `${domain}-session`;
    await storeCredential(auth_profile_ref, JSON.stringify({ cookies: captured.cookies }));
  }

  // BUG-004 fix: set auth_profile_ref when vault has stored auth for this domain
  if (!auth_profile_ref) {
    const vaultKey = `auth:${targetDomain}`;
    const hasStoredAuth = (await getCredential(vaultKey)) != null;
    if (hasStoredAuth) auth_profile_ref = vaultKey;
  }

  if (cleanEndpoints.length === 0) {
    // DOM fallback: extract structured data from rendered page, learn a DOM skill
    if (captured.html) {
      const extracted = extractFromDOM(captured.html, intent);
      if (extracted.data && extracted.confidence > 0.2) {
        // Build a DOM skill: a GET endpoint for the page URL with extraction mapping
        // Templatize query params so the skill supports re-execution with different values
        // e.g. /search?q=books&page=1 → /search?q={q}&page={page}
        const templatizedUrl = templatizeQueryParams(url);

        const domEndpoint: EndpointDescriptor = {
          endpoint_id: nanoid(),
          method: "GET",
          url_template: templatizedUrl,
          idempotency: "safe" as const,
          verification_status: "verified" as const,
          reliability_score: extracted.confidence,
          dom_extraction: {
            extraction_method: extracted.extraction_method,
            confidence: extracted.confidence,
          },
        };

        const domDraft = {
          skill_id: nanoid(),
          version: "1.0.0",
          schema_version: "1",
          lifecycle: "active" as const,
          execution_type: "http" as const,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          name: `${domain} -- ${intent}`,
          intent_signature: intent,
          domain,
          description: `DOM-extracted skill for: ${intent}`,
          owner_type: "agent" as const,
          endpoints: [domEndpoint],
          ...(auth_profile_ref ? { auth_profile_ref } : {}),
        };

        let learned: SkillManifest | undefined;
        try {
          const validation = await validateManifest({ ...domDraft, skill_id: "__validate__" });
          if (validation.valid) {
            learned = await publishSkill(domDraft);
          }
        } catch { /* publish failure is non-fatal */ }

        const trace: ExecutionTrace = {
          trace_id: traceId,
          skill_id: learned?.skill_id ?? skill.skill_id,
          endpoint_id: domEndpoint.endpoint_id,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: true,
          result: extracted.data,
        };
        return {
          trace,
          result: {
            data: extracted.data,
            _extraction: {
              method: extracted.extraction_method,
              confidence: extracted.confidence,
              source: "dom-fallback",
            },
          },
          learned_skill: learned,
        };
      }
    }

    const trace: ExecutionTrace = {
      trace_id: traceId,
      skill_id: skill.skill_id,
      endpoint_id: "browser-capture",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      success: false,
      error: "no_endpoints",
    };
    return {
      trace,
      result: {
        error: "no_endpoints",
        message: `No API endpoints or structured DOM data found at ${url}. The site may require authentication.`,
      },
    };
  }

  // Strip WS endpoints — backend validator/publisher doesn't support WS method yet
  const publishableEndpoints = cleanEndpoints.filter((ep) => ep.method !== "WS");

  if (publishableEndpoints.length === 0) {
    throw new Error("No valid HTTP endpoints discovered (WebSocket-only sites not yet supported for publishing)");
  }

  const draft = {
    skill_id: nanoid(),
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active" as const,
    execution_type: "http" as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: `${domain} -- ${intent}`,
    intent_signature: intent,
    domain,
    description: `Auto-discovered skill for: ${intent}`,
    owner_type: "agent" as const,
    endpoints: publishableEndpoints,
    ...(auth_profile_ref ? { auth_profile_ref } : {}),
  };

  const validation = await validateManifest({ ...draft, skill_id: "__validate__" });
  if (!validation.valid) throw new Error(`Skill validation failed: ${validation.hardErrors.join("; ")}`);

  const learned = await publishSkill(draft);

  const trace: ExecutionTrace = {
    trace_id: traceId,
    skill_id: skill.skill_id,
    endpoint_id: "browser-capture",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    success: true,
    result: { learned_skill_id: learned.skill_id, endpoints_discovered: cleanEndpoints.length },
  };

  return { trace, result: trace.result, learned_skill: learned };
}

export async function executeEndpoint(
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
  params: Record<string, unknown> = {},
  projection?: ProjectionOptions,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  // WebSocket endpoint: connect, collect messages, return
  if (endpoint.method === "WS") {
    const startedAt = new Date().toISOString();
    const traceId = nanoid();
    try {
      const { WebSocket } = await import("ws");
      const messages: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(endpoint.url_template);
        const timeout = setTimeout(() => { ws.close(); resolve(); }, 7000);
        ws.on("message", (data: Buffer | string) => {
          messages.push(data.toString());
        });
        ws.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
        ws.on("close", () => { clearTimeout(timeout); resolve(); });
      });
      const parsed = messages.map((m) => { try { return JSON.parse(m); } catch { return m; } });
      const trace: ExecutionTrace = {
        trace_id: traceId, skill_id: skill.skill_id, endpoint_id: endpoint.endpoint_id,
        started_at: startedAt, completed_at: new Date().toISOString(), success: true, result: parsed,
      };
      let resultData: unknown = parsed;
      if (projection) resultData = applyProjection(parsed, projection);
      return { trace, result: resultData };
    } catch (err) {
      const trace: ExecutionTrace = {
        trace_id: traceId, skill_id: skill.skill_id, endpoint_id: endpoint.endpoint_id,
        started_at: startedAt, completed_at: new Date().toISOString(), success: false,
        error: String(err),
      };
      return { trace, result: { error: String(err) } };
    }
  }

  // Mutation safety gate
  if (endpoint.method !== "GET" && endpoint.idempotency === "unsafe") {
    if (options?.dry_run) {
      const url = interpolate(endpoint.url_template, params);
      const body = endpoint.body ? interpolateObj(endpoint.body, params) : undefined;
      return {
        trace: {
          trace_id: nanoid(),
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: false,
          error: "dry_run",
        },
        result: {
          dry_run: true,
          would_execute: { method: endpoint.method, url, body },
        },
      };
    }
    if (!options?.confirm_unsafe) {
      return {
        trace: {
          trace_id: nanoid(),
          skill_id: skill.skill_id,
          endpoint_id: endpoint.endpoint_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: false,
          error: "confirmation_required",
        },
        result: {
          error: "confirmation_required",
          message: `This endpoint (${endpoint.method} ${endpoint.url_template}) is marked as unsafe. Pass confirm_unsafe: true to proceed.`,
        },
      };
    }
  }

  const startedAt = new Date().toISOString();
  const authHeaders: Record<string, string> = {};
  const cookies: Array<{ name: string; value: string; domain: string }> = [];

  if (skill.auth_profile_ref) {
    const stored = await getCredential(skill.auth_profile_ref);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as {
          headers?: Record<string, string>;
          cookies?: typeof cookies;
        };
        Object.assign(authHeaders, parsed.headers ?? {});
        cookies.push(...(parsed.cookies ?? []));
      } catch {
        // malformed stored cred — skip
      }
    }
  }

  // BUG-006 fix: fallback to domain vault cookies when auth_profile_ref is absent or yields nothing
  if (cookies.length === 0) {
    try {
      const epDomain = new URL(endpoint.url_template).hostname;
      const domainCookies = await getStoredAuth(epDomain);
      if (domainCookies && domainCookies.length > 0) {
        cookies.push(...domainCookies);
      }
      // Also try parent domain
      if (cookies.length === 0) {
        const parts = epDomain.split(".");
        if (parts.length > 2) {
          const parentCookies = await getStoredAuth(getRegistrableDomain(epDomain));
          if (parentCookies && parentCookies.length > 0) {
            cookies.push(...parentCookies);
          }
        }
      }
    } catch {
      // URL parse failure — skip vault fallback
    }
  }

  // Auto-inject CSRF tokens from cookies (LinkedIn, etc.)
  const jsessionCookie = cookies.find(c => c.name === "JSESSIONID");
  if (jsessionCookie) {
    // LinkedIn's Voyager API requires csrf-token header = JSESSIONID value (without quotes)
    const csrfValue = jsessionCookie.value.replace(/^"|"$/g, "");
    authHeaders["csrf-token"] = csrfValue;
  }

  const url = interpolate(endpoint.url_template, params);
  const body = endpoint.body ? interpolateObj(endpoint.body, params) : undefined;

  // Wrap in retry for safe (GET) endpoints
  const isSafe = endpoint.method === "GET";
  const browserCall = () => executeInBrowser(
    url,
    endpoint.method,
    endpoint.headers_template ?? {},
    body,
    authHeaders,
    cookies
  );

  const result = isSafe
    ? await withRetry(
        browserCall,
        (r) => isRetryableStatus(r.status),
      )
    : await browserCall();
  const { status, trace_id } = result;
  let data = result.data;

  const trace: ExecutionTrace = {
    trace_id,
    skill_id: skill.skill_id,
    endpoint_id: endpoint.endpoint_id,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    success: status >= 200 && status < 300,
    status_code: status,
  };

  if (!trace.success) {
    trace.error = `HTTP ${status}`;
  } else {
    trace.result = data;
  }

  // Stale credential detection: on 401 only — 403 may be CSRF, not stale creds
  if (status === 401 && skill.auth_profile_ref) {
    await deleteCredential(skill.auth_profile_ref);
    trace.error = `${trace.error} (stale credential deleted)`;
  }

  // Schema drift detection on re-execution
  if (trace.success && endpoint.response_schema && data != null) {
    const drift = detectSchemaDrift(endpoint.response_schema, data);
    if (drift.drifted) {
      trace.drift = drift;
    }
  }

  // HTML→JSON post-processing: if the endpoint returned HTML instead of JSON,
  // pipe it through DOM extraction to produce structured data
  if (trace.success && typeof data === "string" && isHtml(data)) {
    const extracted = extractFromDOM(data, skill.intent_signature);
    if (extracted.data && extracted.confidence > 0.2) {
      data = {
        data: extracted.data,
        _extraction: {
          method: extracted.extraction_method,
          confidence: extracted.confidence,
          source: "html-postprocess",
        },
      };
      trace.result = data;
    }
  }

  // Record execution for reliability scoring (backend handles score update atomically)
  await recordExecution(skill.skill_id, endpoint.endpoint_id, trace).catch(() => {});

  // Apply field projection if requested
  let resultData = data;
  if (projection && trace.success) {
    resultData = applyProjection(data, projection);
  }

  return { trace, result: resultData };
}

/**
 * Convert query params in a URL to template variables.
 * e.g. /search?q=books&page=1 → /search?q={q}&page={page}
 * Path stays untouched — only query string is templatized.
 */
function templatizeQueryParams(url: string): string {
  try {
    const u = new URL(url);
    if (u.search.length <= 1) return url; // no query params
    const params = new URLSearchParams(u.search);
    const templated = new URLSearchParams();
    for (const [key] of params) {
      templated.set(key, `{${key}}`);
    }
    return `${u.origin}${u.pathname}?${templated.toString().replace(/%7B/g, "{").replace(/%7D/g, "}")}`;
  } catch {
    return url;
  }
}

function interpolate(template: string, params: Record<string, unknown>): string {
  // Split URL into base and query string to properly encode query params
  const qIdx = template.indexOf("?");
  if (qIdx === -1) {
    return template.replace(/\{(\w+)\}/g, (_, k) =>
      params[k] != null ? String(params[k]) : `{${k}}`
    );
  }

  const base = template.substring(0, qIdx);
  const query = template.substring(qIdx + 1);

  // Interpolate base path without encoding
  const interpolatedBase = base.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] != null ? String(params[k]) : `{${k}}`
  );

  // Interpolate query params with URL encoding
  const interpolatedQuery = query.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] != null ? encodeURIComponent(String(params[k])) : `{${k}}`
  );

  return `${interpolatedBase}?${interpolatedQuery}`;
}

function interpolateObj(
  obj: Record<string, unknown>,
  params: Record<string, unknown>
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(obj).replace(/"(\{(\w+)\})"/g, (_, _full, k) =>
      params[k] != null ? JSON.stringify(params[k]) : `"{${k}}"`
    )
  ) as Record<string, unknown>;
}

/**
 * BUG-004 fix: select best endpoint by schema richness, not just "first safe GET".
 * Prefers: safe endpoints with object/array response_schema > safe without > unsafe.
 */
// --- BM25 scoring for intent→endpoint relevance ---

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "from", "get", "all", "this", "that", "is", "are", "was", "be"]);

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Build a "document" from an endpoint: URL path segments + query params + schema property names */
function endpointToTokens(ep: EndpointDescriptor): string[] {
  const tokens: string[] = [];
  try {
    const u = new URL(ep.url_template);
    // Path segments only (not hostname — that's handled by domain affinity)
    tokens.push(...u.pathname.split(/[/\-_.]/).filter((s) => s.length > 1 && !/^v\d+$/.test(s)));
    // Query param names and values
    for (const [key, val] of u.searchParams.entries()) {
      tokens.push(key);
      if (val.length > 1 && val.length < 50) tokens.push(...val.split(/[/\-_.]/).filter((s) => s.length > 1));
    }
  } catch { /* skip */ }
  // Schema property names
  if (ep.response_schema?.properties) {
    tokens.push(...Object.keys(ep.response_schema.properties));
  }
  return tokens.map((t) => t.toLowerCase());
}

function bm25Score(query: string[], doc: string[], avgDl: number): number {
  const dl = doc.length;
  // Term frequency map for this document
  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of query) {
    const freq = tf.get(term) ?? 0;
    if (freq === 0) continue;
    // Simplified IDF (no corpus-wide stats, just presence bonus)
    const idf = 1;
    const num = freq * (BM25_K1 + 1);
    const denom = freq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDl));
    score += idf * (num / denom);
  }
  return score;
}

export interface RankedEndpoint {
  endpoint: EndpointDescriptor;
  score: number;
}

/**
 * Rank endpoints by relevance to intent using BM25 + structural bonuses.
 * Exported so routes.ts can surface the ranked list to the agent.
 */
export function rankEndpoints(endpoints: EndpointDescriptor[], intent?: string, skillDomain?: string): RankedEndpoint[] {
  // Filter out noise
  const NOISE_PATTERNS = /\/(track|pixel|telemetry|beacon|csp-report|litms|demdex|analytics|protechts)/i;
  const STATIC_ASSET_PATTERNS = /\.(woff2?|ttf|eot|css|js|png|jpg|jpeg|gif|svg|ico|webp|avif)(\?|%3F|$)/i;
  const filtered = endpoints.filter((ep) => {
    if (ep.method === "HEAD" || ep.method === "OPTIONS") return false;
    if (ep.verification_status === "disabled") return false;
    if (NOISE_PATTERNS.test(ep.url_template)) return false;
    if (STATIC_ASSET_PATTERNS.test(ep.url_template)) return false;
    return true;
  });

  const nonDisabled = endpoints.filter((ep) => ep.verification_status !== "disabled");
  const candidates = filtered.length > 0 ? filtered : nonDisabled;
  if (candidates.length === 0) return [];

  // Tokenize intent and all endpoint documents
  const queryTokens = intent ? tokenize(intent) : [];
  const docs = candidates.map((ep) => endpointToTokens(ep));
  const avgDl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;

  const scored = candidates.map((ep, i) => {
    let score = 0;

    // BM25 relevance to intent
    if (queryTokens.length > 0) {
      score += bm25Score(queryTokens, docs[i], avgDl) * 10;
    }

    // Structural bonuses
    if (ep.dom_extraction) score += 25;
    if (ep.idempotency === "safe") score += 10;
    if (ep.response_schema) {
      score += 5;
      if (ep.response_schema.type === "array") score += 8;
      else if (ep.response_schema.type === "object" && ep.response_schema.properties) {
        score += Math.min(Object.keys(ep.response_schema.properties).length, 15);
      }
    }
    score += ep.reliability_score * 5;
    if (ep.method === "WS" && ep.response_schema) score += 3;

    // Domain affinity
    if (skillDomain) {
      try {
        const epHost = new URL(ep.url_template).hostname;
        if (epHost === skillDomain || epHost.endsWith(`.${skillDomain}`)) score += 15;
      } catch { /* skip */ }
    }

    // Penalize root/short paths (config/init endpoints)
    try {
      if (new URL(ep.url_template).pathname.length <= 2) score -= 5;
    } catch { /* skip */ }

    return { endpoint: ep, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function selectBestEndpoint(endpoints: EndpointDescriptor[], intent?: string, skillDomain?: string): EndpointDescriptor {
  if (endpoints.length === 0) throw new Error("No endpoints available");
  if (endpoints.length === 1) return endpoints[0];

  const ranked = rankEndpoints(endpoints, intent, skillDomain);
  if (ranked.length === 0) throw new Error("All endpoints are disabled");
  return ranked[0].endpoint;
}

/** Detect if a string response is HTML rather than JSON/plaintext */
function isHtml(text: string): boolean {
  const trimmed = text.trimStart().slice(0, 200).toLowerCase();
  return trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    (trimmed.includes("<head") && trimmed.includes("<body"));
}
