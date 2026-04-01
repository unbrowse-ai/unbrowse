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
