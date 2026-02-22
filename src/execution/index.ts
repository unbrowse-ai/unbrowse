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
  // BUG-004/007 fix: select endpoint by schema richness + intent relevance
  const endpoint = selectBestEndpoint(skill.endpoints, skill.intent_signature);
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

  const endpoints = extractEndpoints(captured.requests);

  const cleanEndpoints = endpoints.filter((ep) => {
    try {
      const host = new URL(ep.url_template).hostname;
      return !AUTH_PROVIDERS.test(host) && !LOGIN_PATHS.test(new URL(ep.url_template).pathname);
    } catch { return true; }
  });

  if (cleanEndpoints.length === 0) {
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
        message: `No API endpoints discovered at ${url}. The site may require authentication or only renders server-side.`,
      },
    };
  }

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
    endpoints: cleanEndpoints,
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

  const { status, data, trace_id } = isSafe
    ? await withRetry(
        browserCall,
        (r) => isRetryableStatus(r.status),
      )
    : await browserCall();

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

  // Stale credential detection: on 401/403, delete credential and flag
  if ((status === 401 || status === 403) && skill.auth_profile_ref) {
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

  // Record execution for reliability scoring (backend handles score update atomically)
  await recordExecution(skill.skill_id, endpoint.endpoint_id, trace).catch(() => {});

  // Apply field projection if requested
  let resultData = data;
  if (projection && trace.success) {
    resultData = applyProjection(data, projection);
  }

  return { trace, result: resultData };
}

function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] != null ? String(params[k]) : `{${k}}`
  );
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
function selectBestEndpoint(endpoints: EndpointDescriptor[], intent?: string): EndpointDescriptor {
  if (endpoints.length === 0) throw new Error("No endpoints available");
  if (endpoints.length === 1) return endpoints[0];

  // Filter out noise endpoints (HEAD, OPTIONS, tracking, CSP, static assets)
  const NOISE_PATTERNS = /\/(track|pixel|telemetry|beacon|csp-report|litms|demdex|analytics|protechts)/i;
  const filtered = endpoints.filter((ep) => {
    if (ep.method === "HEAD" || ep.method === "OPTIONS") return false;
    if (NOISE_PATTERNS.test(ep.url_template)) return false;
    return true;
  });

  // Fall back to unfiltered if filtering removed everything
  const candidates = filtered.length > 0 ? filtered : endpoints;

  // Extract intent keywords for relevance matching
  const intentWords = intent
    ? intent.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    : [];

  const scored = candidates.map((ep) => {
    let score = 0;

    // Prefer safe (GET) endpoints
    if (ep.idempotency === "safe") score += 10;

    // Prefer endpoints with response schemas
    if (ep.response_schema) {
      score += 5;
      if (ep.response_schema.type === "object" && ep.response_schema.properties) {
        score += Math.min(Object.keys(ep.response_schema.properties).length, 15);
      } else if (ep.response_schema.type === "array") {
        score += 8;
      }
    }

    // Factor in reliability
    score += ep.reliability_score * 5;

    // Intent relevance: match intent keywords against URL path
    if (intentWords.length > 0) {
      const urlLower = ep.url_template.toLowerCase();
      for (const word of intentWords) {
        if (urlLower.includes(word)) score += 3;
      }
    }

    // Penalize endpoints with very short or no URL paths (often config/init endpoints)
    try {
      const path = new URL(ep.url_template).pathname;
      if (path.length <= 2) score -= 5;
    } catch { /* skip */ }

    return { ep, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].ep;
}
