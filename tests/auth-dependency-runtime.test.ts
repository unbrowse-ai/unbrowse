import { describe, test, expect } from "bun:test";
import { LocalAuthRuntime, authRuntime } from "../src/auth/runtime";
import type { AuthDependency } from "../src/auth/runtime";

/**
 * #230 auth dependency runtime -- tests the real LocalAuthRuntime
 * imported from src/auth/runtime.ts.
 * No stubs or mocks.
 */

describe("#230 auth dependency runtime", () => {
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

  test("authRuntime singleton is an AuthRuntime instance", () => {
    expect(authRuntime).toBeDefined();
    expect(typeof authRuntime.resolveAuth).toBe("function");
    expect(typeof authRuntime.isSessionValid).toBe("function");
    expect(typeof authRuntime.refreshSession).toBe("function");
    expect(typeof authRuntime.loginIfNeeded).toBe("function");
  });

  test("loginIfNeeded returns true when session exists (refresh path)", async () => {
    const runtime = new LocalAuthRuntime();
    runtime.setSession("example.com", "tok456", -500);
    const result = await runtime.loginIfNeeded("example.com");
    expect(result).toBe(true);
    expect(await runtime.isSessionValid("example.com")).toBe(true);
  });

  test("loginIfNeeded returns false when no session exists", async () => {
    const runtime = new LocalAuthRuntime();
    const result = await runtime.loginIfNeeded("unknown.com");
    expect(result).toBe(false);
  });

  test("refreshSession called before full login in loginIfNeeded", async () => {
    const runtime = new LocalAuthRuntime();
    // No session — refreshSession returns false, loginIfNeeded returns false
    const result = await runtime.loginIfNeeded("nope.com");
    expect(result).toBe(false);

    // With expired session — refreshSession returns true, loginIfNeeded returns true
    runtime.setSession("nope.com", "tok789", -100);
    const result2 = await runtime.loginIfNeeded("nope.com");
    expect(result2).toBe(true);
  });
});
