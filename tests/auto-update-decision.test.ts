/**
 * auto-update-decision.test — the pure auto-update gate (no network/fs/clock).
 */
import { describe, expect, it } from "bun:test";
import { shouldAutoUpdate, shouldSpawnBackgroundUpdateCheck } from "../src/runtime/update-hints.js";

const base = {
  hasUpdate: true,
  method: "npm-global" as const,
  disabled: false,
  nowMs: 1_000_000_000,
  intervalMs: 12 * 60 * 60 * 1000,
};

describe("shouldAutoUpdate", () => {
  it("updates when an npm-global install is behind and not throttled", () => {
    expect(shouldAutoUpdate(base)).toEqual({ update: true, reason: "applying" });
  });
  it("skips when disabled (opt-out / CI)", () => {
    expect(shouldAutoUpdate({ ...base, disabled: true }).update).toBe(false);
  });
  it("skips when already up-to-date", () => {
    expect(shouldAutoUpdate({ ...base, hasUpdate: false }).reason).toBe("up-to-date");
  });
  it("never auto-reinstalls a repo-clone or unknown install", () => {
    expect(shouldAutoUpdate({ ...base, method: "repo-clone" }).update).toBe(false);
    expect(shouldAutoUpdate({ ...base, method: "unknown" }).update).toBe(false);
  });
  it("throttles a recent attempt", () => {
    const recent = new Date(base.nowMs - 60_000).toISOString();
    expect(shouldAutoUpdate({ ...base, lastAttemptAt: recent }).reason).toBe("throttled");
  });
  it("allows again once the interval has elapsed", () => {
    const old = new Date(base.nowMs - 13 * 60 * 60 * 1000).toISOString();
    expect(shouldAutoUpdate({ ...base, lastAttemptAt: old }).update).toBe(true);
  });
});

// The every-command background-check gate: decides whether a normal CLI
// invocation should spawn a detached self-update checker. This is what makes the
// CLI keep itself current for EVERY user (not just hosts with the SessionStart
// hook). Pure: no network/fs/clock.
const sbase = {
  command: "get",
  disabled: false,
  lastSpawnAtMs: null as number | null,
  nowMs: 1_000_000_000,
  intervalMs: 12 * 60 * 60 * 1000,
};

describe("shouldSpawnBackgroundUpdateCheck", () => {
  it("spawns on a normal command when enabled and never checked", () => {
    const r = shouldSpawnBackgroundUpdateCheck(sbase);
    expect(r.spawn).toBe(true);
    expect(r.reason).toBe("due");
  });
  it("never spawns for fast / lifecycle / self commands", () => {
    for (const command of ["upgrade", "update", "health", "mcp", "serve", "setup", "help"]) {
      const r = shouldSpawnBackgroundUpdateCheck({ ...sbase, command });
      expect(r.spawn).toBe(false);
      expect(r.reason).toBe(`command:${command}`);
    }
  });
  it("skips when disabled (opt-out / CI)", () => {
    expect(shouldSpawnBackgroundUpdateCheck({ ...sbase, disabled: true })).toEqual({ spawn: false, reason: "disabled" });
  });
  it("throttles a recent spawn", () => {
    const r = shouldSpawnBackgroundUpdateCheck({ ...sbase, lastSpawnAtMs: sbase.nowMs - 60_000 });
    expect(r).toEqual({ spawn: false, reason: "throttled" });
  });
  it("spawns again once the interval has elapsed", () => {
    const r = shouldSpawnBackgroundUpdateCheck({ ...sbase, lastSpawnAtMs: sbase.nowMs - 13 * 60 * 60 * 1000 });
    expect(r.spawn).toBe(true);
  });
});
