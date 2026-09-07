// Witness for Lever B (2026-06-20): the pre-resolve auth gate must consult the
// MULTI-BROWSER credential harvest (Dia/Arc/Brave/...) before bouncing the user to
// an interactive login. Before the fix, a session living in any browser other than
// Chrome/Firefox read as source="none" -> auth_required, even though the runtime
// could already harvest it.
//
// Run: bun test tests/auth-gate-harvest.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHarvestFallback,
  decidePreResolveAuthGate,
  hasFreshCookieForHost,
  type CookieFreshness,
} from "../src/auth/pre-resolve-gate.js";

const NONE: CookieFreshness = { fresh: false, source: "none", reason: "chrome/firefox empty" };

// A real probe script that deterministically reports "none" (chrome/firefox empty),
// so the wiring tests exercise the harvest fallback path, not a python-error path.
let NONE_EMITTER: string;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-"));
  NONE_EMITTER = join(dir, "none_emitter.py");
  writeFileSync(NONE_EMITTER, 'import json;print(json.dumps({"fresh":False,"source":"none","reason":"chrome/firefox empty"}))');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("auth gate consults the multi-browser harvest", () => {
  test("source=none is upgraded to fresh when a daily-driver browser has a session", () => {
    const out = applyHarvestFallback(NONE, "x.com", () => ({ browser: "Dia", sessionCookies: 13 }));
    expect(out.fresh).toBe(true);
    expect(out.source).toBe("browser");
    expect(out.reason).toContain("Dia");
  });

  test("no session anywhere -> stays none (still bounces to login)", () => {
    const out = applyHarvestFallback(NONE, "x.com", () => null);
    expect(out.fresh).toBe(false);
    expect(out.source).toBe("none");
  });

  test("a real chrome/firefox hit is never overridden by the fallback", () => {
    const fresh: CookieFreshness = { fresh: true, source: "chrome", reason: "" };
    const out = applyHarvestFallback(fresh, "x.com", () => ({ browser: "Dia", sessionCookies: 99 }));
    expect(out.source).toBe("chrome"); // pass-through, no override
  });

  test("hasFreshCookieForHost wires the harvest: injected Dia session -> fresh", () => {
    // script_path missing forces the no-python branch, which still runs the harvest.
    const out = hasFreshCookieForHost("x.com", {
      script_path: NONE_EMITTER,
      session_scan: () => ({ browser: "Dia", sessionCookies: 13 }),
    });
    expect(out.fresh).toBe(true);
    expect(out.source).toBe("browser");
  });

  test("end-to-end gate PASSES (no auth_required) when the harvest finds a session", () => {
    // Chrome/Firefox empty (source=none), but Dia has a session -> harvest upgrades -> pass.
    const decision = decidePreResolveAuthGate("get my x bookmarks", "https://x.com/i/bookmarks", {
      cookie_probe: (host) => applyHarvestFallback(NONE, host, () => ({ browser: "Dia", sessionCookies: 13 })),
    });
    expect(decision.gate).toBe("pass");
  });

  test("gate STILL bounces to auth_required when no browser has a session", () => {
    const decision = decidePreResolveAuthGate("get my x bookmarks", "https://x.com/i/bookmarks", {
      cookie_probe: (host) => applyHarvestFallback(NONE, host, () => null),
    });
    expect(decision.gate).toBe("auth_required");
  });
});
