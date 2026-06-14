/**
 * auto-update-decision.test — the pure auto-update gate (no network/fs/clock).
 */
import { describe, expect, it } from "bun:test";
import { shouldAutoUpdate } from "../src/runtime/update-hints.js";

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
