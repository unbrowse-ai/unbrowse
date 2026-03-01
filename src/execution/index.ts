import { executeInBrowser, triggerAndIntercept } from "../capture/index.js";
import { captureSession } from "../capture/index.js";
import { extractEndpoints, extractAuthHeaders, type ExtractionContext } from "../reverse-engineer/index.js";
import { publishSkill } from "../marketplace/index.js";
import { updateEndpointScore } from "../marketplace/index.js";
import { getCredential, storeCredential, deleteCredential } from "../vault/index.js";
import { getStoredAuth, getAuthCookies, refreshAuthFromBrowser } from "../auth/index.js";
import { applyProjection } from "../transform/index.js";
import { detectSchemaDrift } from "../transform/drift.js";
import { recordExecution, cachePublishedSkill, findExistingSkillForDomain } from "../client/index.js";
import { validateManifest } from "../client/index.js";
import { withRetry, isRetryableStatus } from "./retry.js";
import type { EndpointDescriptor, ExecutionOptions, ExecutionTrace, ProjectionOptions, SkillManifest } from "../types/index.js";
import { nanoid } from "nanoid";
import { getRegistrableDomain } from "../domain.js";
import { extractFromDOM } from "../extraction/index.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Quality gate — validate extracted data before marketplace publishing
// ---------------------------------------------------------------------------

interface QualityResult {
  valid: boolean;
  quality_note?: string;
}

/** Detect concatenated values like "AAPLApple" or "Inc978,583" */
function isConcatenatedValue(s: string): boolean {
  // Uppercase ticker jammed onto capitalized word: AAPLApple, NVDANvidia
  if (/[A-Z]{2,}[A-Z][a-z]/.test(s)) return true;
  // Word ending in letter immediately followed by digits: Inc978, Corp123
  if (/[a-zA-Z]\d{3,}/.test(s)) return true;
  return false;
}

/**
 * Validate extraction quality. Always returns data to the caller —
 * this only gates whether we publish to the marketplace.
 */
