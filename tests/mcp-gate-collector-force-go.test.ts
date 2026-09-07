// Falsifiers for F4 (UNBROWSE_GATE_FORCE_GO env opt-in) and F5
// (cookies_injected passthrough from /v1/browse/go) wired into
// scripts/mcp-gate-parallel-collect.ts.
//
// These cover the two regressions identified in bug B-023: 5 of 6 failing
// auth-cookies probes had marketplace cache hits, so the collector
// short-circuited /v1/browse/go and the cookie-injection path never ran;
// and even on the one probe that did go through, the capture.meta.json
// never carried the cookies_injected count from the /v1/browse/go response,
// so the in-thread judge had no evidence to discriminate "cookies wired
// up but server still 401'd" from "cookies never injected at all".
//
// Tests target the pure helpers exported from
// scripts/mcp-gate-parallel-helpers.ts. The helper-file split exists
// precisely because the collector script does top-level await + a
// process.exit(2) guard on argv[2], making direct import unsafe.
import { describe, expect, it } from "bun:test";
import { parseForceGoEnv, buildCaptureMeta } from "../scripts/mcp-gate-parallel-helpers.ts";

describe("parseForceGoEnv — F4 opt-in env parser", () => {
  it("returns true for the documented values (1, true, yes) case-insensitive", () => {
    expect(parseForceGoEnv("1")).toBe(true);
    expect(parseForceGoEnv("true")).toBe(true);
    expect(parseForceGoEnv("TRUE")).toBe(true);
    expect(parseForceGoEnv("True")).toBe(true);
    expect(parseForceGoEnv("yes")).toBe(true);
    expect(parseForceGoEnv("YES")).toBe(true);
    expect(parseForceGoEnv("  1  ")).toBe(true); // tolerant of whitespace
  });

  it("returns false for unset (the default behaviour MUST be unchanged)", () => {
    expect(parseForceGoEnv(undefined)).toBe(false);
    expect(parseForceGoEnv(null)).toBe(false);
    expect(parseForceGoEnv("")).toBe(false);
  });

  it("returns false for falsy-looking strings and arbitrary other values", () => {
    expect(parseForceGoEnv("0")).toBe(false);
    expect(parseForceGoEnv("false")).toBe(false);
    expect(parseForceGoEnv("no")).toBe(false);
    expect(parseForceGoEnv("maybe")).toBe(false);
    expect(parseForceGoEnv("on")).toBe(false); // not in the documented allow-list
    expect(parseForceGoEnv("y")).toBe(false);
  });

  it("the bug-replay path: with FORCE_GO unset the collector keeps the cache short-circuit", () => {
    // This mirrors the runProbe conditional `if (preEps.length === 0 || FORCE_GO)`.
    // Five of six failing B-023 auth-cookies probes hit non-empty preEps; without
    // the env, go is skipped and cookie injection never happens — that's exactly
    // the regression we are gating against accidentally re-enabling.
    const FORCE_GO = parseForceGoEnv(process.env.SOMETHING_NEVER_SET);
    const preEpsNonEmpty = [{ endpoint_id: "cached" }];
    const wouldRunGo = preEpsNonEmpty.length === 0 || FORCE_GO;
    expect(wouldRunGo).toBe(false);
  });

  it("the fix-active path: with FORCE_GO=1 the collector ALWAYS runs go, even on cache hit", () => {
    const FORCE_GO = parseForceGoEnv("1");
    const preEpsNonEmpty = [{ endpoint_id: "cached" }];
    const wouldRunGo = preEpsNonEmpty.length === 0 || FORCE_GO;
    expect(wouldRunGo).toBe(true);
  });
});

describe("buildCaptureMeta — F5 cookies_injected passthrough", () => {
  const baseIso = { snap_current_url: null, intended_host: "x.com", snap_host: "", host_match: null };

  it("surfaces cookies_injected when /v1/browse/go body carries the field", () => {
    const meta = buildCaptureMeta({
      cb: { indexed: true, endpoint_count: 4, mode: "live_capture" },
      eps: [{ endpoint_id: "e1" }],
      sb: { page_title: "home" },
      evalRes: { body: {} },
      skillId: "sk_real",
      isoSelfCheck: baseIso,
      go: { status: 200, body: { ok: true, session_id: "gate-001", cookies_injected: 17 } },
    });
    expect(meta).toHaveProperty("cookies_injected", 17);
  });

  it("renders cookies_injected: null when go was NOT called (cache short-circuit path, go=null)", () => {
    const meta = buildCaptureMeta({
      cb: {}, eps: [{ endpoint_id: "cached" }], sb: {}, evalRes: { body: {} },
      skillId: "sk_cached", isoSelfCheck: baseIso, go: null,
    });
    expect(meta).toHaveProperty("cookies_injected", null);
  });

  it("renders cookies_injected: null when go was called but the field is absent (cookiesInjected===0 in routes.ts)", () => {
    // src/api/routes.ts only emits `cookies_injected` when result.cookiesInjected > 0.
    // The 0 case must surface as null, NOT undefined or missing — the in-thread
    // judge reads this as raw evidence.
    const meta = buildCaptureMeta({
      cb: { indexed: false }, eps: [], sb: {}, evalRes: { body: {} },
      skillId: null, isoSelfCheck: baseIso,
      go: { status: 200, body: { ok: true, session_id: "gate-002" } },
    });
    expect(meta).toHaveProperty("cookies_injected", null);
  });

  it("renders cookies_injected: null when go failed (non-200 path that sets _go_failed)", () => {
    const meta = buildCaptureMeta({
      cb: { _go_failed: { error: "create_failed" } }, eps: [], sb: {}, evalRes: { body: {} },
      skillId: null, isoSelfCheck: baseIso,
      go: { status: 500, body: { error: "create_failed" } },
    });
    expect(meta).toHaveProperty("cookies_injected", null);
  });

  it("0 cookies injected is surfaced as 0 (NOT collapsed to null by ??)", () => {
    // If a future routes.ts emits the field unconditionally with a 0 count, the
    // collector must passthrough as 0 — ??-coalescing only fires on null/undefined.
    const meta = buildCaptureMeta({
      cb: {}, eps: [], sb: {}, evalRes: { body: {} }, skillId: null, isoSelfCheck: baseIso,
      go: { status: 200, body: { session_id: "gate-003", cookies_injected: 0 } },
    });
    expect(meta).toHaveProperty("cookies_injected", 0);
  });

  it("preserves all existing capture.meta.json fields (no regression of F5 sibling fields)", () => {
    const meta = buildCaptureMeta({
      cb: { indexed: true, endpoint_count: 3, request_count: 9, mode: "live_capture", capture_diagnostic: null },
      eps: [{ endpoint_id: "e1" }, { endpoint_id: "e2" }],
      sb: { page_title: "Home" },
      evalRes: { body: {} },
      skillId: "sk_real",
      isoSelfCheck: { snap_current_url: "https://x.com/", intended_host: "x.com", snap_host: "x.com", host_match: true },
      go: { status: 200, body: { cookies_injected: 5 } },
    });
    expect(meta.total_endpoints_captured).toBe(3);
    expect(meta.n_operations).toBe(2);
    expect(meta.captured_title).toBe("Home");
    expect(meta.indexed).toBe(true);
    expect(meta.mode).toBe("live_capture");
    expect(meta.skill_id).toBe("sk_real");
    expect(meta.request_count).toBe(9);
    expect(meta.capture_diagnostic).toBe(null);
    expect((meta.iso_self_check as any).host_match).toBe(true);
    expect(meta.cookies_injected).toBe(5);
  });
});
