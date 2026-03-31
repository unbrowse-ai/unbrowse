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

  setSession(domain: string, token: string, ttlMs: number = 3600_000) {
    this.sessions.set(domain, { token, expires: Date.now() + ttlMs });
  }
}

export const authRuntime: AuthRuntime = new LocalAuthRuntime();
