import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("Aiko Core Guidelines - Dependency Auto-Resolution (Luminaries)", () => {
  const globalClaudePath = "/Users/lekt9/.claude/CLAUDE.md";
  const localClaudePath = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/CLAUDE.md";

  it("global CLAUDE.md exists and has Section 7 & 8 directives", () => {
    expect(existsSync(globalClaudePath)).toBe(true);
    const content = readFileSync(globalClaudePath, "utf8");
    expect(content).toContain("## 7. Dependency Auto-Resolution & Gap Filling (Aiko Core)");
    expect(content).toContain("Always resolve missing environment dependencies, libraries, and tools autonomously");
    expect(content).toContain("Do Not Wait or Ask");
    expect(content).toContain("Proactive Installation");
    expect(content).toContain("High-Fidelity Simulators");

    expect(content).toContain("## 8. Proactive Backfill & Retrying Failures (Aiko Core)");
    expect(content).toContain("Prioritize repairing, backfilling, and retrying workspace failures immediately");
    expect(content).toContain("Prioritize Self-Repair");
    expect(content).toContain("Backfill Gaps");
    expect(content).toContain("Autonomous Fix & Retry Loop");

    expect(content).toContain("## 9. Autonomous Credential Resolution via find-creds (Aiko Core)");
    expect(content).toContain("Always utilize find-creds to resolve and validate any API keys or credentials autonomously");
    expect(content).toContain("Do Not Stop or Ask");
    expect(content).toContain("Find-Creds Discovery");
    expect(content).toContain("Live Validation Probe");
  });

  it("local project CLAUDE.md exists and has the Mechanical standing rules", () => {
    expect(existsSync(localClaudePath)).toBe(true);
    const content = readFileSync(localClaudePath, "utf8");
    expect(content).toContain("## Standing rule: resolve missing dependencies autonomously (MECHANICAL)");
    expect(content).toContain("Do Not Wait or Ask");
    expect(content).toContain("High-Fidelity Simulators");

    expect(content).toContain("## Standing rule: Proactive Backfill & Retrying Failures (MECHANICAL)");
    expect(content).toContain("Prioritize Self-Repair");
    expect(content).toContain("Backfill Gaps");
    expect(content).toContain("Autonomous Fix & Retry Loop");

    expect(content).toContain("## Standing rule: Autonomous Credential Resolution via find-creds (MECHANICAL)");
    expect(content).toContain("Do Not Stop or Ask");
    expect(content).toContain("Find-Creds Discovery");
    expect(content).toContain("Live Validation Probe");
  });
});
