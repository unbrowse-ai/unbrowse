// Regression pin for serializeCookiesUnderLimit, the trim helper inside
// src/execution/index.ts that the SSR fast-path uses for tryHttpFetch.
//
// Cycle-4 evidence: probe 026 amazon (`/s?k=usb-c+cable`) returned
// `400 Request Header Or Cookie Too Large` because tryHttpFetch was
// joining all 15 live-tab cookies (CSRF / session / locale / tracking)
// into one Cookie header that blew past nginx's `large_client_header_
// buffers 4 16k` default. platform fix: cap the serialised header at
// 8KB, prioritize auth/session/csrf/token-named cookies, drop tracking
// cookies first. Pure structural primitive; no per-host registry.
//
// Run: bun test tests/cookie-header-under-limit.test.ts

import { describe, expect, test } from "bun:test";
import { serializeCookiesUnderLimit } from "../src/execution/index.ts";

const cookie = (name: string, value: string) => ({ name, value, domain: ".example.com" });

describe("serializeCookiesUnderLimit", () => {
  test("returns empty string for empty input", () => {
    expect(serializeCookiesUnderLimit([])).toBe("");
  });

  test("passes through small cookie sets unchanged", () => {
    const cookies = [cookie("session", "abc"), cookie("csrf", "xyz")];
    const out = serializeCookiesUnderLimit(cookies);
    expect(out).toContain("session=abc");
    expect(out).toContain("csrf=xyz");
    expect(out.split("; ").length).toBe(2);
  });

  test("caps total bytes under the 8KB default", () => {
    const huge = cookie("tracking_blob", "x".repeat(7000));
    const more = cookie("another_blob", "y".repeat(7000));
    const out = serializeCookiesUnderLimit([huge, more]);
    expect(out.length).toBeLessThanOrEqual(8192);
  });

  test("prioritizes auth-name cookies over tracking blobs of same size", () => {
    const tracking = cookie("_ga", "x".repeat(4000));
    const auth = cookie("session_id", "y".repeat(4000));
    // Both fit individually, but adding a 200-byte separator + names blows
    // past 8KB when both are kept. The auth-named one must be kept.
    const tooBig = [tracking, auth, cookie("csrf_token", "z".repeat(500))];
    const out = serializeCookiesUnderLimit(tooBig);
    expect(out).toContain("session_id=");
    expect(out).toContain("csrf_token=");
    // _ga is dropped because the auth ones are prioritized first
    expect(out).not.toContain("_ga=");
  });

  test("amazon reproducer: 15 mixed cookies stay under nginx default", () => {
    const cookies = [
      cookie("session-id", "176-1234567"),
      cookie("session-token", "x".repeat(800)),
      cookie("ubid-main", "abc"),
      cookie("csm-hit", "y".repeat(200)),
      cookie("at-main", "z".repeat(1200)),
      cookie("x-main", "y".repeat(800)),
      cookie("i18n-prefs", "USD"),
      cookie("sst-main", "a".repeat(600)),
      cookie("lc-main", "en_US"),
      cookie("session-id-time", "1234"),
      cookie("aws-target-data", "x".repeat(3000)),
      cookie("aws-userInfo", "y".repeat(2000)),
      cookie("aws-target-visitor-id", "abc"),
      cookie("_ga", "x".repeat(50)),
      cookie("_gid", "y".repeat(50)),
    ];
    const out = serializeCookiesUnderLimit(cookies);
    expect(out.length).toBeLessThanOrEqual(8192);
    // Session cookies (auth-named) must survive the trim
    expect(out).toContain("session-id=");
    expect(out).toContain("session-token=");
  });

  test("custom maxBytes parameter honored", () => {
    const cookies = [cookie("a", "x".repeat(500)), cookie("b", "y".repeat(500))];
    const out = serializeCookiesUnderLimit(cookies, 600);
    expect(out.length).toBeLessThanOrEqual(600);
  });
});
