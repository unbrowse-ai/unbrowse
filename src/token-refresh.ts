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

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RefreshConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, string> | string;
  refreshToken?: string;
  expiresAt?: string; // ISO timestamp
  expiresInSeconds?: number;
  lastRefreshedAt?: string;
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
  /\/auth\/refresh/i,
  /\/token\/refresh/i,
  /\/refresh[-_]?token/i,
  /\/api\/.*\/refresh/i,
  /\/v\d+\/auth\/token/i,
];

const REFRESH_BODY_PATTERNS = [
  /grant_type[=:].*refresh_token/i,
  /refresh_token[=:]/i,
];

/**
 * Detect if a request/response pair looks like a token refresh endpoint.
 */
export function detectRefreshEndpoint(
  url: string,
  method: string,
  requestBody?: string,
  responseBody?: string,
): { isRefresh: boolean; tokenInfo?: TokenInfo } {
  // Check URL patterns
  const urlMatch = REFRESH_URL_PATTERNS.some((p) => p.test(url));

  // Check request body patterns
  const bodyMatch = requestBody
    ? REFRESH_BODY_PATTERNS.some((p) => p.test(requestBody))
    : false;

  // Must be POST/PUT and match URL or body pattern
  if (!["POST", "PUT"].includes(method.toUpperCase())) {
    return { isRefresh: false };
  }

  if (!urlMatch && !bodyMatch) {
    return { isRefresh: false };
  }

  // Try to extract token info from response
  let tokenInfo: TokenInfo | undefined;
  if (responseBody) {
    try {
      const json = JSON.parse(responseBody);
      if (json.access_token || json.accessToken || json.token) {
        tokenInfo = {
          accessToken: json.access_token || json.accessToken || json.token,
          refreshToken: json.refresh_token || json.refreshToken,
          expiresIn: json.expires_in || json.expiresIn || json.exp,
          tokenType: json.token_type || json.tokenType || "Bearer",
        };
      }
    } catch {
      // Not JSON, try regex extraction
      const accessMatch = responseBody.match(/"access_token"\s*:\s*"([^"]+)"/);
      const refreshMatch = responseBody.match(/"refresh_token"\s*:\s*"([^"]+)"/);
      const expiresMatch = responseBody.match(/"expires_in"\s*:\s*(\d+)/);

      if (accessMatch) {
        tokenInfo = {
          accessToken: accessMatch[1],
          refreshToken: refreshMatch?.[1],
          expiresIn: expiresMatch ? parseInt(expiresMatch[1]) : undefined,
        };
      }
    }
  }

  return { isRefresh: true, tokenInfo };
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

  const config: RefreshConfig = {
    url: request.url,
    method: request.method,
    headers,
    body,
    refreshToken: detection.tokenInfo?.refreshToken,
    expiresInSeconds: detection.tokenInfo?.expiresIn,
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
    const headers: Record<string, string> = {
      ...config.headers,
    };

    let bodyStr: string | undefined;
    if (config.body) {
      if (typeof config.body === "string") {
        bodyStr = config.body;
      } else {
        // Check content-type to determine encoding
        const contentType = Object.entries(headers).find(
          ([k]) => k.toLowerCase() === "content-type",
        )?.[1];

        if (contentType?.includes("json")) {
          bodyStr = JSON.stringify(config.body);
        } else {
          // URL-encoded
          bodyStr = Object.entries(config.body)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
          if (!contentType) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
          }
        }
      }
    }

    const response = await fetch(config.url, {
      method: config.method,
      headers,
      body: bodyStr,
    });

    if (!response.ok) {
      return null;
    }

    const json = await response.json();

    return {
      accessToken: json.access_token || json.accessToken || json.token,
      refreshToken: json.refresh_token || json.refreshToken,
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
      auth = JSON.parse(readFileSync(authPath, "utf-8"));
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

    this.logger.info(`[token-refresh] Scheduler started (checking every ${this.intervalMs / 60000}min)`);

    // Run immediately, then on interval
    this.checkAllSkills();
    this.timer = setInterval(() => this.checkAllSkills(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("[token-refresh] Scheduler stopped");
    }
  }

  private async checkAllSkills(): Promise<void> {
    if (!existsSync(this.skillsDir)) return;

    const skills = readdirSync(this.skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const skill of skills) {
      const authPath = join(this.skillsDir, skill, "auth.json");
      if (!existsSync(authPath)) continue;

      try {
        const auth = JSON.parse(readFileSync(authPath, "utf-8"));
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
        // Skip this skill
      }
    }
  }
}
