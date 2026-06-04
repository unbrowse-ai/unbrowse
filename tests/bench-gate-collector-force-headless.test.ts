// Bench-gate collector must hard-lock headless via UNBROWSE_FORCE_HEADLESS=1
// BEFORE getInProcessApp() spawns, so the kuri client picks it up and the
// platform-internal anti-bot retry in src/execution/index.ts:1605 stays a
// no-op (per forceVisibleKuriEnv's hard-headless contract).
//
// This is a structural test: it reads the real source files and asserts the
// FORCE_HEADLESS line is present in the collector source, positioned BEFORE
// the `await getInProcessApp()` call, and the stale "pop a Chrome window"
// stderr in the execution path is gone.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

describe("bench-gate collector force-headless pin", () => {
  it("scripts/mcp-gate-parallel-collect.ts sets UNBROWSE_FORCE_HEADLESS=1 before getInProcessApp() runs", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/mcp-gate-parallel-collect.ts"), "utf8");
    const forceLine = src.indexOf('process.env.UNBROWSE_FORCE_HEADLESS = "1"');
    const appCall = src.indexOf("await getInProcessApp()");
    expect(forceLine).toBeGreaterThan(-1);
    expect(appCall).toBeGreaterThan(-1);
    expect(forceLine).toBeLessThan(appCall);
  });

  it("src/execution/index.ts no longer claims a Chrome window will pop", () => {
    const src = readFileSync(join(REPO_ROOT, "src/execution/index.ts"), "utf8");
    expect(src).not.toMatch(/pop a Chrome window/);
    expect(src).toMatch(/UNBROWSE_ALLOW_VISIBLE_AUTH_FALLBACK/);
  });
});
