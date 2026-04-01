import { describe, test, expect } from "bun:test";
import {
  LocalAuthRuntime,
  authRuntime,
} from "../src/auth/runtime.js";
import type { AuthDependency } from "../src/auth/runtime.js";

describe("#116 auth dependency runtime — LocalAuthRuntime unit", () => {
  test("none strategy always authenticates", async () => {
    const runtime = new LocalAuthRuntime();
    const result = await runtime.resolveAuth({ domain: "example.com", strategy: "none" });
    expect(result.authenticated).toBe(true);
  });

  test("login_if_needed returns false without session", async () => {
    const runtime = new LocalAuthRuntime();
    const result = await runtime.resolveAuth({ domain: "example.com", strategy: "login_if_needed" });
    expect(result.authenticated).toBe(false);
  });

  test("login_if_needed returns true with valid session", async () => {
    const runtime = new LocalAuthRuntime();
    runtime.setSession("example.com", "tok123");
    const result = await runtime.resolveAuth({ domain: "example.com", strategy: "login_if_needed" });
    expect(result.authenticated).toBe(true);
    expect(result.session_token).toBe("tok123");
  });

  test("refresh_session extends expired session", async () => {
    const runtime = new LocalAuthRuntime();
    runtime.setSession("example.com", "tok123", -1000);
    const refreshed = await runtime.refreshSession("example.com");
    expect(refreshed).toBe(true);
    expect(await runtime.isSessionValid("example.com")).toBe(true);
  });

  test("isSessionValid returns false for unknown domain", async () => {
    const runtime = new LocalAuthRuntime();
    expect(await runtime.isSessionValid("unknown.com")).toBe(false);
  });

  test("ensure_account returns false without session", async () => {
    const runtime = new LocalAuthRuntime();
    const dep: AuthDependency = { domain: "example.com", strategy: "ensure_account" };
    const result = await runtime.resolveAuth(dep);
    expect(result.authenticated).toBe(false);
  });

  test("refresh_session with no session returns false", async () => {
    const runtime = new LocalAuthRuntime();
    const dep: AuthDependency = { domain: "nosession.com", strategy: "refresh_session" };
    const result = await runtime.resolveAuth(dep);
    expect(result.authenticated).toBe(false);
  });
});

describe("#230 authRuntime singleton wiring", () => {
  test("authRuntime singleton is exported and implements AuthRuntime interface", async () => {
    // Verify it has all three required methods
    expect(typeof authRuntime.resolveAuth).toBe("function");
    expect(typeof authRuntime.isSessionValid).toBe("function");
    expect(typeof authRuntime.refreshSession).toBe("function");
  });

  test("authRuntime.resolveAuth none strategy returns authenticated=true", async () => {
    const dep: AuthDependency = { domain: "example.com", strategy: "none" };
    const result = await authRuntime.resolveAuth(dep);
    expect(result.authenticated).toBe(true);
  });

  test("authRuntime.resolveAuth login_if_needed returns authenticated=false for unknown domain", async () => {
    const dep: AuthDependency = { domain: "never-seen-domain-xyz.com", strategy: "login_if_needed" };
    const result = await authRuntime.resolveAuth(dep);
    // Singleton has no session for this domain
    expect(result.authenticated).toBe(false);
  });

  test("authRuntime.isSessionValid returns false for unknown domain", async () => {
    const valid = await authRuntime.isSessionValid("another-never-seen-xyz.com");
    expect(valid).toBe(false);
  });

  test("authRuntime session round-trip: setSession → resolveAuth → refreshSession", async () => {
    // LocalAuthRuntime is the concrete type — cast to access setSession
    const rt = authRuntime as LocalAuthRuntime;
    const domain = "roundtrip-test.example.com";

    // Initially no session
    expect(await rt.isSessionValid(domain)).toBe(false);

    // Seed a session
    rt.setSession(domain, "secret-token-abc", 3600_000);
    expect(await rt.isSessionValid(domain)).toBe(true);

    const result = await rt.resolveAuth({ domain, strategy: "login_if_needed" });
    expect(result.authenticated).toBe(true);
    expect(result.session_token).toBe("secret-token-abc");

    // Expire it, then refresh
    rt.setSession(domain, "secret-token-abc", -1);
    expect(await rt.isSessionValid(domain)).toBe(false);

    const refreshed = await rt.refreshSession(domain);
    expect(refreshed).toBe(true);
    expect(await rt.isSessionValid(domain)).toBe(true);
  });
});
