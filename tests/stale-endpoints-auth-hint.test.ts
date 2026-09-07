// Loop 5.1: auth_hint + reason + cookie-expiry tests.
//
// New surface: buildAuthHint() returns a structured login prompt with
// reason (401 / 403 / cookie_expired / other) and concrete commands.
// markCookieExpiry() lets a caller mark stale before any execute.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recordStaleEndpoint,
  buildAuthHint,
  markCookieExpiry,
  listStaleEndpoints,
  clearStaleEndpoints,
} from "../src/auth/stale-endpoints.ts";

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `unbrowse-hint-test-${Date.now()}-${Math.random()}.json`);
  process.env.UNBROWSE_STALE_ENDPOINTS_PATH = tmpFile;
});

afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch {}
  delete process.env.UNBROWSE_STALE_ENDPOINTS_PATH;
});

describe("auth hint surface", () => {
  it("derives reason='auth_failed_401' from status=401", () => {
    recordStaleEndpoint("x.com", "ep1", 401, "unknown");
    const hint = buildAuthHint("x.com");
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe("auth_failed_401");
    expect(hint!.login_required).toBe(true);
    expect(hint!.domain).toBe("x.com");
    expect(hint!.message).toContain("401");
    expect(hint!.commands).toContain(`unbrowse go "https://x.com/"`);
  });

  it("derives reason='auth_failed_403' from status=403", () => {
    recordStaleEndpoint("github.com", "ep2", 403);
    const hint = buildAuthHint("github.com");
    expect(hint!.reason).toBe("auth_failed_403");
    expect(hint!.message).toContain("403");
  });

  it("returns null when no stale records exist for the domain", () => {
    expect(buildAuthHint("never.test")).toBeNull();
  });

  it("picks the most recent record when several exist for the domain", () => {
    recordStaleEndpoint("x.com", "old", 401, "unknown", Date.now() - 1000);
    recordStaleEndpoint("x.com", "new", 403, "unknown", Date.now());
    const hint = buildAuthHint("x.com");
    expect(hint!.reason).toBe("auth_failed_403");
  });
});

describe("cookie expiry detection", () => {
  it("marks stale when an auth-shaped cookie expired before now", () => {
    const expiredAuth = [
      { name: "session", expires: Math.floor(Date.now() / 1000) - 60, httpOnly: true, secure: true },
    ];
    const count = markCookieExpiry("example.com", expiredAuth, ["ep1", "ep2"]);
    expect(count).toBe(2);
    const records = listStaleEndpoints("example.com");
    expect(records.length).toBe(2);
    expect(records[0].reason).toBe("cookie_expired");
  });

  it("does NOT mark stale when only session cookies (expires=0) are present", () => {
    const sessionOnly = [
      { name: "tmp", expires: 0, httpOnly: false, secure: false },
    ];
    const count = markCookieExpiry("example.com", sessionOnly, ["ep1"]);
    expect(count).toBe(0);
  });

  it("does NOT mark stale when expired cookies aren't auth-shaped (no httpOnly/secure)", () => {
    const expiredButTracking = [
      { name: "_ga", expires: Math.floor(Date.now() / 1000) - 60, httpOnly: false, secure: false },
    ];
    const count = markCookieExpiry("example.com", expiredButTracking, ["ep1"]);
    expect(count).toBe(0);
  });

  it("does NOT mark stale when cookies are still fresh", () => {
    const fresh = [
      { name: "session", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true },
    ];
    const count = markCookieExpiry("example.com", fresh, ["ep1"]);
    expect(count).toBe(0);
  });

  it("surfaces cookie_expired reason in buildAuthHint after markCookieExpiry", () => {
    const expired = [
      { name: "session", expires: Math.floor(Date.now() / 1000) - 1, httpOnly: true, secure: true },
    ];
    markCookieExpiry("example.com", expired, ["ep1"]);
    const hint = buildAuthHint("example.com");
    expect(hint!.reason).toBe("cookie_expired");
    expect(hint!.message).toContain("expired");
  });
});
