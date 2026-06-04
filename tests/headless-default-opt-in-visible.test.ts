// FALSIFIER for the headless-by-default policy flip (2026-05-19).
//
// Pre-fix: forceVisibleKuriEnv was opt-OUT. Anti-bot detection in
// src/execution/index.ts:1594 auto-flipped HEADLESS=false on every
// caller, and one probe's flip poisoned every concurrent session's
// env. Users saw visible Chrome windows pop up during bench-gate runs,
// CLI scripts, MCP tool calls — anything that hit a captcha trigger.
//
// Post-fix: forceVisibleKuriEnv is a NO-OP by default. Two opt-in
// paths:
//   1. Caller passes { allow: true } — e.g. interactiveLogin.
//   2. Env UNBROWSE_ALLOW_VISIBLE_AUTH_FALLBACK=1 — platform escape
//      hatch that doesn't require code changes.
// Legacy UNBROWSE_FORCE_HEADLESS=1 still trumps both (hard lock).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forceVisibleKuriEnv } from "../src/auth/index";

describe("forceVisibleKuriEnv: headless is the default", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    env = {};
  });

  test("no opts + no env → NO-OP (env stays untouched, restore is identity)", () => {
    const restore = forceVisibleKuriEnv(env);
    expect(env.HEADLESS).toBeUndefined();
    expect(env.KURI_HEADLESS).toBeUndefined();
    expect(env.KURI_DISABLE_CDP_ATTACH).toBeUndefined();
    restore();
    expect(env.HEADLESS).toBeUndefined();
  });

  test("explicit { allow: true } flips env to visible (interactiveLogin path)", () => {
    const restore = forceVisibleKuriEnv(env, { allow: true });
    expect(env.HEADLESS).toBe("false");
    expect(env.KURI_HEADLESS).toBe("false");
    expect(env.KURI_DISABLE_CDP_ATTACH).toBe("1");
    restore();
    expect(env.HEADLESS).toBeUndefined();
    expect(env.KURI_HEADLESS).toBeUndefined();
    expect(env.KURI_DISABLE_CDP_ATTACH).toBeUndefined();
  });

  test("env UNBROWSE_ALLOW_VISIBLE_AUTH_FALLBACK=1 flips env to visible", () => {
    env.UNBROWSE_ALLOW_VISIBLE_AUTH_FALLBACK = "1";
    const restore = forceVisibleKuriEnv(env);
    expect(env.HEADLESS).toBe("false");
    restore();
    expect(env.HEADLESS).toBeUndefined();
  });

  test("UNBROWSE_FORCE_HEADLESS=1 hard-trumps allow:true (gate-collector contract)", () => {
    env.UNBROWSE_FORCE_HEADLESS = "1";
    const restore = forceVisibleKuriEnv(env, { allow: true });
    expect(env.HEADLESS).toBeUndefined();
    restore();
    expect(env.HEADLESS).toBeUndefined();
  });

  test("UNBROWSE_FORCE_HEADLESS=1 hard-trumps the visible-fallback env too", () => {
    env.UNBROWSE_FORCE_HEADLESS = "1";
    env.UNBROWSE_ALLOW_VISIBLE_AUTH_FALLBACK = "1";
    const restore = forceVisibleKuriEnv(env);
    expect(env.HEADLESS).toBeUndefined();
    restore();
  });

  test("preexisting HEADLESS=true is preserved through opt-in flip + restore", () => {
    env.HEADLESS = "true";
    const restore = forceVisibleKuriEnv(env, { allow: true });
    expect(env.HEADLESS).toBe("false"); // during the visible window
    restore();
    expect(env.HEADLESS).toBe("true"); // restored to the prior value
  });

  test("anti-bot retry path in execution/index.ts can no longer flip env without opt-in", () => {
    // The retry path at src/execution/index.ts:1594 calls
    // forceVisibleKuriEnv() with no opts. With the flip, that's a no-op.
    const restore = forceVisibleKuriEnv(env);
    expect(env.HEADLESS).toBeUndefined();
    restore();
  });
});

describe("interactiveLogin opts into visible explicitly", () => {
  test("auth/index.ts:298 passes { allow: true }", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(import.meta.dir, "..", "src", "auth", "index.ts"), "utf8");
    expect(src).toMatch(/forceVisibleKuriEnv\([^)]*\{\s*allow:\s*true\s*\}/);
  });
});
