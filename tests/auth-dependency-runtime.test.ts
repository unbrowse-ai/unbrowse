import { describe, test, expect } from "bun:test";

type AuthStrategy = "login_if_needed" | "ensure_account" | "refresh_session" | "none";

interface AuthDependency {
  domain: string;
  strategy: AuthStrategy;
  login_url?: string;
  session_check_url?: string;
}

interface AuthRuntime {
  resolveAuth(dep: AuthDependency): Promise<{ authenticated: boolean; session_token?: string }>;
  isSessionValid(domain: string): Promise<boolean>;
  refreshSession(domain: string): Promise<boolean>;
}

class StubAuthRuntime implements AuthRuntime {
  private sessions = new Map<string, { token: string; expires: number }>();

  async resolveAuth(dep: AuthDependency): Promise<{ authenticated: boolean; session_token?: string }> {
    if (dep.strategy === "none") return { authenticated: true };

    const session = this.sessions.get(dep.domain);
    if (session && session.expires > Date.now()) {
      return { authenticated: true, session_token: session.token };
    }

    if (dep.strategy === "refresh_session" && session) {
      const refreshed = await this.refreshSession(dep.domain);
      if (refreshed) {
        const newSession = this.sessions.get(dep.domain);
        return { authenticated: true, session_token: newSession?.token };
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

describe("#116 auth dependency runtime", () => {
  test("none strategy always authenticates", async () => {
    const runtime = new StubAuthRuntime();
    const result = await runtime.resolveAuth({ domain: "example.com", strategy: "none" });
    expect(result.authenticated).toBe(true);
  });

  test("login_if_needed returns false without session", async () => {
    const runtime = new StubAuthRuntime();
    const result = await runtime.resolveAuth({ domain: "example.com", strategy: "login_if_needed" });
    expect(result.authenticated).toBe(false);
  });

  test("login_if_needed returns true with valid session", async () => {
    const runtime = new StubAuthRuntime();
    runtime.setSession("example.com", "tok123");
    const result = await runtime.resolveAuth({ domain: "example.com", strategy: "login_if_needed" });
    expect(result.authenticated).toBe(true);
    expect(result.session_token).toBe("tok123");
  });

  test("refresh_session extends expired session", async () => {
    const runtime = new StubAuthRuntime();
    runtime.setSession("example.com", "tok123", -1000);
    const refreshed = await runtime.refreshSession("example.com");
    expect(refreshed).toBe(true);
    expect(await runtime.isSessionValid("example.com")).toBe(true);
  });

  test("isSessionValid returns false for unknown domain", async () => {
    const runtime = new StubAuthRuntime();
    expect(await runtime.isSessionValid("unknown.com")).toBe(false);
  });
});
