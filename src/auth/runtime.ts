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
}

export interface AuthRuntime {
  resolveAuth(dep: AuthDependency): Promise<AuthResult>;
  isSessionValid(domain: string): Promise<boolean>;
  refreshSession(domain: string): Promise<boolean>;
  loginIfNeeded(domain: string, loginUrl?: string): Promise<boolean>;
}

/**
 * Stub auth runtime — checks local session store only.
 * Interactive login (browser-based) to be wired in a follow-up.
 */
export class LocalAuthRuntime implements AuthRuntime {
  private sessions = new Map<string, { token: string; expires: number }>();

  async resolveAuth(dep: AuthDependency): Promise<AuthResult> {
    if (dep.strategy === "none") return { authenticated: true };

    const session = this.sessions.get(dep.domain);
    if (session && session.expires > Date.now()) {
      return { authenticated: true, session_token: session.token };
    }

    if (dep.strategy === "refresh_session" && session) {
      const refreshed = await this.refreshSession(dep.domain);
      if (refreshed) {
        const updated = this.sessions.get(dep.domain);
        return { authenticated: true, session_token: updated?.token };
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

  async loginIfNeeded(domain: string, _loginUrl?: string): Promise<boolean> {
    // Try session refresh first — cheap path
    const refreshed = await this.refreshSession(domain);
    if (refreshed) return true;
    // Full interactive login not yet implemented in LocalAuthRuntime.
    // Browser-based login will be wired through the auth/index.ts flow.
    return false;
  }

  setSession(domain: string, token: string, ttlMs: number = 3600_000) {
    this.sessions.set(domain, { token, expires: Date.now() + ttlMs });
  }
}

export const authRuntime: AuthRuntime = new LocalAuthRuntime();


/**
 * Resolve a batch of auth dependencies using the singleton runtime.
 * Used by the orchestrator auth prerequisite detection before endpoint execution.
 * Returns one AuthResult per dependency, in the same order.
 */
export async function resolveAuthPrerequisites(
  deps: AuthDependency[],
): Promise<AuthResult[]> {
  return Promise.all(deps.map((dep) => authRuntime.resolveAuth(dep)));
}

/**
 * Derive auth dependencies from a skill manifest endpoints.
 * Inspects semantic.auth_required and auth_profile_ref to surface
 * which domains need authentication and what strategy to use.
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
