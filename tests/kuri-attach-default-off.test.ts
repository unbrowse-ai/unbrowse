// Falsifier for the kuri attach-to-existing-Chrome default.
//
// Default is ON: the agent should ride the user's browser/session unless a
// caller explicitly requests clean-room isolation. CI/bench paths opt out with
// KURI_DISABLE_CDP_ATTACH, KURI_CLEAN_ROOM, or UNBROWSE_LOCAL_ONLY.
import { describe, expect, it } from "bun:test";
import { resolveKuriLaunchConfig } from "../src/kuri/client.ts";

describe("resolveKuriLaunchConfig — attachToExistingChrome default ON", () => {
  it("empty env → attach ON (agent default)", () => {
    const cfg = resolveKuriLaunchConfig({});
    expect(cfg.attachToExistingChrome).toBe(true);
    expect(cfg.headless).toBe(true);
  });

  it("KURI_ATTACH_EXISTING_CHROME=0 → attach OFF", () => {
    const cfg = resolveKuriLaunchConfig({ KURI_ATTACH_EXISTING_CHROME: "0" });
    expect(cfg.attachToExistingChrome).toBe(false);
  });

  it("KURI_ATTACH_EXISTING_CHROME=false → attach OFF", () => {
    const cfg = resolveKuriLaunchConfig({ KURI_ATTACH_EXISTING_CHROME: "false" });
    expect(cfg.attachToExistingChrome).toBe(false);
  });

  it("KURI_ATTACH_EXISTING_CHROME=1 keeps attach ON", () => {
    const cfg = resolveKuriLaunchConfig({ KURI_ATTACH_EXISTING_CHROME: "1" });
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
    expect(cfg.attachToExistingChrome).toBe(true);
  });
});
