// Falsifier for the kuri attach-to-existing-Chrome default flip.
//
// Pre-flip: `resolveKuriLaunchConfig` had `attachToExistingChrome = true`
// by default (any of KURI_DISABLE_CDP_ATTACH / UNBROWSE_LOCAL_ONLY /
// KURI_CLEAN_ROOM / settings.browser.attach_existing_chrome=false
// were opt-OUTs). Risk: if the user has Chrome running with CDP on
// :9222 (Claude Code / VS Code / a debugger) kuri silently attached to
// that visible Chrome instead of launching its own managed headless
// one — even when HEADLESS=true was explicitly set, because the
// headless flag only affects MANAGED Chrome, not attached Chrome.
// Bench-gate runs, CI, automated capture, anything reproducible got
// silently coupled to the user's real browser.
//
// Post-flip: default OFF. Attach happens only when explicitly opted-in
// via env KURI_ATTACH_EXISTING_CHROME=1 OR persisted setting
// browser.attach_existing_chrome=true. The clean-managed-headless
// path is the safe default.
import { describe, expect, it } from "bun:test";
import { resolveKuriLaunchConfig } from "../src/kuri/client.ts";

describe("resolveKuriLaunchConfig — attachToExistingChrome default OFF (post-flip)", () => {
  it("empty env → attach OFF (the new safe default)", () => {
    const cfg = resolveKuriLaunchConfig({});
    expect(cfg.attachToExistingChrome).toBe(false);
    expect(cfg.headless).toBe(true);
  });

  it("KURI_ATTACH_EXISTING_CHROME=1 → attach ON", () => {
    const cfg = resolveKuriLaunchConfig({ KURI_ATTACH_EXISTING_CHROME: "1" });
    expect(cfg.attachToExistingChrome).toBe(true);
  });

  it("KURI_ATTACH_EXISTING_CHROME=true → attach ON", () => {
    const cfg = resolveKuriLaunchConfig({ KURI_ATTACH_EXISTING_CHROME: "true" });
    expect(cfg.attachToExistingChrome).toBe(true);
  });

  it("KURI_CLEAN_ROOM=1 trumps attach opt-in (clean-room always wins)", () => {
    const cfg = resolveKuriLaunchConfig({
      KURI_ATTACH_EXISTING_CHROME: "1",
      KURI_CLEAN_ROOM: "1",
    });
    expect(cfg.attachToExistingChrome).toBe(false);
  });

  it("UNBROWSE_LOCAL_ONLY=1 trumps attach opt-in", () => {
    const cfg = resolveKuriLaunchConfig({
      KURI_ATTACH_EXISTING_CHROME: "1",
      UNBROWSE_LOCAL_ONLY: "1",
    });
    expect(cfg.attachToExistingChrome).toBe(false);
  });

  it("KURI_DISABLE_CDP_ATTACH=1 trumps attach opt-in", () => {
    const cfg = resolveKuriLaunchConfig({
      KURI_ATTACH_EXISTING_CHROME: "1",
      KURI_DISABLE_CDP_ATTACH: "1",
    });
    expect(cfg.attachToExistingChrome).toBe(false);
  });

  it("HEADLESS=false stays an explicit choice and is independent of attach", () => {
    const cfg = resolveKuriLaunchConfig({ HEADLESS: "false" });
    expect(cfg.headless).toBe(false);
    expect(cfg.attachToExistingChrome).toBe(false); // still default OFF
  });
});
