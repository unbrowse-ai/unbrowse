/**
 * The vendored obscura binaries must be findable from source AND packaged.
 *
 * They were not. The candidate list walked exactly one directory up from the
 * calling module, which is correct for the packaged layout (`runtime/../vendor`)
 * and one level short from source (`src/capture/../vendor` → `src/vendor`, which
 * does not exist). Every source-run candidate missed, resolution fell through to
 * a bare PATH lookup, and obscura capture died with:
 *
 *   Executable not found in $PATH: "obscura-capture"
 *
 * — with an 81MB binary sitting at <repo>/vendor/obscura/linux-x64/ the whole
 * time. That single wrong depth is why "obscura is wired" and "obscura runs"
 * were different facts, and why nothing on this machine had ever exercised it.
 *
 * Pure path arithmetic: no binary, no spawn, no network.
 */
import { describe, expect, test } from "bun:test";
import { obscuraVendorCandidatePaths } from "../src/obscura/resolve-bin.js";

const opts = {
  bin: "obscura-capture" as const,
  execDir: "/opt/bun/bin",
  platform: "linux",
  arch: "x64",
  env: {} as Record<string, string | undefined>,
};

describe("vendored binaries are reachable from every real layout", () => {
  test("from source — src/<area>/ finds <repo>/vendor", () => {
    const c = obscuraVendorCandidatePaths({ ...opts, moduleDir: "/repo/src/capture" });
    expect(c).toContain("/repo/vendor/obscura/linux-x64/obscura-capture");
  });

  test("from a deeper source dir — src/<a>/<b>/ still finds <repo>/vendor", () => {
    const c = obscuraVendorCandidatePaths({ ...opts, moduleDir: "/repo/src/lib/indexer-core" });
    expect(c).toContain("/repo/vendor/obscura/linux-x64/obscura-capture");
  });

  test("packaged — runtime/ finds the package vendor dir (the case that already worked)", () => {
    const c = obscuraVendorCandidatePaths({ ...opts, moduleDir: "/pkg/runtime" });
    expect(c).toContain("/pkg/vendor/obscura/linux-x64/obscura-capture");
  });

  test("the packages/skill layout is covered at every depth too", () => {
    const c = obscuraVendorCandidatePaths({ ...opts, moduleDir: "/repo/src/capture" });
    expect(c).toContain("/repo/packages/skill/vendor/obscura/linux-x64/obscura-capture");
  });
});

describe("resolution order and bounds", () => {
  test("an explicit env override outranks every vendored path", () => {
    const c = obscuraVendorCandidatePaths({
      ...opts,
      moduleDir: "/repo/src/capture",
      env: { UNBROWSE_OBSCURA_CAPTURE_BIN: "/custom/obscura-capture" },
    });
    expect(c[0]).toBe("/custom/obscura-capture");
  });

  test("a bare PATH name remains the LAST resort, never the first", () => {
    const c = obscuraVendorCandidatePaths({ ...opts, moduleDir: "/repo/src/capture" });
    expect(c[c.length - 1]).toBe("obscura-capture");
    expect(c.indexOf("obscura-capture")).toBe(c.length - 1);
  });

  test("the upward walk is BOUNDED — never escapes to the filesystem root", () => {
    // An unbounded walk would happily propose /vendor/... and, worse, keep
    // climbing past the project on a shallow moduleDir.
    const c = obscuraVendorCandidatePaths({ ...opts, moduleDir: "/a/b/c/d/e/f/g" });
    expect(c).not.toContain("/vendor/obscura/linux-x64/obscura-capture");
    expect(c.every((p) => p === "obscura-capture" || p.startsWith("/"))).toBe(true);
  });

  test("no duplicate candidates — each path is probed once", () => {
    const c = obscuraVendorCandidatePaths({ ...opts, moduleDir: "/repo/src/capture" });
    expect(new Set(c).size).toBe(c.length);
  });
});
