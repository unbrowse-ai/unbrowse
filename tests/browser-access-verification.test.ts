import { describe, it, expect } from "bun:test";

// Task 1: Verify BrowserAccessConfig is imported and used in capture/index.ts
describe("BrowserAccessConfig wiring in capture", () => {
  it("imports BrowserAccessConfig from runtime/browser-access", async () => {
    const captureSource = await Bun.file(
      new URL("../src/capture/index.ts", import.meta.url).pathname
    ).text();
    expect(captureSource).toContain("BrowserAccessConfig");
    expect(captureSource).toContain("browser-access");
  });

  it("exports isBrowserAccessAvailable that checks config", async () => {
    const { isBrowserAccessAvailable } = await import("../src/capture/index.js");
    expect(typeof isBrowserAccessAvailable).toBe("function");
  });

  it("isBrowserAccessAvailable returns true for default unbrowse path", async () => {
    const { isBrowserAccessAvailable } = await import("../src/capture/index.js");
    const { DEFAULT_BROWSER_ACCESS } = await import("../src/runtime/browser-access.js");
    const result = isBrowserAccessAvailable(DEFAULT_BROWSER_ACCESS);
    expect(result).toBe(true);
  });

  it("isBrowserAccessAvailable returns false for proxy-only config", async () => {
    const { isBrowserAccessAvailable } = await import("../src/capture/index.js");
    const result = isBrowserAccessAvailable({
      default_path: "proxy",
      fallback_path: "proxy",
      supported_frameworks: [],
    });
    expect(result).toBe(false);
  });
});

// Task 2: Verify computeVerificationCoverage is wired into verification/index.ts
describe("computeVerificationCoverage wiring in verification", () => {
  it("imports computeVerificationCoverage from matrix module", async () => {
    const verificationSource = await Bun.file(
      new URL("../src/verification/index.ts", import.meta.url).pathname
    ).text();
    expect(verificationSource).toContain("computeVerificationCoverage");
    expect(verificationSource).toContain("matrix");
  });

  it("verifySkill result includes coverage field", async () => {
    // We import the type/function to confirm it's wired
    const mod = await import("../src/verification/index.js");
    expect(typeof mod.verifySkillWithCoverage).toBe("function");
  });
});

// Task 3: Verify source modules export correctly (no mock, real imports)
describe("real source imports", () => {
  it("browser-access exports BrowserAccessConfig and DEFAULT_BROWSER_ACCESS", async () => {
    const mod = await import("../src/runtime/browser-access.js");
    expect(mod.DEFAULT_BROWSER_ACCESS).toBeDefined();
    expect(mod.DEFAULT_BROWSER_ACCESS.default_path).toBe("unbrowse");
    expect(mod.DEFAULT_BROWSER_ACCESS.fallback_path).toBe("direct");
    expect(Array.isArray(mod.DEFAULT_BROWSER_ACCESS.supported_frameworks)).toBe(true);
  });

  it("matrix exports computeVerificationCoverage and INITIAL_MATRIX", async () => {
    const mod = await import("../src/verification/matrix.js");
    expect(typeof mod.computeVerificationCoverage).toBe("function");
    expect(Array.isArray(mod.INITIAL_MATRIX)).toBe(true);
  });

  it("computeVerificationCoverage returns correct ratio", async () => {
    const { computeVerificationCoverage } = await import("../src/verification/matrix.js");
    const matrix = [
      { host: "a", capability: "x", status: "pass" as const },
      { host: "b", capability: "y", status: "untested" as const },
    ];
    expect(computeVerificationCoverage(matrix)).toBe(0.5);
  });

  it("computeVerificationCoverage returns 0 for empty matrix", async () => {
    const { computeVerificationCoverage } = await import("../src/verification/matrix.js");
    expect(computeVerificationCoverage([])).toBe(0);
  });

  it("computeVerificationCoverage returns 1 for fully tested matrix", async () => {
    const { computeVerificationCoverage } = await import("../src/verification/matrix.js");
    const matrix = [
      { host: "a", capability: "x", status: "pass" as const },
      { host: "b", capability: "y", status: "fail" as const },
      { host: "c", capability: "z", status: "skip" as const },
    ];
    expect(computeVerificationCoverage(matrix)).toBe(1);
  });
});

