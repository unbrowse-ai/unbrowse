import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("canonical agent path challenge policy", () => {
  test("does not dispatch paid CAPTCHA/token solvers automatically", () => {
    const orchestrator = readFileSync(join(import.meta.dir, "../src/orchestrator/index.ts"), "utf8");
    const execution = readFileSync(join(import.meta.dir, "../src/execution/index.ts"), "utf8");
    expect(orchestrator).not.toContain("tryX402UnblockerFetch(");
    expect(orchestrator).not.toContain("rescueBlockedPagePaid(");
    expect(execution).not.toContain("solveCaptchaViaX402(");
    expect(execution).not.toContain("injectSolvedToken(");
    expect(execution).toContain('step: "challenge_requires_human"');
  });

  test("the agent contract requires a human gate", () => {
    const skill = readFileSync(join(import.meta.dir, "../SKILL.md"), "utf8");
    expect(skill).toContain("does not solve CAPTCHAs");
    expect(skill).toContain("Payment, terms, CAPTCHA, or guarded publication");
  });
});
