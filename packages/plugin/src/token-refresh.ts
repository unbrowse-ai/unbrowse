/**
 * Token Refresh — Auto-detect and schedule token refresh for OAuth/JWT flows.
 *
 * Detects refresh token patterns in captured traffic:
 * - URLs: /refresh, /token, /oauth/token, /auth/refresh
 * - Bodies: grant_type=refresh_token, refresh_token=...
 * - Responses: access_token, refresh_token, expires_in
 *
 * Stores refresh config and schedules automatic refresh before expiry.
 */

import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadJsonOr } from "./disk-io.js";

export interface RefreshConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, string> | string;
  refreshToken?: string;
  expiresAt?: string; // ISO timestamp
  expiresInSeconds?: number;
  lastRefreshedAt?: string;
  // OAuth-specific fields
  clientId?: string;
  clientSecret?: string;
  provider?: "google" | "firebase" | "generic"; // Detected OAuth provider
  idToken?: string; // Google/Firebase id_token
  scope?: string;
}

export interface TokenInfo {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number; // seconds
  tokenType?: string;
}

// Patterns that indicate a refresh token endpoint
const REFRESH_URL_PATTERNS = [
  /\/oauth\/token/i,
  /\/oauth2\/v\d+\/token/i,  // Google OAuth2
  /\/auth\/refresh/i,
  /\/token\/refresh/i,
  /\/refresh[-_]?token/i,
  /\/api\/.*\/refresh/i,
  /\/v\d+\/auth\/token/i,
  /accounts\.google\.com.*\/token/i,  // Google accounts
  /securetoken\.googleapis\.com/i,     // Firebase Auth
  /identitytoolkit\.googleapis\.com/i, // Google Identity Toolkit
  /\/token\?/i,  // Generic token endpoint with query params
];

const REFRESH_BODY_PATTERNS = [
  /grant_type[=:].*refresh_token/i,
  /refresh_token[=:]/i,
  /refreshToken[=:]/i,  // camelCase variant
];

// Google OAuth specific - detect initial token grants too (for capturing refresh_token)
const OAUTH_GRANT_URL_PATTERNS = [
  /\/oauth2?\/v?\d*\/token/i,
  /accounts\.google\.com.*\/token/i,
  /securetoken\.googleapis\.com/i,
  /\/auth\/token/i,
];

const OAUTH_GRANT_BODY_PATTERNS = [
  /grant_type[=:].*authorization_code/i,
  /code[=:][^&]+/i,  // Authorization code exchange
];

/**
 * Detect if a request/response pair looks like a token refresh endpoint.
 * Also detects initial OAuth grants (authorization_code exchange) to capture refresh_token.
 */
export function detectRefreshEndpoint(
  url: string,
  method: string,
  requestBody?: string,
  responseBody?: string,
): { isRefresh: boolean; isInitialGrant?: boolean; tokenInfo?: TokenInfo } {
  // Must be POST/PUT for token operations
  if (!["POST", "PUT"].includes(method.toUpperCase())) {
    return { isRefresh: false };
  }

  // Check if this is a refresh token request
  const isRefreshUrl = REFRESH_URL_PATTERNS.some((p) => p.test(url));
  const isRefreshBody = requestBody
    ? REFRESH_BODY_PATTERNS.some((p) => p.test(requestBody))
    : false;

  // Check if this is an initial OAuth grant (authorization_code exchange)
  const isGrantUrl = OAUTH_GRANT_URL_PATTERNS.some((p) => p.test(url));
  const isGrantBody = requestBody
    ? OAUTH_GRANT_BODY_PATTERNS.some((p) => p.test(requestBody))
    : false;

  const isRefresh = isRefreshUrl || isRefreshBody;
  const isInitialGrant = isGrantUrl && isGrantBody && !isRefresh;

  if (!isRefresh && !isInitialGrant) {
    return { isRefresh: false };
  }

  // Try to extract token info from response
  let tokenInfo: TokenInfo | undefined;
  if (responseBody) {
    try {
      const json = JSON.parse(responseBody);
      if (json.access_token || json.accessToken || json.token || json.idToken || json.id_token) {
        tokenInfo = {
          accessToken: json.access_token || json.accessToken || json.token,
          refreshToken: json.refresh_token || json.refreshToken,
          expiresIn: json.expires_in || json.expiresIn || json.exp || json.expiresIn,
          tokenType: json.token_type || json.tokenType || "Bearer",
        };
        // Google/Firebase specific: also capture id_token
        if (json.id_token || json.idToken) {
          (tokenInfo as any).idToken = json.id_token || json.idToken;
        }
        // Firebase specific: localId is the user ID
        if (json.localId) {
          (tokenInfo as any).userId = json.localId;
        }
      }
    } catch {
      // Not JSON, try regex extraction
      const accessMatch = responseBody.match(/"access_token"\s*:\s*"([^"]+)"/);
      const refreshMatch = responseBody.match(/"refresh_token"\s*:\s*"([^"]+)"/);
      const expiresMatch = responseBody.match(/"expires_in"\s*:\s*(\d+)/);
      const idTokenMatch = responseBody.match(/"id_token"\s*:\s*"([^"]+)"/);

      if (accessMatch || idTokenMatch) {
        tokenInfo = {
          accessToken: accessMatch?.[1],
          refreshToken: refreshMatch?.[1],
          expiresIn: expiresMatch ? parseInt(expiresMatch[1]) : undefined,
        };
        if (idTokenMatch) {
          (tokenInfo as any).idToken = idTokenMatch[1];
        }
      }
    }
  }

  return { isRefresh: isRefresh || isInitialGrant, isInitialGrant, tokenInfo };
}