function validateExtractionQuality(data: unknown, confidence: number): QualityResult {
  // 1. Min confidence
  if (confidence < 0.5) {
    return { valid: false, quality_note: `confidence too low (${confidence.toFixed(2)} < 0.5)` };
  }

  // Only validate arrays (repeated data structures)
  if (!Array.isArray(data)) return { valid: true };
  if (data.length === 0) return { valid: true };

  // 2. Deduplication check
  const serialized = data.map((item) => JSON.stringify(item));
  const unique = new Set(serialized);
  const dupeRatio = 1 - unique.size / serialized.length;
  if (dupeRatio > 0.5) {
    return { valid: false, quality_note: `${Math.round(dupeRatio * 100)}% duplicate rows` };
  }

  // 3. Concatenation detection
  let totalStrings = 0;
  let concatStrings = 0;
  for (const item of data) {
    if (item && typeof item === "object") {
      for (const val of Object.values(item as Record<string, unknown>)) {
        if (typeof val === "string" && val.length > 3) {
          totalStrings++;
          if (isConcatenatedValue(val)) concatStrings++;
        }
      }
    }
  }
  if (totalStrings > 0 && concatStrings / totalStrings > 0.3) {
    return { valid: false, quality_note: `${Math.round((concatStrings / totalStrings) * 100)}% concatenated values detected` };
  }

  // 4. Diversity check — reject if all items share the same link/title (nav chrome)
  if (data.length >= 3) {
    for (const field of ["link", "href", "url", "title"]) {
      const vals = data
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[field] : undefined))
        .filter((v) => v != null);
      if (vals.length >= 3) {
        const uniqueVals = new Set(vals.map(String));
        if (uniqueVals.size === 1) {
          return { valid: false, quality_note: `all items share the same "${field}" — likely navigation chrome` };
        }
      }
    }
  }

  return { valid: true };
}

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

  // Use the caller's intent for ranking when available, fall back to skill's original intent
  const endpoint = selectBestEndpoint(skill.endpoints, options?.intent ?? skill.intent_signature, skill.domain, options?.contextUrl);
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
  let usedStoredAuth = !!(cookies && cookies.length > 0) || !!(authHeaders && Object.keys(authHeaders).length > 0);

  // Bird-style: auto-resolve cookies from vault → browser fallback
  if (!cookies || cookies.length === 0) {
    const resolved = await getAuthCookies(targetDomain);
    if (resolved && resolved.length > 0) {
      cookies = resolved;
      usedStoredAuth = true;
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

  const endpoints = extractEndpoints(captured.requests, captured.ws_messages, { pageUrl: url, intent });

  const cleanEndpoints = endpoints.filter((ep) => {
    try {
      const host = new URL(ep.url_template).hostname;
      return !AUTH_PROVIDERS.test(host) && !LOGIN_PATHS.test(new URL(ep.url_template).pathname);
    } catch { return true; }
  });

  const domain = captured.domain;

  // Persist session cookies + auth headers so server-fetch works without browser.
  // extractAuthHeaders collects everything sanitizeHeaders strips from skill manifests
  // (authorization, x-csrf-token, api keys, etc.) — stored encrypted in vault.
  let auth_profile_ref: string | undefined;
  const capturedAuthHeaders = extractAuthHeaders(captured.requests);

  if ((captured.cookies && captured.cookies.length > 0) || Object.keys(capturedAuthHeaders).length > 0) {
    auth_profile_ref = `${domain}-session`;
    await storeCredential(auth_profile_ref, JSON.stringify({
      cookies: captured.cookies ?? [],
      headers: Object.keys(capturedAuthHeaders).length > 0 ? capturedAuthHeaders : undefined,
    }));
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
        // Quality gate: validate data before publishing to marketplace
        const quality = validateExtractionQuality(extracted.data, extracted.confidence);

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

        // Only publish to marketplace if quality passes
        let learned: SkillManifest | undefined;
        if (quality.valid) {
          try {
            const validation = await validateManifest({ ...domDraft, skill_id: "__validate__" });
            if (validation.valid) {
              learned = await publishSkill(domDraft);
            }
          } catch { /* publish failure is non-fatal */ }
        }

        const trace: ExecutionTrace = {
          trace_id: traceId,
          skill_id: learned?.skill_id ?? skill.skill_id,
          endpoint_id: domEndpoint.endpoint_id,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: true,
          result: extracted.data,
        };
        // Always return data to the caller — quality gate only blocks publishing
        return {
          trace,
          result: {
            data: extracted.data,
            _extraction: {
              method: extracted.extraction_method,
              confidence: extracted.confidence,
              source: "dom-fallback",
              ...(quality.quality_note ? { quality_note: quality.quality_note, published: false } : { published: !!learned }),
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

  // Reuse existing skill for this domain to preserve skill_id and learned exec_strategy.
  // This prevents duplicate skills accumulating in the marketplace on re-captures.
  const existingSkill = findExistingSkillForDomain(domain);
  if (existingSkill) {
    // Carry forward learned exec_strategy from old endpoints to matching new ones
    for (const ep of publishableEndpoints) {
      if (ep.exec_strategy) continue;
      // Match by URL template (endpoint_id changes on re-capture)
      const oldMatch = existingSkill.endpoints.find(
        (old) => old.url_template === ep.url_template && old.method === ep.method
      );
      if (oldMatch?.exec_strategy) {
        ep.exec_strategy = oldMatch.exec_strategy;
      }
    }
  }

  const draft = {
    skill_id: existingSkill?.skill_id ?? nanoid(),
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active" as const,
    execution_type: "http" as const,
    created_at: existingSkill?.created_at ?? new Date().toISOString(),
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

  // Detect tracking-only capture: all endpoints lack a response_schema, meaning no real
  // JSON data was returned — the site likely gated its API behind authentication.
  // Only flag this when no auth was used (so a retry with auth has a chance of succeeding).
  const hasMeaningfulEndpoint = publishableEndpoints.some((ep) => ep.response_schema != null);
  const authRecommended = !usedStoredAuth && !hasMeaningfulEndpoint;

  return {
    trace,
    result: {
      ...(trace.result as Record<string, unknown>),
      ...(authRecommended ? {
        auth_recommended: true,
        auth_hint: `No data endpoints found — ${domain} likely requires authentication. ` +
          `Store browser cookies for this domain via the auth endpoints, then retry this capture.`,
      } : {}),
    },
    learned_skill: learned,
  };
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
      // Merge path_params defaults for dry_run preview too
      const dryParams = { ...params };
      if (endpoint.path_params) {
        for (const [k, v] of Object.entries(endpoint.path_params)) {
          if (dryParams[k] == null) dryParams[k] = v;
        }
      }
      const url = interpolate(endpoint.url_template, dryParams);
      const body = endpoint.body ? interpolateObj(endpoint.body, dryParams) : undefined;
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

  // Endpoint domain — used for cookie resolution, strategy caching, auth refresh
  const epDomain = (() => { try { return new URL(endpoint.url_template).hostname; } catch { return skill.domain; } })();

  // Bird-style: auto-resolve cookies from vault → browser fallback
  if (cookies.length === 0) {
    try {
      const resolved = await getAuthCookies(epDomain);
      if (resolved && resolved.length > 0) {
        cookies.push(...resolved);
      }
    } catch {
      // URL parse failure — skip cookie resolution
    }
  }

  // Also check the domain-session vault for stored auth headers (authorization, api keys, etc.)
  // These are captured during browser-capture and stored alongside cookies.
  if (Object.keys(authHeaders).length === 0) {
    try {
      const sessionKey = `${getRegistrableDomain(epDomain)}-session`;
      const sessionData = await getCredential(sessionKey);
      if (sessionData) {
        const parsed = JSON.parse(sessionData) as { headers?: Record<string, string>; cookies?: typeof cookies };
        if (parsed.headers) Object.assign(authHeaders, parsed.headers);
        if (parsed.cookies && cookies.length === 0) cookies.push(...parsed.cookies);
      }
    } catch { /* skip */ }
  }

  log("exec", `endpoint ${endpoint.endpoint_id}: cookies=${cookies.length} authHeaders=${Object.keys(authHeaders).length} hasAuth=${cookies.length > 0 || Object.keys(authHeaders).length > 0}`);

  // BUG-006: Merge path_params defaults — user params override captured defaults
  let mergedParams = { ...params };
  if (endpoint.path_params && typeof endpoint.path_params === "object") {
    for (const [k, v] of Object.entries(endpoint.path_params)) {
      if (mergedParams[k] == null) {
        mergedParams[k] = v;
      }
    }
  }

  // Merge captured query params into URL — user params override endpoint defaults
  let urlTemplate = endpoint.url_template;
  if (endpoint.query && typeof endpoint.query === "object" && Object.keys(endpoint.query).length > 0) {
    try {
      const u = new URL(urlTemplate);
      for (const [k, v] of Object.entries(endpoint.query)) {
        // User params override captured query defaults
        if (mergedParams[k] != null) {
          u.searchParams.set(k, String(mergedParams[k]));
        } else if (v != null) {
          u.searchParams.set(k, String(v));
        }
      }
      urlTemplate = u.toString();
    } catch {
      // URL parse failure — skip query merge
    }
  }
  let url = interpolate(urlTemplate, mergedParams);
  const body = endpoint.body ? interpolateObj(endpoint.body, mergedParams) : undefined;

  const isSafe = endpoint.method === "GET";

  // Append leftover params as query string on GET requests.
  // Params already consumed by path_params, endpoint.query, or {template} vars are skipped.
  if (isSafe && Object.keys(params).length > 0) {
    const consumedKeys = new Set<string>([
      "endpoint_id",
      ...Object.keys(endpoint.path_params ?? {}),
      ...Object.keys(endpoint.query ?? {}),
    ]);
    // Also mark keys that appeared as {var} in the original URL template
    const templateVarRe = /\{(\w+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = templateVarRe.exec(endpoint.url_template)) !== null) {
      consumedKeys.add(m[1]);
    }
    const leftover = Object.entries(params).filter(([k]) => !consumedKeys.has(k) && params[k] != null);
    if (leftover.length > 0) {
      try {
        const u = new URL(url);
        for (const [k, v] of leftover) {
          u.searchParams.set(k, String(v));
        }
        url = u.toString();
      } catch { /* URL parse failure — skip */ }
    }
  }

  const serverFetch = async (): Promise<{ data: unknown; status: number; trace_id: string }> => {
    // Default accept to JSON, but never overwrite the endpoint's own accept header
    // (e.g. LinkedIn uses "application/vnd.linkedin.normalized+json+2.1")
    const defaultAccept = (!endpoint.dom_extraction && !endpoint.headers_template?.["accept"])
      ? { "accept": "application/json" } : {};
    const headers: Record<string, string> = {
      ...defaultAccept,
      ...endpoint.headers_template,
      ...authHeaders,
    };
    // Strip browser-only headers that cause issues server-side
    delete headers["sec-ch-ua"];
    delete headers["sec-ch-ua-mobile"];
    delete headers["sec-ch-ua-platform"];
    delete headers["upgrade-insecure-requests"];

    // Inject cookies as Cookie header — same as a browser would send.
    // Strip enclosing quotes from values — Chrome's SQLite stores them quoted
    // but the Cookie header must send them unquoted (RFC 6265 §4.1.1).
    if (cookies.length > 0) {
      const cookieStr = cookies.map((c) => {
        const v = c.value.startsWith('"') && c.value.endsWith('"') ? c.value.slice(1, -1) : c.value;
        return `${c.name}=${v}`;
      }).join("; ");
      headers["cookie"] = cookieStr;

      // CSRF token auto-detection (bird pattern): many sites require CSRF tokens
      // as both a cookie AND a header. Detect common patterns and replay them.
      if (!headers["x-csrf-token"] && !headers["x-xsrf-token"]) {
        const csrfCookie = cookies.find((c) =>
          /^(ct0|csrf_token|_csrf|csrftoken|XSRF-TOKEN|_xsrf)$/i.test(c.name)
        );
        if (csrfCookie) {
          const v = csrfCookie.value.startsWith('"') && csrfCookie.value.endsWith('"') ? csrfCookie.value.slice(1, -1) : csrfCookie.value;
          headers["x-csrf-token"] = v;
        }
      }
    }

    const res = await fetch(url, { method: endpoint.method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "follow" });
    let data: unknown;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { data, status: res.status, trace_id: nanoid() };
  };

  const browserCall = () => executeInBrowser(
    url,
    endpoint.method,
    endpoint.headers_template ?? {},
    body,
    authHeaders,
    cookies
  );

  let result: { data: unknown; status: number; trace_id: string };
  const hasAuth = cookies.length > 0 || Object.keys(authHeaders).length > 0;

  if (hasAuth) {
    // Authed execution: learned strategy → skip doomed tiers
    //   1. Server fetch (fast — works for Twitter, simple APIs)
    //   2. Trigger-and-intercept (navigate to page, let site's JS make the call)
    //   3. Browser in-page fetch (last resort)
    let strategy: "server" | "trigger-intercept" | "browser" | undefined;

    // Endpoint-level learned strategy (strong signal — proven for this specific endpoint).
    // Domain-level prediction is only used as a tiebreaker, never to skip server-fetch entirely,
    // because different endpoints on the same domain may have different requirements.
    const endpointStrategy = endpoint.exec_strategy;

    if (endpointStrategy === "server") {
      // Proven: server-fetch works for this endpoint
      result = await serverFetch();
      strategy = "server";
    } else if (endpointStrategy === "trigger-intercept" && endpoint.trigger_url && isSafe) {
      // Proven: this endpoint needs trigger-intercept
      log("exec", `using learned strategy trigger-intercept via ${endpoint.trigger_url}`);
      result = await triggerAndIntercept(endpoint.trigger_url, endpoint.url_template, cookies, authHeaders);
      strategy = "trigger-intercept";
    } else if (endpointStrategy === "browser") {
      log("exec", `using learned strategy browser`);
      result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
      strategy = "browser";
    } else {
      // No endpoint-level strategy — always try server-fetch first (fastest path).
      // Fall back to trigger-intercept or browser if server returns 4xx.
      try {
        result = await serverFetch();
        if (result.status >= 200 && result.status < 400) {
          strategy = "server";
        } else {
          log("exec", `server fetch returned ${result.status}, falling back`);
          if (endpoint.trigger_url && isSafe) {
            result = await triggerAndIntercept(endpoint.trigger_url, endpoint.url_template, cookies, authHeaders);
            strategy = "trigger-intercept";
          } else {
            result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
            strategy = "browser";
          }
        }
      } catch {
        result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        strategy = "browser";
      }
    }

    // Persist learned strategy at endpoint level only.
    // Domain-level cache removed: it over-generalizes (e.g., one 400 on LinkedIn
    // locked all endpoints into trigger-intercept even though server-fetch works for most).
    if (strategy && result.status >= 200 && result.status < 400 && strategy !== endpoint.exec_strategy) {
      log("exec", `learned exec_strategy=${strategy} for endpoint ${endpoint.endpoint_id}`);
      endpoint.exec_strategy = strategy;
      try { cachePublishedSkill(skill); } catch (e) { log("exec", `failed to cache strategy: ${e}`); }
    }
  } else if (isSafe) {
    // No auth: fetch-first for safe GETs — fall back to browser if SPA shell or error
    try {
      result = await withRetry(serverFetch, (r) => isRetryableStatus(r.status));
      if (typeof result.data === "string" && isHtml(result.data)) {
        if (isSpaShell(result.data)) {
          result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
        }
      }
    } catch {
      result = await withRetry(browserCall, (r) => isRetryableStatus(r.status));
    }
  } else {
    // No auth, non-GET: server fetch
    result = await serverFetch();
  }
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
    trace.error = status === 404
      ? `HTTP 404 — endpoint may be stale. Re-run via POST /v1/intent/resolve to get fresh endpoints.`
      : `HTTP ${status}`;
  } else {
    trace.result = data;
  }

  // Stale credential detection: on 401/403, try refreshing from browser (bird pattern)
  // instead of just deleting. Next request will use fresh cookies.
  if (status === 401 || status === 403) {
    try {
      const refreshed = await refreshAuthFromBrowser(epDomain);
      if (refreshed) {
        trace.error = `${trace.error} (credentials refreshed from browser — retry should succeed)`;
      } else {
        // No fresh cookies available — delete stale ones
        if (skill.auth_profile_ref) {
          await deleteCredential(skill.auth_profile_ref);
        }
        trace.error = `${trace.error} (stale credentials — re-authenticate via /v1/auth/login)`;
      }
    } catch {
      if (skill.auth_profile_ref) {
        await deleteCredential(skill.auth_profile_ref);
      }
      trace.error = `${trace.error} (stale credential deleted)`;
    }
  }

  // Schema drift detection on re-execution
  if (trace.success && endpoint.response_schema && data != null) {
    const drift = detectSchemaDrift(endpoint.response_schema, data);
    if (drift.drifted) {
      trace.drift = drift;
    }
  }

  // HTML→JSON post-processing: if the endpoint returned HTML instead of JSON,
  // pipe it through DOM extraction to produce structured data.
  // Always extract — returning raw HTML to an agent is never useful.
  if (trace.success && typeof data === "string" && isHtml(data)) {
    const intent = options?.intent || skill.intent_signature;
    const extracted = extractFromDOM(data, intent);
    if (extracted.data) {
      const quality = validateExtractionQuality(extracted.data, extracted.confidence);
      data = {
        data: extracted.data,
        _extraction: {
          method: extracted.extraction_method,
          confidence: extracted.confidence,
          source: "html-postprocess",
          ...(quality.quality_note ? { quality_note: quality.quality_note } : {}),
        },
      };
      trace.result = data;
    }
  }

  // Record execution for reliability scoring (fire-and-forget — don't block response)
  recordExecution(skill.skill_id, endpoint.endpoint_id, trace).catch(() => {});

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

/** Minimal stemmer: strip trailing s/es/ed/ing for matching */
function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  // "messages" → "message" (not "messag"), "classes" → "class", "pages" → "page"
  if (word.endsWith("ses") || word.endsWith("ges") || word.endsWith("ces") || word.endsWith("zes")) return word.slice(0, -1);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  // "bookmarked" → "bookmark", "saved" → "save", "liked" → "like"
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  // "loading" → "load", "trending" → "trend" (but not "thing", "ring")
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  return word;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "from",
  "get", "all", "this", "that", "is", "are", "was", "be", "it", "at", "by", "not",
  "com", "www", "https", "http", "html", "htm",
]);

/** Expand tokens with synonyms/related terms for better recall */
const SYNONYMS: Record<string, string[]> = {
  price: ["price", "prices", "pricing", "cost", "usd", "quote", "rate", "value", "market"],
  token: ["token", "tokens", "coin", "coins", "crypto", "currency", "asset"],
  search: ["search", "query", "find", "lookup", "filter", "dex"],
  chart: ["chart", "charts", "graph", "history", "ohlcv", "candle", "candles", "kline"],
  trade: ["trade", "trades", "swap", "swaps", "order", "orders", "transaction", "transactions"],
  volume: ["volume", "vol", "liquidity", "tvl"],
  pair: ["pair", "pairs", "pool", "pools"],
  trending: ["trending", "top", "hot", "gainers", "losers", "movers"],
  user: ["user", "users", "account", "accounts", "profile", "profiles", "member"],
  list: ["list", "lists", "all", "index", "browse", "catalog"],
  feed: ["feed", "feeds", "timeline", "stream", "home", "cards", "feedCards"],
  post: ["post", "posts", "article", "articles", "update", "updates", "content", "entry"],
  comment: ["comment", "comments", "reply", "replies", "discussion", "thread"],
  message: ["message", "messages", "messaging", "inbox", "conversation", "conversations", "chat"],
  notification: ["notification", "notifications", "alert", "alerts", "bell"],
  connection: ["connection", "connections", "follower", "followers", "following", "network", "contact", "contacts", "invitation", "invitations"],
  profile: ["profile", "profiles", "identity", "about", "bio", "member"],
  recommend: ["recommend", "recommendation", "recommendations", "suggested", "suggestion", "suggestions", "forYou"],
  bookmark: ["bookmark", "bookmarks", "bookmarked", "saved", "save", "favorite", "favourites"],
  news: ["news", "headline", "headlines", "story", "stories", "storylines"],
  dashboard: ["dashboard", "overview", "summary", "home", "main"],
};

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Expand intent tokens with synonyms + stemmed variants for better matching */
function expandQuery(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const stemmed = stem(t);
    expanded.add(stemmed);
    // Look up synonyms by: raw token, stemmed token, or any SYNONYMS key that stems to the same value
    // (e.g. "messages" → stem "messag" matches SYNONYMS["message"] → stem "messag")
    let syns = SYNONYMS[t] ?? SYNONYMS[stemmed];
    if (!syns) {
      for (const key of Object.keys(SYNONYMS)) {
        if (stem(key) === stemmed) { syns = SYNONYMS[key]; break; }
      }
    }
    if (syns) for (const s of syns) { expanded.add(s); expanded.add(stem(s)); }
  }
  return [...expanded];
}

/** Build a "document" from an endpoint: URL path segments + query params + schema property names */
function endpointToTokens(ep: EndpointDescriptor): string[] {
  const tokens: string[] = [];
  try {
    const u = new URL(ep.url_template);
    // Path segments — split on delimiters AND camelCase to extract meaningful words
    // e.g. "BookmarkFoldersSlice" → ["Bookmark", "Folders", "Slice"]
    const rawSegments = u.pathname.split(/[/\-_.{}]/).filter((s) => s.length > 1 && !/^v\d+$/.test(s));
    for (const seg of rawSegments) {
      tokens.push(seg);
      // Also split camelCase: "BookmarkFoldersSlice" → ["Bookmark", "Folders", "Slice"]
      const camelParts = seg.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter((s) => s.length > 1);
      if (camelParts.length > 1) tokens.push(...camelParts);
    }
    // Hostname subdomains (e.g. "api" from api.dexscreener.com — strong signal)
    const hostParts = u.hostname.split(".");
    tokens.push(...hostParts.filter((s) => s.length > 2 && s !== "www" && s !== "com" && s !== "org" && s !== "net" && s !== "io"));
    // Query param names and values
    for (const [key, val] of u.searchParams.entries()) {
      tokens.push(key);
      if (val.length > 1 && val.length < 50) {
        tokens.push(...val.split(/[/\-_.]/).filter((s) => s.length > 1));
      } else if (val.length >= 50) {
        // Long values (e.g. graphql queryId): split on camelCase and delimiters to extract meaningful words
        const parts = val.split(/[/\-_.()]/).flatMap((s) => s.split(/(?<=[a-z])(?=[A-Z])/)).filter((s) => s.length > 1);
        tokens.push(...parts.slice(0, 10)); // cap to avoid noise from hashes
      }
    }
  } catch { /* skip */ }
  // Schema property names (strong signal — these describe the response data)
  if (ep.response_schema?.properties) {
    tokens.push(...Object.keys(ep.response_schema.properties));
    // Also add nested property names (1 level deep)
    for (const val of Object.values(ep.response_schema.properties) as Array<{ properties?: Record<string, unknown> }>) {
      if (val?.properties) tokens.push(...Object.keys(val.properties));
    }
  }
  // Trigger URL path segments — reveals which page triggered this API call
  // e.g., trigger_url="/i/bookmarks" adds "bookmarks" token for BM25 matching
  if (ep.trigger_url) {
    try {
      const tu = new URL(ep.trigger_url);
      tokens.push(...tu.pathname.split(/[/\-_.{}]/).filter((s) => s.length > 1 && !/^(i|app|en|v\d+)$/.test(s)));
    } catch { /* skip */ }
  }
  return tokens.map((t) => stem(t.toLowerCase()));
}

function bm25Score(query: string[], doc: string[], avgDl: number, docCount: number, docFreqs: Map<string, number>): number {
  const dl = doc.length;
  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of query) {
    const freq = tf.get(term) ?? 0;
    if (freq === 0) continue;
    // Real IDF: log((N - df + 0.5) / (df + 0.5) + 1) — terms appearing in fewer docs score higher
    const df = docFreqs.get(term) ?? 0;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
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
export function rankEndpoints(endpoints: EndpointDescriptor[], intent?: string, skillDomain?: string, contextUrl?: string): RankedEndpoint[] {
  // --- Hard-filter: hosts that NEVER contain useful data ---
  const NOISE_HOSTS = /(id5-sync\.com|btloader\.com|presage\.io|onetrust\.com|adsrvr\.org|googlesyndication\.com|adtrafficquality\.google|amazon-adsystem\.com|crazyegg\.com|challenges\.cloudflare\.com|google-analytics\.com|doubleclick\.net|gstatic\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|protechts\.net|demdex\.net|datadoghq\.com|fullstory\.com|launchdarkly\.com|intercom\.io|sentry\.io|segment\.io|amplitude\.com|mixpanel\.com|hotjar\.com|clarity\.ms|googletagmanager\.com|walletconnect\.com|cloudflareinsights\.com|fonts\.googleapis\.com|recaptcha|waa-pa\.|signaler-pa\.|ogads-pa\.|reddit\.com\/pixels?|pixel-config\.|dns-finder\.com|cookieconsentpub|firebase\.googleapis\.com|firebaseinstallations\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|apis\.google\.com|connect\.facebook\.net|bat\.bing\.com|static\.cloudflareinsights\.com|cdn\.mxpnl\.com|js\.hs-analytics\.net|snap\.licdn\.com|px\.ads|t\.co\/i|analytics\.|telemetry\.|stats\.)/i;

  // Noise URL path patterns — tracking, telemetry, logging
  const NOISE_PATHS = /\/(track|pixel|telemetry|beacon|csp-report|litms|demdex|analytics|protechts|collect|tr\/|gen_204|generate_204|log$|logging|heartbeat|metrics|consent|sodar|tag$|event$|events$|impression|pageview|click|__)/i;

  // Auth/session/config — on-domain but not data
  const AUTH_CONFIG_PATHS = /\/(csrf_meta|logged_in_user|analytics_user_data|onboarding|geolocation|auth|login|logout|register|signup|session|webConfig|config\.json|manifest\.json|robots\.txt|sitemap|favicon|opensearch|service-worker|sw\.js)\b/i;

  // Session plumbing — infrastructure endpoints no user would ever want as data.
  // Only true noise: account config, badge counts, feature flags, telemetry, DM settings.
  // NOT filtered: HomeTimeline, Bookmarks, Notifications, UserByScreenName, etc. — real data.
  const SESSION_PLUMBING = /(account\/settings|account\/multi|badge_count|DataSaverMode|permissionsState|hashflags|email_phone_info|live_pipeline|user_flow|strato\/column|ces\/p2|IntercomStarter|getAltText|fleetline|FeatureHelper|VerifiedAvatar|ScheduledPromotion|DirectCall|DmSettings|PinnedTimeline)/i;

  // Static assets
  const STATIC_ASSET_PATTERNS = /\.(woff2?|ttf|eot|css|js|mjs|png|jpg|jpeg|gif|svg|ico|webp|avif|mp4|mp3|wav|riv|lottie|wasm)(\?|%3F|$)/i;

  // Animation/UI asset paths
  const UI_ASSET_PATHS = /\/(rive|lottie|animations?|sprites?|assets\/static)\//i;
  const filtered = endpoints.filter((ep) => {
    if (ep.method === "HEAD" || ep.method === "OPTIONS") return false;
    if (ep.verification_status === "disabled") return false;
    if (STATIC_ASSET_PATTERNS.test(ep.url_template)) return false;
    if (UI_ASSET_PATHS.test(ep.url_template)) return false;
    try {
      const host = new URL(ep.url_template).hostname;
      if (NOISE_HOSTS.test(host)) return false;
    } catch { /* skip */ }
    if (NOISE_PATHS.test(ep.url_template)) return false;
    if (AUTH_CONFIG_PATHS.test(ep.url_template)) return false;
    if (SESSION_PLUMBING.test(ep.url_template)) return false;
    return true;
  });

  const nonDisabled = endpoints.filter((ep) => ep.verification_status !== "disabled");
  const candidates = filtered.length > 0 ? filtered : nonDisabled;
  if (candidates.length === 0) return [];

  // Tokenize intent with synonym expansion for better recall
  const rawTokens = intent ? tokenize(intent) : [];
  const queryTokens = rawTokens.length > 0 ? expandQuery(rawTokens) : [];
  const docs = candidates.map((ep) => endpointToTokens(ep));
  const avgDl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;

  // Build corpus-level document frequencies for real IDF
  const docFreqs = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set(doc);
    for (const t of seen) docFreqs.set(t, (docFreqs.get(t) ?? 0) + 1);
  }
  const docCount = docs.length;

  // Meta/support/promo/config path patterns — not primary data
  const META_PATHS = /\/(annotation|insight|sentiment|vote|portfolio|summary_button|summary_card|tagmetric|quick_add|notifications?|preferences|settings|onboarding|public\/active|remoteConfig|banner\/metadata|embedded-wallets|glow\/get-rendered)/i;

  // Data format indicators
  const DATA_INDICATORS = /\.(json|xml|csv)(\?|$)|\/api\//i;

  // Currency/time patterns — strong price/financial signal
  const CURRENCY_TIME_PATTERNS = /\/(usd|eur|gbp|btc|eth|sol|cny|jpy|krw|24_hours|7_days|30_days|1_year|max|hourly|daily|weekly|price|prices|market|markets|ticker|tickers|quote|quotes|ohlcv?|candles?|klines?)\b/i;

  // API subdomain pattern — "api.example.com" or "io.example.com" strongly suggests data endpoint
  const API_SUBDOMAIN = /^(api|io|data|feed|stream|ws)\./i;

  const scored = candidates.map((ep, i) => {
    let score = 0;
    let pathname = "";
    let hostname = "";
    try {
      const u = new URL(ep.url_template);
      pathname = u.pathname;
      hostname = u.hostname;
    } catch { /* skip */ }

    // === BM25 relevance to intent (primary signal, weighted heavily) ===
    if (queryTokens.length > 0) {
      score += bm25Score(queryTokens, docs[i], avgDl, docCount, docFreqs) * 20;
    }

    // === Structural bonuses ===
    if (ep.dom_extraction) score += 25;
    if (ep.idempotency === "safe" || ep.method === "GET") score += 5;

    // Rich schema = likely structured data endpoint
    if (ep.response_schema) {
      score += 5;
      if (ep.response_schema.type === "array") score += 10;
      else if (ep.response_schema.type === "object" && ep.response_schema.properties) {
        const propCount = Object.keys(ep.response_schema.properties).length;
        score += Math.min(propCount * 2, 20);
      }
    }
    score += ep.reliability_score * 5;
    if (ep.method === "WS" && ep.response_schema) score += 3;

    // === Domain affinity ===
    if (skillDomain) {
      try {
        if (hostname === skillDomain || hostname.endsWith(`.${skillDomain}`)) {
          score += 15;
          // Extra bonus for API subdomains on the skill domain
          if (API_SUBDOMAIN.test(hostname)) score += 15;
        } else {
          // Off-domain = almost never right
          score -= 30;
        }
      } catch { /* skip */ }
    }

    // API subdomain bonus even without skill domain context
    if (API_SUBDOMAIN.test(hostname)) score += 10;

    // === Data-relevance signals ===
    if (DATA_INDICATORS.test(ep.url_template)) score += 5;
    if (CURRENCY_TIME_PATTERNS.test(pathname)) score += 15;

    // Deep paths with meaningful segments = likely data endpoints
    const pathDepth = pathname.split("/").filter((s) => s.length > 0).length;
    if (pathDepth >= 3) score += 5;

    // === Context URL match — endpoint was captured from the page the user is asking about ===
    if (contextUrl && ep.trigger_url) {
      try {
        const contextPath = new URL(contextUrl).pathname;
        const triggerPath = new URL(ep.trigger_url).pathname;
        if (triggerPath === contextPath) score += 20;
      } catch { /* skip */ }
    }

    // === Penalties ===
    if (META_PATHS.test(pathname)) score -= 15;
    if (SESSION_PLUMBING.test(pathname) || SESSION_PLUMBING.test(ep.url_template)) score -= 30;

    // Penalize root/short paths (homepage, config, init)
    if (pathname.length <= 2) score -= 10;

    // Penalize POST endpoints that aren't explicitly API calls (likely tracking/events)
    if (ep.method === "POST" && !DATA_INDICATORS.test(ep.url_template) && !ep.response_schema) {
      score -= 15;
    }

    return { endpoint: ep, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function selectBestEndpoint(endpoints: EndpointDescriptor[], intent?: string, skillDomain?: string, contextUrl?: string): EndpointDescriptor {
  if (endpoints.length === 0) throw new Error("No endpoints available");
  if (endpoints.length === 1) return endpoints[0];

  const ranked = rankEndpoints(endpoints, intent, skillDomain, contextUrl);
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

/**
 * Detect if HTML is an empty SPA shell that needs JS to render.
 * SPA shells have a near-empty body (just a <div id="root"> or similar)
 * with all content loaded by JavaScript bundles.
 * SSR pages have substantial text content in the body already.
 */
function isSpaShell(html: string): boolean {
  // Quick heuristic: extract body content and check if it has meaningful text
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) return true; // no body at all — treat as SPA shell
  const body = bodyMatch[1];

  // Strip script/style tags and HTML tags to get raw text
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // SPA shells have very little text — just "Loading..." or empty divs
  return text.length < 200;
}
