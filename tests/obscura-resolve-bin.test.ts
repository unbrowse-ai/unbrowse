/**
 * GATE: the obscura binaries resolve with the right precedence and no host
 * assumptions. Pure path logic — no filesystem, no spawn — so it runs anywhere.
 */

import { test, expect, describe } from "bun:test";
import {
  obscuraBinaryName,
  obscuraTargetKey,
  obscuraEnvVar,
  obscuraVendorCandidatePaths,
  firstExisting,
} from "../src/obscura/resolve-bin.js";

describe("obscuraBinaryName", () => {
  test("adds .exe only on win32", () => {
    expect(obscuraBinaryName("obscura", "linux")).toBe("obscura");
    expect(obscuraBinaryName("obscura-capture", "darwin")).toBe("obscura-capture");
    expect(obscuraBinaryName("obscura", "win32")).toBe("obscura.exe");
  });
});

describe("obscuraTargetKey", () => {
  test("maps supported platform/arch pairs", () => {
    expect(obscuraTargetKey("linux", "x64")).toBe("linux-x64");
    expect(obscuraTargetKey("linux", "arm64")).toBe("linux-arm64");
    expect(obscuraTargetKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(obscuraTargetKey("darwin", "x64")).toBe("darwin-x64");
    expect(obscuraTargetKey("win32", "x64")).toBe("win-x64");
  });
  test("returns null for unsupported combos", () => {
    expect(obscuraTargetKey("linux", "ia32")).toBeNull();
    expect(obscuraTargetKey("freebsd", "x64")).toBeNull();
  });
});

describe("obscuraEnvVar", () => {
  test("distinct override var per binary", () => {
    expect(obscuraEnvVar("obscura")).toBe("UNBROWSE_OBSCURA_BIN");
    expect(obscuraEnvVar("obscura-capture")).toBe("UNBROWSE_OBSCURA_CAPTURE_BIN");
  });
});

describe("obscuraVendorCandidatePaths", () => {
  test("env override wins and is first", () => {
    const paths = obscuraVendorCandidatePaths({
      bin: "obscura-capture",
      execDir: "/opt/unbrowse",
      moduleDir: "/opt/unbrowse/src/capture",
      platform: "linux",
      arch: "x64",
      env: { UNBROWSE_OBSCURA_CAPTURE_BIN: "/custom/obscura-capture" },
    });
    expect(paths[0]).toBe("/custom/obscura-capture");
  });

  test("without override: execDir, then vendor trees, then bare name last", () => {
    const paths = obscuraVendorCandidatePaths({
      bin: "obscura",
      execDir: "/opt/unbrowse",
      moduleDir: "/opt/unbrowse/src/capture",
      platform: "linux",
      arch: "x64",
      env: {},
    });
    expect(paths[0]).toBe("/opt/unbrowse/obscura");
    expect(paths.some((p) => p.includes("vendor/obscura/linux-x64/obscura"))).toBe(true);
    expect(paths.some((p) => p.includes("packages/skill/vendor/obscura/linux-x64/obscura"))).toBe(true);
    expect(paths[paths.length - 1]).toBe("obscura"); // PATH fallback
  });

  test("no vendor paths when target unsupported", () => {
    const paths = obscuraVendorCandidatePaths({
      bin: "obscura",
      execDir: "/opt/unbrowse",
      moduleDir: "/opt/unbrowse/src/capture",
      platform: "freebsd",
      arch: "x64",
      env: {},
    });
    expect(paths.some((p) => p.includes("vendor/obscura"))).toBe(false);
  });
});

describe("firstExisting", () => {
  test("returns the first candidate that exists", () => {
    const exists = (p: string) => p === "/b" || p === "/c";
    expect(firstExisting(["/a", "/b", "/c"], exists)).toBe("/b");
    expect(firstExisting(["/a", null, undefined], exists)).toBeNull();
  });
});
