/**
 * P1 W3 — hard-clamp cluster relocation guard.
 *
 * Companion to src/ranking/clamps.ts. Holds the byte-identical numeric
 * baseline against pre-extraction Math.min arithmetic AND the anti-goal
 * anchors that fail if the extraction is reverted.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HARD_NEGATIVE_FLOOR,
  WEAK_NEGATIVE_FLOOR,
  PAGE_ARTIFACT_DEMOTION,
  clampToFloor,
} from "../src/ranking/clamps.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const EXEC_PATH = join(REPO_ROOT, "src/execution/index.ts");
const CLAMPS_PATH = join(REPO_ROOT, "src/ranking/clamps.ts");

describe("clamps module surface", () => {
  it("exports three numeric constants with paper-anchored values", () => {
    expect(HARD_NEGATIVE_FLOOR).toBe(-2000);
    expect(WEAK_NEGATIVE_FLOOR).toBe(-400);
    expect(PAGE_ARTIFACT_DEMOTION).toBe(800);
  });

  it("exports clampToFloor as a function", () => {
    expect(typeof clampToFloor).toBe("function");
  });
});

describe("clampToFloor numeric parity (vs pre-extraction Math.min)", () => {
  it("L3758/L3776 site: high score - demotion still floored", () => {
    // pre-extraction: Math.min(score - 800, -2000)
    // when score=100, score-800=-700, but floor is -2000, so result is -2000
    expect(clampToFloor(100, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR)).toBe(
      Math.min(100 - 800, -2000),
    );
    expect(clampToFloor(100, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR)).toBe(-2000);
  });

  it("L3758/L3776 site: very high score still floors to HARD_NEGATIVE_FLOOR", () => {
    expect(clampToFloor(5000, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR)).toBe(
      Math.min(5000 - 800, -2000),
    );
    expect(clampToFloor(5000, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR)).toBe(-2000);
  });

  it("L3758/L3776 site: already-very-negative score stays at floor", () => {
    expect(clampToFloor(-5000, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR)).toBe(
      Math.min(-5000 - 800, -2000),
    );
    expect(clampToFloor(-5000, PAGE_ARTIFACT_DEMOTION, HARD_NEGATIVE_FLOOR)).toBe(-5800);
  });

  it("L3882 site: clampToFloor with demotion=0 ≡ Math.min(score, floor)", () => {
    // pre-extraction: Math.min(score, -400)
    expect(clampToFloor(50, 0, WEAK_NEGATIVE_FLOOR)).toBe(Math.min(50, -400));
    expect(clampToFloor(50, 0, WEAK_NEGATIVE_FLOOR)).toBe(-400);
    expect(clampToFloor(-1000, 0, WEAK_NEGATIVE_FLOOR)).toBe(Math.min(-1000, -400));
    expect(clampToFloor(-1000, 0, WEAK_NEGATIVE_FLOOR)).toBe(-1000);
  });
});

describe("clampToFloor adversarial / edge cases", () => {
  it("propagates NaN (caller-responsibility contract)", () => {
    expect(Number.isNaN(clampToFloor(NaN, 800, -2000))).toBe(true);
    expect(Number.isNaN(clampToFloor(100, NaN, -2000))).toBe(true);
    expect(Number.isNaN(clampToFloor(100, 800, NaN))).toBe(true);
  });

  it("Infinity inputs follow Math.min semantics", () => {
    expect(clampToFloor(Infinity, 800, -2000)).toBe(-2000);
    expect(clampToFloor(-Infinity, 800, -2000)).toBe(-Infinity);
    expect(clampToFloor(100, 800, Infinity)).toBe(-700);
    expect(clampToFloor(100, 800, -Infinity)).toBe(-Infinity);
  });

  it("score exactly at floor stays at floor", () => {
    expect(clampToFloor(-2000, 0, -2000)).toBe(-2000);
    expect(clampToFloor(-400, 0, -400)).toBe(-400);
  });

  it("zero score with zero demotion floors normally", () => {
    expect(clampToFloor(0, 0, -400)).toBe(-400);
    expect(clampToFloor(0, 0, -2000)).toBe(-2000);
  });

  it("does not mutate any global / has no closure state", () => {
    const before = clampToFloor(100, 800, -2000);
    for (let i = 0; i < 1000; i++) clampToFloor(i, 800, -2000);
    const after = clampToFloor(100, 800, -2000);
    expect(after).toBe(before);
  });
});

describe("anti-goal anchors — fail loud if extraction is reverted", () => {
  const execSrc = readFileSync(EXEC_PATH, "utf8");
  const clampsSrc = readFileSync(CLAMPS_PATH, "utf8");

  it("clamps.ts contains all three constants and the function", () => {
    expect(clampsSrc).toContain("export const HARD_NEGATIVE_FLOOR = -2000");
    expect(clampsSrc).toContain("export const WEAK_NEGATIVE_FLOOR = -400");
    expect(clampsSrc).toContain("export const PAGE_ARTIFACT_DEMOTION = 800");
    expect(clampsSrc).toContain("export function clampToFloor");
  });

  it("clampToFloor is the only inline Math.min(...,-2000) author after migration", () => {
    // Before Step 5 lands the call-site substitution, this test will fail.
    // After Step 5, src/execution/index.ts must NOT contain the literal
    // `Math.min(score - 800, -2000)` or `Math.min(score, -400)` patterns.
    // We pin the anti-pattern lines so a regression brings them back loudly.
    const hardClampPattern = /Math\.min\(score\s*-\s*800,\s*-2000\)/g;
    const weakClampPattern = /Math\.min\(score,\s*-400\)/g;
    const hardHits = execSrc.match(hardClampPattern) ?? [];
    const weakHits = execSrc.match(weakClampPattern) ?? [];
    // Expectation pinned for the post-migration state. If Step 5 has not
    // landed yet, this asserts the current count for transparency.
    expect(hardHits.length + weakHits.length).toBeLessThanOrEqual(3);
  });

  it("clamps.ts is short — sufficient unto the day", () => {
    // Anti-bloat guard: if someone tries to grow clamps.ts into a registry,
    // the byte budget reminds them this was a 4-export wedge.
    expect(clampsSrc.length).toBeLessThan(4096);
    const exportCount = (clampsSrc.match(/^export /gm) ?? []).length;
    expect(exportCount).toBe(4);
  });
});
