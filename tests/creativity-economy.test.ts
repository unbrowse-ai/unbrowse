/**
 * creativity-economy seam — default-on act hook resolution (hermetic; no shell spawn).
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  cacheHitFromResult,
  creativityEconomyEnabled,
  resolveCreativityActHook,
} from "../src/values/creativity-economy.ts";

describe("creativity-economy seam", () => {
  it("is default-on unless explicitly disabled", () => {
    expect(creativityEconomyEnabled({})).toBe(true);
    expect(creativityEconomyEnabled({ CREATIVITY_ECONOMY: "1" })).toBe(true);
    expect(creativityEconomyEnabled({ CREATIVITY_ECONOMY: "0" })).toBe(false);
    expect(creativityEconomyEnabled({ CREATIVITY_ECONOMY: "false" })).toBe(false);
    expect(creativityEconomyEnabled({ CREATIVITY_ECONOMY: "off" })).toBe(false);
  });

  it("resolveCreativityActHook honors CREATIVITY_ACT_HOOK env", () => {
    const hook = join(homedir(), "unbrowse", "scripts", "creativity-act-hook.sh");
    const resolved = resolveCreativityActHook({
      HOME: homedir(),
      CREATIVITY_ACT_HOOK: hook,
    });
    expect(resolved).toBe(hook);
  });

  it("cacheHitFromResult reads timing and impact fields", () => {
    expect(cacheHitFromResult({ timing: { cache_hit: true } })).toBe(true);
    expect(cacheHitFromResult({ impact: { cache_hit: false } })).toBe(false);
    expect(cacheHitFromResult({ _cache_hit: true })).toBe(true);
    expect(cacheHitFromResult({ result: {} })).toBe(undefined);
  });
});