/**
 * Traffic Interceptor — Local HTTP proxy that captures and maps API traffic in real-time.
 *
 * The "wildcard middle": intercepts all HTTP requests, forwards them to a target,
 * and builds a live API map using the path normalizer, schema inferrer, and
 * endpoint analyzer. Supports rules for modifying, mocking, or blocking requests.
 */

import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import type { ApiData, ParsedRequest } from "./types.js";
import { normalizePath } from "./path-normalizer.js";
import { safeParseJson, inferSchema, getTopLevelSchema } from "./schema-inferrer.js";
import { analyzeEndpoints } from "./endpoint-analyzer.js";

// ── Interfaces ──────────────────────────────────────────────────────────

export interface InterceptRule {
  /** Match pattern: exact path, glob with *, or regex string starting with / */
  match: string;
  /** What to do: forward (observe only), modify, mock, block */
  action: "forward" | "modify" | "mock" | "block";
  /** For modify: headers to inject/replace on request */
  injectHeaders?: Record<string, string>;
  /** For modify: transform function body (receives body string, returns modified) */
  transformRequest?: string;
  /** For modify: transform response body */
  transformResponse?: string;
  /** For mock: status code to return */
  mockStatus?: number;
  /** For mock: response body to return */
  mockBody?: string;
  /** For mock: response headers */
  mockHeaders?: Record<string, string>;
}

export interface TrafficEntry {
  timestamp: number;
  method: string;
  url: string;
  path: string;
  normalizedPath: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  responseSummary: string;
  latencyMs: number;
  /** Which rule matched, if any */
  matchedRule?: string;
  /** Whether the response was modified */
  modified: boolean;
}

export interface InterceptorStats {
  running: boolean;
  port: number;
  targetUrl: string;
  requestCount: number;
  endpointCount: number;
  uptime: number;
  /** Requests per endpoint */
  endpointHits: Record<string, number>;
  /** Average latency per endpoint */
  avgLatency: Record<string, number>;
  /** Rule match counts */
  ruleHits: Record<string, number>;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_PORT = 8787;
const MAX_TRAFFIC_LOG = 1000;
const MAX_BODY_SIZE = 100 * 1024; // 100KB
const FORWARD_TIMEOUT_MS = 30_000;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Read the full body from an incoming request stream. */
function readBody(stream: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_SIZE) {
        chunks.push(chunk);
      }
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

/** Truncate a string to MAX_BODY_SIZE. */
function truncateBody(body: string | null): string | null {
  if (!body) return null;
  if (body.length > MAX_BODY_SIZE) return body.slice(0, MAX_BODY_SIZE);
  return body;
}

/** Convert IncomingHttpHeaders to a flat Record<string, string>. */
function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

/**
 * Match a request path against a rule pattern.
 * Supports: exact match, glob wildcards (*), and regex (starts+ends with /).
 */
function matchesPattern(path: string, pattern: string): boolean {
  // Regex pattern: /pattern/
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const lastSlash = pattern.lastIndexOf("/");
    // Only treat as regex if there's content between the slashes and it looks
    // like a regex (contains regex metacharacters), not just a plain path
    const inner = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    if (inner.length > 0 && (flags.length > 0 || /[\\[\](){}+?^$|.*]/.test(inner))) {
      try {
        return new RegExp(inner, flags).test(path);
      } catch {
        return false;
      }
    }
  }

  // Glob pattern: contains *
  if (pattern.includes("*")) {
    const regexStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
    try {
      return new RegExp(regexStr).test(path);
    } catch {
      return false;
    }
  }

  // Exact match
  return path === pattern;
}

/**
 * Apply a transform function string to a body.
 * The function receives `body` (string) and should return a string.
 * Falls back to original body on any error.
 *
 * SECURITY NOTE: Uses `new Function()` which is equivalent to eval().
 * This is acceptable here because:
 * - This is a local-only proxy; transforms are set by the user/agent, not external input
 * - The transform code never comes from untrusted sources (network, database, etc.)
 * - If intercept rules are ever loaded from files, those files must be trusted
 */