describe("fail-closed Chromium capability policy", () => {
  it("distinguishes unsupported browser, missing Chromium, missing runtime, and missing auth", async () => {
    const { evaluateBrowserCapability } = await import("../src/runtime/browser-access.js");
    const base = { operation: "capture" as const, chromium_available: true, browser_runtime_available: true };

    expect(evaluateBrowserCapability({ ...base, browser: "firefox" })).toMatchObject({ status: "unavailable", reason: "unsupported_browser" });
    expect(evaluateBrowserCapability({ ...base, chromium_available: false })).toMatchObject({ status: "unavailable", reason: "chromium_unavailable" });
    expect(evaluateBrowserCapability({ ...base, browser_runtime_available: false })).toMatchObject({ status: "unavailable", reason: "chromium_cdp_unavailable" });
    expect(evaluateBrowserCapability({ ...base, chromium_cdp_available: false })).toMatchObject({ status: "unavailable", reason: "chromium_cdp_unavailable" });
    expect(evaluateBrowserCapability({ ...base, kuri_required: true, kuri_sandbox_available: false })).toMatchObject({ status: "unavailable", reason: "kuri_sandbox_unavailable" });
    expect(evaluateBrowserCapability({ ...base, requires_auth: true, auth_available: false })).toMatchObject({ status: "auth_required", reason: "auth_required" });
    expect(evaluateBrowserCapability(base)).toEqual({ status: "supported", operation: "capture", browser: "chromium" });
  });

  it("never recommends a recovery path the host cannot run", async () => {
    const { browserRecovery } = await import("../src/runtime/browser-access.js");
    expect(browserRecovery("auth_required", { chromium_available: false, chromium_cdp_available: false })).toEqual({ reason: "auth_required", retryable: false });
    expect(browserRecovery("session_expired", { chromium_available: true, chromium_cdp_available: true }).next_step).toContain("unbrowse auth");
    expect(browserRecovery("kuri_sandbox_unavailable", { chromium_available: true, chromium_cdp_available: true, kuri_sandbox_available: false }).next_step).toBeUndefined();
  });

  it("labels static DOM and stealth as unevaluated and best-effort", async () => {
    const { browserTruthBoundary, browserTruthSatisfiesIntent, intentRequiresEvaluatedJavascript } = await import("../src/runtime/browser-access.js");
    expect(browserTruthBoundary({ javascriptEvaluated: false, javascriptRequired: true, stealthAttempted: true })).toEqual({
      truth_mode: "static_unevaluated", javascript_required: true, stealth: "best_effort", stealth_guaranteed: false,
    });
    expect(intentRequiresEvaluatedJavascript("check the Sannysoft webdriver fingerprint results")).toBe(true);
    expect(intentRequiresEvaluatedJavascript("read the article title")).toBe(false);
    expect(browserTruthSatisfiesIntent(browserTruthBoundary({ javascriptEvaluated: false, javascriptRequired: true }))).toBe(false);
    expect(browserTruthSatisfiesIntent(browserTruthBoundary({ javascriptEvaluated: true, javascriptRequired: true }))).toBe(true);
  });

  it("delivers explicit bearer auth directly and distinguishes acceptance", async () => {
    const { directAuthorizedRead } = await import("../src/runtime/browser-access.js");
    const accepted = await directAuthorizedRead("https://example.test/read", { bearerToken: "secret" }, async (_url: any, init: any) =>
      new Response(init.headers.get("authorization") === "Bearer secret" ? "ok" : "missing", { status: 200 })
    );
    expect(accepted).toMatchObject({ ok: true, auth_outcome: "presented_accepted" });
    const rejected = await directAuthorizedRead("https://example.test/read", { headers: { authorization: "bad" } }, async () =>
      new Response("no", { status: 401 })
    );
    expect(rejected).toMatchObject({ ok: false, auth_outcome: "presented_rejected", reason: "session_expired" });
  });

  it("resolves only paths that are verified to exist", async () => {
    const { resolveChromiumAvailability } = await import("../src/runtime/browser-host.js");
    expect(resolveChromiumAvailability({ headless: true, binary_path: "/chosen/chrome" }, (path: string) => path === "/chosen/chrome"))
      .toEqual({ available: true, binary_path: "/chosen/chrome" });
    expect(resolveChromiumAvailability({ headless: true }, () => false))
      .toEqual({ available: false, reason: "chromium_unavailable" });
  });
});
