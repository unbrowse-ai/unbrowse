import { log } from "../logger.js";
import { getStoredAuth, extractBrowserAuth, getAuthCookies } from "./index.js";

export type AuthStrategy = "login_if_needed" | "ensure_account" | "refresh_session" | "none";

export interface AuthDependency {
  domain: string;
  strategy: AuthStrategy;
  login_url?: string;
  session_check_url?: string;
}

export interface AuthResult {
  authenticated: boolean;
  session_token?: string;
  method?: "cookies" | "interactive" | "cached";
}
export interface AuthRuntime {
  resolveAuth(dep: AuthDependency): Promise<AuthResult>;
  isSessionValid(domain: string): Promise<boolean>;
  refreshSession(domain: string): Promise<boolean>;
  loginIfNeeded(domain: string, loginUrl?: string): Promise<boolean>;
}

/**
 * Auth runtime with real fallback chain:
 *   1. Cached session (in-memory)
 *   2. Stored vault cookies (browser-extracted or previous login)
 *   3. Return false — caller surfaces auth_required to agent
 */
export class LocalAuthRuntime implements AuthRuntime {
  private sessions = new Map<string, { token: string; expires: number; method?: string }>();

  async resolveAuth(dep: AuthDependency): Promise<AuthResult> {
    if (dep.strategy === "none") return { authenticated: true, method: "cached" };

    const session = this.sessions.get(dep.domain);
    if (session && session.expires > Date.now()) {
      return { authenticated: true, session_token: session.token, method: "cached" };
    }

    // Skip vault + browser-cookie probes when UNBROWSE_DISABLE_AUTH_FALLBACK=1.
    // Tests that assert "unauthenticated without session" need to ignore
    // any cookies the developer's actual Chrome happens to have.
    const skipFallback = process.env.UNBROWSE_DISABLE_AUTH_FALLBACK === "1";

    // Try stored vault cookies
    if (!skipFallback) {
      try {
        const cookies = await getStoredAuth(dep.domain);
        if (cookies && cookies.length > 0) {
          log("auth-runtime", `found ${cookies.length} stored cookies for ${dep.domain}`);
          this.setSession(dep.domain, "vault-cookies", 3600_000);
          return { authenticated: true, method: "cookies" };
        }
      } catch { /* vault not available */ }

      // Try browser cookie extraction
      try {
        const result = await extractBrowserAuth(dep.domain);
        if (result.success && result.cookies_stored > 0) {
          log("auth-runtime", `extracted ${result.cookies_stored} browser cookies for ${dep.domain}`);
          this.setSession(dep.domain, "browser-cookies", 3600_000);
          return { authenticated: true, method: "cookies" };
        }
      } catch { /* browser extraction not available */ }
    }

    if (dep.strategy === "refresh_session" && session) {
      const refreshed = await this.refreshSession(dep.domain);
      if (refreshed) {
        const updated = this.sessions.get(dep.domain);
        return { authenticated: true, session_token: updated?.token, method: "cached" };
      }
    }

    return { authenticated: false };
  }

  async isSessionValid(domain: string): Promise<boolean> {
    const session = this.sessions.get(domain);
    return !!session && session.expires > Date.now();
  }

  async refreshSession(domain: string): Promise<boolean> {
    const session = this.sessions.get(domain);
    if (session) {
      session.expires = Date.now() + 3600_000;
      return true;
    }
    return false;
  }

  async loginIfNeeded(domain: string, loginUrl?: string): Promise<boolean> {
    const refreshed = await this.refreshSession(domain);
    if (refreshed) return true;

    // Try vault + browser cookies
    try {
      const cookies = await getAuthCookies(domain);
      if (cookies && cookies.length > 0) {
        this.setSession(domain, "auto-cookies", 3600_000);
        log("auth-runtime", `loginIfNeeded resolved via cookies for ${domain}`);
        return true;
      }
    } catch { /* not available */ }

    return false;
  }

  setSession(domain: string, token: string, ttlMs: number = 3600_000) {
    this.sessions.set(domain, { token, expires: Date.now() + ttlMs });
  }
}

export const authRuntime: AuthRuntime = new LocalAuthRuntime();

/**
 * Resolve a batch of auth dependencies using the singleton runtime.
 */
export async function resolveAuthPrerequisites(
  deps: AuthDependency[],
): Promise<AuthResult[]> {
  return Promise.all(deps.map((dep) => authRuntime.resolveAuth(dep)));
}

/**
 * Derive auth dependencies from a skill manifest endpoints.
 */
export function deriveAuthDependencies(
  skill: { domain: string; auth_profile_ref?: string; endpoints: Array<{ endpoint_id: string; semantic?: { auth_required?: boolean } }> },
  targetEndpointId?: string,
): AuthDependency[] {
  const endpoints = targetEndpointId
    ? skill.endpoints.filter((ep) => ep.endpoint_id === targetEndpointId)
    : skill.endpoints;

  const needsAuth = endpoints.some(
    (ep) => ep.semantic?.auth_required === true,
  );

  if (!needsAuth && !skill.auth_profile_ref) return [];

  return [
    {
      domain: skill.domain,
      strategy: "login_if_needed" as AuthStrategy,
      login_url: `https://${skill.domain}/login`,
    },
  ];
}