function applyTransform(body: string, transformCode: string): string {
  try {
    const fn = new Function("body", transformCode) as (body: string) => string;
    const result = fn(body);
    return typeof result === "string" ? result : body;
  } catch {
    return body;
  }
}

/**
 * Forward a request to the target and return the response.
 * Uses Node.js built-in http/https modules.
 */
function forwardRequest(
  targetUrl: URL,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === "https:";
    const transport = isHttps ? https : http;

    // Build forwarded headers, removing hop-by-hop headers
    const forwardHeaders: Record<string, string> = {};
    const hopByHop = new Set([
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "te", "trailers", "transfer-encoding", "upgrade", "host",
    ]);
    for (const [key, value] of Object.entries(headers)) {
      if (!hopByHop.has(key.toLowerCase())) {
        forwardHeaders[key] = value;
      }
    }
    forwardHeaders["host"] = targetUrl.host;

    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path,
      method,
      headers: forwardHeaders,
      timeout: FORWARD_TIMEOUT_MS,
    };

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_SIZE) {
          chunks.push(chunk);
        }
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 502,
          headers: flattenHeaders(res.headers),
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("TIMEOUT"));
    });

    req.on("error", reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ── TrafficInterceptor class ────────────────────────────────────────────

export class TrafficInterceptor {
  private targetUrl: URL;
  private port: number;
  private server: http.Server | null = null;
  private startTime = 0;

  private rules: InterceptRule[] = [];
  private trafficLog: TrafficEntry[] = [];
  private maxLogSize: number;

  // API map state
  private parsedRequests: ParsedRequest[] = [];
  private endpointMap: Record<string, ParsedRequest[]> = {};
  private authHeaders: Record<string, string> = {};
  private cookies: Record<string, string> = {};
  private domain: string;
  private serviceName: string;

  // Stats tracking
  private requestCount = 0;
  private endpointHits: Record<string, number> = {};
  private latencySum: Record<string, number> = {};
  private latencyCount: Record<string, number> = {};
  private ruleHits: Record<string, number> = {};

  constructor(targetUrl: string, port?: number, maxLogSize?: number) {
    // Validate and parse the target URL
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      targetUrl = "https://" + targetUrl;
    }
    this.targetUrl = new URL(targetUrl);
    this.port = port ?? DEFAULT_PORT;
    this.maxLogSize = maxLogSize ?? MAX_TRAFFIC_LOG;
    this.domain = this.targetUrl.host;
    this.serviceName = this.deriveServiceName(this.domain);
  }

  /** Derive a clean service name from a domain. */
  private deriveServiceName(domain: string): string {
    let name = domain
      .replace(/^(www|api|v\d+|.*serv)\./, "")
      .replace(/\.(com|org|net|co|io|ai|app|sg|dev|xyz)\.?$/g, "")
      .replace(/\./g, "-")
      .toLowerCase();
    return name || "unknown-api";
  }

  /** Start the proxy server. */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Interceptor is already running");
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(() => {
          // Last-resort error handler — should not normally fire since
          // handleRequest has its own try/catch, but guard against edge cases.
          if (!res.writableEnded) {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("Internal proxy error");
          }
        });
      });

      this.server.on("error", (err) => {
        if (!this.startTime) {
          reject(err);
        }
      });

      this.server.listen(this.port, () => {
        this.startTime = Date.now();
        resolve();
      });
    });
  }

  /** Stop the proxy server and return the final API map. */
  async stop(): Promise<ApiData> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve(this.getApiMap());
        return;
      }

      this.server.close((err) => {
        this.server = null;
        if (err) {
          reject(err);
        } else {
          resolve(this.getApiMap());
        }
      });
    });
  }

  /** Get current interceptor stats. */
  getStats(): InterceptorStats {
    const avgLatency: Record<string, number> = {};
    for (const key of Object.keys(this.latencySum)) {
      const count = this.latencyCount[key] ?? 1;
      avgLatency[key] = Math.round((this.latencySum[key] ?? 0) / count);
    }

    return {
      running: this.server !== null,
      port: this.port,
      targetUrl: this.targetUrl.toString(),
      requestCount: this.requestCount,
      endpointCount: Object.keys(this.endpointMap).length,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      endpointHits: { ...this.endpointHits },
      avgLatency,
      ruleHits: { ...this.ruleHits },
    };
  }

  /** Get the current API map built from observed traffic. */
  getApiMap(): ApiData {
    const baseUrl = this.targetUrl.toString().replace(/\/$/, "");
    const data: ApiData = {
      service: this.serviceName,
      baseUrls: [baseUrl],
      baseUrl,
      authHeaders: { ...this.authHeaders },
      authMethod: this.guessAuthMethod(),
      cookies: { ...this.cookies },
      authInfo: {},
      requests: [...this.parsedRequests],
      endpoints: { ...this.endpointMap },
    };

    // Enrich with endpoint analysis if we have requests
    if (this.parsedRequests.length > 0) {
      data.endpointGroups = analyzeEndpoints(data.requests, data.endpoints);
    }

    return data;
  }

  /** Get the raw traffic log, optionally limited. */
  getTrafficLog(limit?: number): TrafficEntry[] {
    if (limit !== undefined && limit > 0) {
      return this.trafficLog.slice(-limit);
    }
    return [...this.trafficLog];
  }

  /** Add a traffic interception rule. */
  addRule(rule: InterceptRule): void {
    this.rules.push(rule);
  }

  /** Remove a rule by its match pattern. */
  removeRule(match: string): void {
    this.rules = this.rules.filter((r) => r.match !== match);
  }

  /** Clear all rules. */
  clearRules(): void {
    this.rules = [];
  }

  /** Get all current rules. */
  getRules(): InterceptRule[] {
    return [...this.rules];
  }

  // ── Private: request handling ─────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startMs = Date.now();
    const method = req.method ?? "GET";
    const rawPath = req.url ?? "/";
    const requestHeaders = flattenHeaders(req.headers);

    // Capture auth headers from incoming requests
    this.captureAuthHeaders(requestHeaders);

    let requestBody: string | null = null;
    try {
      requestBody = await readBody(req);
      if (requestBody.length === 0) requestBody = null;
    } catch {
      requestBody = null;
    }

    // Match rules — first match wins
    let matchedRule: InterceptRule | undefined;
    for (const rule of this.rules) {
      if (matchesPattern(rawPath, rule.match)) {
        matchedRule = rule;
        break;
      }
    }

    if (matchedRule) {
      this.ruleHits[matchedRule.match] = (this.ruleHits[matchedRule.match] ?? 0) + 1;
    }

    // Handle block action
    if (matchedRule?.action === "block") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Blocked by intercept rule");
      this.recordTraffic({
        timestamp: startMs,
        method,
        url: `${this.targetUrl.origin}${rawPath}`,
        path: rawPath,
        normalizedPath: normalizePath(rawPath).normalizedPath,
        requestHeaders,
        requestBody,
        responseStatus: 403,
        responseHeaders: { "content-type": "text/plain" },
        responseBody: "Blocked by intercept rule",
        responseSummary: "blocked",
        latencyMs: Date.now() - startMs,
        matchedRule: matchedRule.match,
        modified: false,
      });
      return;
    }

    // Handle mock action
    if (matchedRule?.action === "mock") {
      const mockStatus = matchedRule.mockStatus ?? 200;
      const mockBody = matchedRule.mockBody ?? "";
      const mockHeaders = matchedRule.mockHeaders ?? { "content-type": "application/json" };

      res.writeHead(mockStatus, mockHeaders);
      res.end(mockBody);

      const parsedMock = safeParseJson(mockBody);
      const mockSummary = parsedMock !== null ? inferSchema(parsedMock).summary : "";

      this.recordTraffic({
        timestamp: startMs,
        method,
        url: `${this.targetUrl.origin}${rawPath}`,
        path: rawPath,
        normalizedPath: normalizePath(rawPath).normalizedPath,
        requestHeaders,
        requestBody,
        responseStatus: mockStatus,
        responseHeaders: mockHeaders,
        responseBody: truncateBody(mockBody),
        responseSummary: mockSummary,
        latencyMs: Date.now() - startMs,
        matchedRule: matchedRule.match,
        modified: false,
      });

      // Add mock response to API map too
      this.addToApiMap(method, rawPath, mockStatus, requestHeaders, requestBody, mockBody);
      return;
    }

    // Apply request modifications if action is "modify"
    let forwardBody = requestBody;
    let forwardHeaders = { ...requestHeaders };
    let modified = false;

    if (matchedRule?.action === "modify") {
      if (matchedRule.injectHeaders) {
        for (const [key, value] of Object.entries(matchedRule.injectHeaders)) {
          forwardHeaders[key] = value;
        }
        modified = true;
      }
      if (matchedRule.transformRequest && forwardBody) {
        forwardBody = applyTransform(forwardBody, matchedRule.transformRequest);
        modified = true;
      }
    }

    // Forward request to target
    let responseStatus: number;
    let responseHeaders: Record<string, string>;
    let responseBody: string;

    try {
      const result = await forwardRequest(
        this.targetUrl,
        method,
        rawPath,
        forwardHeaders,
        forwardBody,
      );
      responseStatus = result.status;
      responseHeaders = result.headers;
      responseBody = result.body;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === "TIMEOUT";
      const status = isTimeout ? 504 : 502;
      const message = isTimeout ? "Gateway Timeout" : "Bad Gateway";

      res.writeHead(status, { "content-type": "text/plain" });
      res.end(message);

      this.recordTraffic({
        timestamp: startMs,
        method,
        url: `${this.targetUrl.origin}${rawPath}`,
        path: rawPath,
        normalizedPath: normalizePath(rawPath).normalizedPath,
        requestHeaders,
        requestBody,
        responseStatus: status,
        responseHeaders: { "content-type": "text/plain" },
        responseBody: message,
        responseSummary: message.toLowerCase(),
        latencyMs: Date.now() - startMs,
        matchedRule: matchedRule?.match,
        modified,
      });
      return;
    }

    // Apply response modifications
    if (matchedRule?.action === "modify" && matchedRule.transformResponse && responseBody) {
      responseBody = applyTransform(responseBody, matchedRule.transformResponse);
      modified = true;
    }

    // Send the response back to the caller
    // Filter out transfer-encoding since we send the full body directly
    const replyHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(responseHeaders)) {
      const lower = key.toLowerCase();
      if (lower === "transfer-encoding" || lower === "content-encoding") continue;
      replyHeaders[key] = value;
    }
    // Set correct content-length for the (possibly modified) body
    replyHeaders["content-length"] = Buffer.byteLength(responseBody, "utf-8").toString();

    res.writeHead(responseStatus, replyHeaders);
    res.end(responseBody);

    // Record and analyze
    const parsedResponse = safeParseJson(responseBody);
    const responseSummary = parsedResponse !== null ? inferSchema(parsedResponse).summary : "";

    this.recordTraffic({
      timestamp: startMs,
      method,
      url: `${this.targetUrl.origin}${rawPath}`,
      path: rawPath,
      normalizedPath: normalizePath(rawPath).normalizedPath,
      requestHeaders,
      requestBody,
      responseStatus,
      responseHeaders,
      responseBody: truncateBody(responseBody),
      responseSummary,
      latencyMs: Date.now() - startMs,
      matchedRule: matchedRule?.match,
      modified,
    });

    this.addToApiMap(method, rawPath, responseStatus, requestHeaders, requestBody, responseBody);
  }

  // ── Private: API map building ─────────────────────────────────────────

  private addToApiMap(
    method: string,
    rawPath: string,
    status: number,
    requestHeaders: Record<string, string>,
    requestBody: string | null,
    responseBody: string,
  ): void {
    // Parse the path (strip query string)
    const qIndex = rawPath.indexOf("?");
    const pathname = qIndex >= 0 ? rawPath.slice(0, qIndex) : rawPath;
    const queryString = qIndex >= 0 ? rawPath.slice(qIndex + 1) : "";

    // Parse query params
    const queryParams: { name: string; value: string }[] = [];
    if (queryString) {
      const params = new URLSearchParams(queryString);
      for (const [name, value] of params.entries()) {
        queryParams.push({ name, value });
      }
    }

    // Normalize path
    const { normalizedPath, pathParams } = normalizePath(pathname);

    // Parse request body
    let parsedRequestBody: unknown = undefined;
    let requestContentType: string | undefined = undefined;
    if (["POST", "PUT", "PATCH"].includes(method.toUpperCase()) && requestBody) {
      parsedRequestBody = safeParseJson(requestBody);
      requestContentType = requestHeaders["content-type"];
    }

    // Parse response body
    let parsedResponseBody: unknown = undefined;
    let responseSummary: string | undefined = undefined;
    const parsedResponse = safeParseJson(responseBody);
    if (parsedResponse !== null) {
      parsedResponseBody = getTopLevelSchema(parsedResponse);
      responseSummary = inferSchema(parsedResponse).summary;
    }

    // Detect response content type
    const responseContentType = undefined; // We don't have this from forwardRequest headers easily

    const parsed: ParsedRequest = {
      method: method.toUpperCase(),
      url: `${this.targetUrl.origin}${rawPath}`,
      path: pathname,
      domain: this.domain,
      status,
      responseContentType,
      queryParams: queryParams.length > 0 ? queryParams : undefined,
      requestBody: parsedRequestBody,
      requestContentType,
      responseBody: parsedResponseBody,
      responseSummary,
      normalizedPath,
      pathParams: pathParams.length > 0 ? pathParams : undefined,
    };

    this.parsedRequests.push(parsed);

    // Group by domain:normalizedPath
    const endpointKey = `${this.domain}:${normalizedPath}`;
    if (!this.endpointMap[endpointKey]) {
      this.endpointMap[endpointKey] = [];
    }
    this.endpointMap[endpointKey].push(parsed);

    // Update stats
    this.requestCount++;
    const statsKey = `${method.toUpperCase()} ${normalizedPath}`;
    this.endpointHits[statsKey] = (this.endpointHits[statsKey] ?? 0) + 1;
  }

  /** Record a traffic entry, maintaining the size limit. */
  private recordTraffic(entry: TrafficEntry): void {
    this.trafficLog.push(entry);
    if (this.trafficLog.length > this.maxLogSize) {
      this.trafficLog = this.trafficLog.slice(-this.maxLogSize);
    }

    // Update latency stats
    const statsKey = `${entry.method} ${entry.normalizedPath}`;
    this.latencySum[statsKey] = (this.latencySum[statsKey] ?? 0) + entry.latencyMs;
    this.latencyCount[statsKey] = (this.latencyCount[statsKey] ?? 0) + 1;
  }

  /** Capture auth-like headers from incoming requests for the API map. */
  private captureAuthHeaders(headers: Record<string, string>): void {
    const authPatterns = [
      "authorization", "x-api-key", "api-key", "x-auth-token",
      "access-token", "x-access-token", "x-token", "bearer",
    ];

    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (authPatterns.some((p) => lower.includes(p))) {
        this.authHeaders[lower] = value;
      }
      // Capture cookies
      if (lower === "cookie" && value) {
        for (const pair of value.split(";")) {
          const eq = pair.indexOf("=");
          if (eq > 0) {
            const cookieName = pair.slice(0, eq).trim();
            const cookieValue = pair.slice(eq + 1).trim();
            if (cookieName && cookieValue) {
              this.cookies[cookieName] = cookieValue;
            }
          }
        }
      }
    }
  }

  /** Simple auth method detection based on captured headers. */
  private guessAuthMethod(): string {
    for (const [key, value] of Object.entries(this.authHeaders)) {
      if (key === "authorization") {
        if (value.toLowerCase().startsWith("bearer")) return "bearer";
        if (value.toLowerCase().startsWith("basic")) return "basic";
        return "custom-auth";
      }
      if (key.includes("api-key") || key.includes("apikey")) return "api-key";
      if (key.includes("token")) return "token";
    }
    if (Object.keys(this.cookies).length > 0) return "cookie";
    return "none";
  }
}