/**
 * Extract refresh config from a HAR entry.
 */
export function extractRefreshConfig(entry: {
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    postData?: { text?: string };
  };
  response: {
    status: number;
    content?: { text?: string };
  };
}): RefreshConfig | null {
  const { request, response } = entry;

  if (response.status < 200 || response.status >= 300) {
    return null; // Only successful responses
  }

  const detection = detectRefreshEndpoint(
    request.url,
    request.method,
    request.postData?.text,
    response.content?.text,
  );

  if (!detection.isRefresh) {
    return null;
  }

  // Build refresh config
  const headers: Record<string, string> = {};
  for (const h of request.headers) {
    const name = h.name.toLowerCase();
    // Keep auth-related headers
    if (
      name === "authorization" ||
      name === "content-type" ||
      name.includes("auth") ||
      name.includes("token") ||
      name.includes("api-key")
    ) {
      headers[h.name] = h.value;
    }
  }

  // Parse body
  let body: Record<string, string> | string | undefined;
  if (request.postData?.text) {
    try {
      body = JSON.parse(request.postData.text);
    } catch {
      // Try URL-encoded
      if (request.postData.text.includes("=")) {
        body = {};
        for (const pair of request.postData.text.split("&")) {
          const [key, value] = pair.split("=");
          if (key && value) {
            (body as Record<string, string>)[decodeURIComponent(key)] = decodeURIComponent(value);
          }
        }
      } else {
        body = request.postData.text;
      }
    }
  }

  // Detect OAuth provider
  let provider: "google" | "firebase" | "generic" = "generic";
  if (/accounts\.google\.com|googleapis\.com\/oauth2/i.test(request.url)) {
    provider = "google";
  } else if (/securetoken\.googleapis\.com|identitytoolkit\.googleapis\.com/i.test(request.url)) {
    provider = "firebase";
  }

  // Extract OAuth client credentials from body if present
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let scope: string | undefined;

  if (typeof body === "object") {
    clientId = body.client_id || body.clientId;
    clientSecret = body.client_secret || body.clientSecret;
    scope = body.scope;
  } else if (typeof body === "string") {
    const clientIdMatch = body.match(/client_id[=:]([^&\s"]+)/);
    const clientSecretMatch = body.match(/client_secret[=:]([^&\s"]+)/);
    const scopeMatch = body.match(/scope[=:]([^&\s"]+)/);
    if (clientIdMatch) clientId = decodeURIComponent(clientIdMatch[1]);
    if (clientSecretMatch) clientSecret = decodeURIComponent(clientSecretMatch[1]);
    if (scopeMatch) scope = decodeURIComponent(scopeMatch[1]);
  }

  // For Firebase, the refresh URL is different from the initial token URL
  let refreshUrl = request.url;
  if (provider === "firebase" && detection.isInitialGrant) {
    // Firebase uses securetoken.googleapis.com for refresh
    refreshUrl = "https://securetoken.googleapis.com/v1/token";
  }

  const config: RefreshConfig = {
    url: refreshUrl,
    method: request.method,
    headers,
    body,
    refreshToken: detection.tokenInfo?.refreshToken,
    expiresInSeconds: detection.tokenInfo?.expiresIn,
    provider,
    clientId,
    clientSecret,
    scope,
    idToken: (detection.tokenInfo as any)?.idToken,
  };

  if (detection.tokenInfo?.expiresIn) {
    const expiresAt = new Date(Date.now() + detection.tokenInfo.expiresIn * 1000);
    config.expiresAt = expiresAt.toISOString();
  }

  return config;
}

/**
 * Perform a token refresh request.
 */
export async function refreshToken(config: RefreshConfig): Promise<TokenInfo | null> {
  try {
    let url = config.url;
    let headers: Record<string, string> = { ...config.headers };
    let bodyStr: string | undefined;

    // Handle provider-specific refresh flows
    if (config.provider === "firebase") {
      // Firebase refresh: POST to securetoken.googleapis.com with grant_type=refresh_token
      url = config.url.includes("securetoken.googleapis.com")
        ? config.url
        : "https://securetoken.googleapis.com/v1/token";

      // Firebase needs API key in URL
      const apiKey = config.clientId || (typeof config.body === "object" ? config.body.key : undefined);
      if (apiKey && !url.includes("key=")) {
        url += (url.includes("?") ? "&" : "?") + `key=${apiKey}`;
      }

      bodyStr = `grant_type=refresh_token&refresh_token=${encodeURIComponent(config.refreshToken || "")}`;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (config.provider === "google") {
      // Google OAuth refresh
      const params = new URLSearchParams();
      params.set("grant_type", "refresh_token");
      params.set("refresh_token", config.refreshToken || "");
      if (config.clientId) params.set("client_id", config.clientId);
      if (config.clientSecret) params.set("client_secret", config.clientSecret);

      bodyStr = params.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      // Generic refresh - use stored body but ensure refresh_token is set
      if (config.body) {
        if (typeof config.body === "string") {
          bodyStr = config.body;
        } else {
          const contentType = Object.entries(headers).find(
            ([k]) => k.toLowerCase() === "content-type",
          )?.[1];

          // Update refresh_token in body
          const bodyObj = { ...config.body };
          if (config.refreshToken) {
            bodyObj.refresh_token = config.refreshToken;
            bodyObj.grant_type = "refresh_token";
          }

          if (contentType?.includes("json")) {
            bodyStr = JSON.stringify(bodyObj);
          } else {
            bodyStr = Object.entries(bodyObj)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&");
            if (!contentType) {
              headers["Content-Type"] = "application/x-www-form-urlencoded";
            }
          }
        }
      }
    }

    const response = await fetch(url, {
      method: config.method,
      headers,
      body: bodyStr,
    });

    if (!response.ok) {
      return null;
    }

    const json = await response.json();

    return {
      accessToken: json.access_token || json.accessToken || json.token || json.id_token,
      refreshToken: json.refresh_token || json.refreshToken || config.refreshToken, // Firebase doesn't return new refresh_token
      expiresIn: json.expires_in || json.expiresIn,
      tokenType: json.token_type || json.tokenType || "Bearer",
    };
  } catch {
    return null;
  }
}

/**
 * Check if a token needs refresh (expires within buffer time).
 */
export function needsRefresh(config: RefreshConfig, bufferMinutes = 5): boolean {
  if (!config.expiresAt) {
    return false; // No expiry info, can't determine
  }

  const expiresAt = new Date(config.expiresAt);
  const bufferMs = bufferMinutes * 60 * 1000;
  const refreshAt = new Date(expiresAt.getTime() - bufferMs);

  return new Date() >= refreshAt;
}

/**
 * Update auth.json with new tokens after refresh.
 */
export function updateAuthWithTokens(
  authPath: string,
  tokenInfo: TokenInfo,
  refreshConfig: RefreshConfig,
): void {
  let auth: Record<string, any> = {};

  if (existsSync(authPath)) {
    try {
      auth = loadJsonOr<Record<string, any>>(authPath, {});
    } catch {
      /* start fresh */
    }
  }

  // Update access token in headers
  if (tokenInfo.accessToken) {
    if (!auth.headers) auth.headers = {};
    const tokenType = tokenInfo.tokenType || "Bearer";
    auth.headers["Authorization"] = `${tokenType} ${tokenInfo.accessToken}`;
  }

  // Update refresh config
  const newRefreshConfig: RefreshConfig = {
    ...refreshConfig,
    lastRefreshedAt: new Date().toISOString(),
  };

  if (tokenInfo.refreshToken) {
    newRefreshConfig.refreshToken = tokenInfo.refreshToken;

    // Update refresh token in body if it was there
    if (newRefreshConfig.body && typeof newRefreshConfig.body === "object") {
      if ("refresh_token" in newRefreshConfig.body) {
        newRefreshConfig.body.refresh_token = tokenInfo.refreshToken;
      }
      if ("refreshToken" in newRefreshConfig.body) {
        newRefreshConfig.body.refreshToken = tokenInfo.refreshToken;
      }
    }
  }

  if (tokenInfo.expiresIn) {
    newRefreshConfig.expiresAt = new Date(
      Date.now() + tokenInfo.expiresIn * 1000,
    ).toISOString();
    newRefreshConfig.expiresInSeconds = tokenInfo.expiresIn;
  }

  auth.refreshConfig = newRefreshConfig;

  writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8");
}

/**
 * Token refresh scheduler — runs in background to keep tokens fresh.
 */
export class TokenRefreshScheduler {
  private skillsDir: string;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;
  private logger: { info: (msg: string) => void; warn: (msg: string) => void };

  constructor(
    skillsDir: string,
    options?: {
      intervalMinutes?: number;
      logger?: { info: (msg: string) => void; warn: (msg: string) => void };
    },
  ) {
    this.skillsDir = skillsDir;
    this.intervalMs = (options?.intervalMinutes ?? 1) * 60 * 1000;
    this.logger = options?.logger ?? { info: console.log, warn: console.warn };
  }

  start(): void {
    if (this.timer) return;

    // Detect if we're running in diagnostic mode (doctor, audit, etc.)
    // These commands load plugins briefly then exit - don't start background tasks
    const args = process.argv.join(" ").toLowerCase();
    if (args.includes("doctor") || args.includes("audit") || args.includes("--help") || args.includes("--version")) {
      this.logger.info("[token-refresh] Diagnostic mode detected, scheduler disabled");
      return;
    }

    this.logger.info(`[token-refresh] Scheduler started (checking every ${this.intervalMs / 60000}min)`);

    // Defer initial check to avoid blocking plugin initialization
    // This prevents deadlocks with diagnostic commands that load plugins briefly
    this.initialTimeout = setTimeout(() => {
      this.checkAllSkills().catch(() => {});
    }, 5000);
    this.initialTimeout.unref(); // Don't keep process alive for deferred check

    this.timer = setInterval(() => {
      this.checkAllSkills().catch(() => {});
    }, this.intervalMs);
    this.timer.unref(); // Don't keep process alive for background refresh
  }

  stop(): void {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("[token-refresh] Scheduler stopped");
    }
  }

  private async checkAllSkills(): Promise<void> {
    try {
      if (!existsSync(this.skillsDir)) return;

      const skills = readdirSync(this.skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const skill of skills) {
        try {
          const authPath = join(this.skillsDir, skill, "auth.json");
          if (!existsSync(authPath)) continue;

          const auth = loadJsonOr<Record<string, any>>(authPath, {});
          const config = auth.refreshConfig as RefreshConfig | undefined;

          if (!config?.url) continue;

          if (needsRefresh(config)) {
            this.logger.info(`[token-refresh] Refreshing token for ${skill}...`);

            const newTokens = await refreshToken(config);
            if (newTokens?.accessToken) {
              updateAuthWithTokens(authPath, newTokens, config);
              this.logger.info(`[token-refresh] Token refreshed for ${skill}`);
            } else {
              this.logger.warn(`[token-refresh] Failed to refresh token for ${skill}`);
            }
          }
        } catch {
          // Skip this skill on any error
        }
      }
    } catch {
      // Silently fail if skills directory access fails
      // This can happen during plugin load/unload or diagnostic commands
    }
  }
}
