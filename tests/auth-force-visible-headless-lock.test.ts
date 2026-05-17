// forceVisibleKuriEnv must respect a hard-headless lock. The function flips
// HEADLESS/KURI_HEADLESS/KURI_DISABLE_CDP_ATTACH on the passed env so an
// interactive-login or anti-bot-fallback can pop a visible browser. That env
// is process-global by default, so under the per-session-Kuri concurrency
// (gate collector at conc>1) one probe's visible flip poisoned every other
// concurrent session's headless setting (proven 2026-05-17: 40/58 sessions
// launched VISIBLE Chrome during a conc=16 run with auth-gated + hostile
// probes).
//
// Contract: when env.UNBROWSE_FORCE_HEADLESS is truthy, forceVisibleKuriEnv
// is a NO-OP (env untouched, restore is a no-op) so a declared headless
// workload can never be flipped visible by a concurrent caller. When the
// lock is absent (a real `unbrowse login`), behavior is unchanged: it flips
// to visible and the returned closure restores the prior values.
//
// Real code path: the real exported forceVisibleKuriEnv driven against a
// plain env object (the function already accepts an env arg). No mocks, no
// spawn, no process.env mutation.

import { describe, expect, it } from "bun:test";
import { forceVisibleKuriEnv } from "../src/auth/index.js";

describe("forceVisibleKuriEnv hard-headless lock", () => {
  it("no lock: flips env to visible and the closure restores prior state", () => {
    const env: NodeJS.ProcessEnv = { HEADLESS: "true" };
    const restore = forceVisibleKuriEnv(env);
    expect(env.HEADLESS).toBe("false");
    expect(env.KURI_HEADLESS).toBe("false");
    expect(env.KURI_DISABLE_CDP_ATTACH).toBe("1");
    restore();
    expect(env.HEADLESS).toBe("true");
    // KURI_HEADLESS / KURI_DISABLE_CDP_ATTACH were undefined before, so the
    // restore must delete them rather than leave "false"/"1" behind.
    expect(env.KURI_HEADLESS).toBeUndefined();
    expect(env.KURI_DISABLE_CDP_ATTACH).toBeUndefined();
  });

  it("lock set (=1): NO-OP, env headless is never flipped", () => {
    const env: NodeJS.ProcessEnv = {
      UNBROWSE_FORCE_HEADLESS: "1",
      HEADLESS: "true",
    };
    const restore = forceVisibleKuriEnv(env);
    expect(env.HEADLESS).toBe("true");
    expect(env.KURI_HEADLESS).toBeUndefined();
    expect(env.KURI_DISABLE_CDP_ATTACH).toBeUndefined();
    // restore is a no-op and must not introduce the visible values either.
    restore();
    expect(env.HEADLESS).toBe("true");
    expect(env.KURI_HEADLESS).toBeUndefined();
  });

  it("lock set (=true): also a NO-OP (truthy parse parity with the launcher)", () => {
    const env: NodeJS.ProcessEnv = { UNBROWSE_FORCE_HEADLESS: "true" };
    const restore = forceVisibleKuriEnv(env);
    expect(env.HEADLESS).toBeUndefined();
    expect(env.KURI_HEADLESS).toBeUndefined();
    restore();
    expect(env.HEADLESS).toBeUndefined();
  });
});
