import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const rootSkill = readFileSync(path.join(ROOT, "SKILL.md"), "utf8");
const shippedSkill = readFileSync(path.join(ROOT, "packages", "skill", "SKILL.md"), "utf8");
const compactSkill = shippedSkill.replace(/\s+/g, " ");

describe("harness-based Agent Skill contract", () => {
  it("keeps one canonical skill at the repository and package boundaries", () => {
    expect(rootSkill).toBe(shippedSkill);
    expect(shippedSkill.length).toBeLessThan(8_000);
  });

  it("gives the agent one front door, one recovery, and a stop condition", () => {
    expect(shippedSkill).toContain('unbrowse "<task>" --url <url>');
    expect(shippedSkill).toContain("run that command once");
    expect(shippedSkill).toContain("retry step 1 once");
    expect(shippedSkill).toContain("stop and report the blocker");
    expect(shippedSkill).toContain("Hand-run `resolve → execute` for an ordinary read");
  });

  it("pins the browse-to-validated-replay lifecycle instead of publishing observations", () => {
    expect(shippedSkill).toContain(
      "resolve → browse → observe → compile DAG → replay-validate → promote → publish → reuse",
    );
    expect(compactSkill).toContain("A capture alone is not publication proof");
    expect(compactSkill).toContain("first interaction browses and learns");
    expect(compactSkill).toContain("next matching interaction proves replay");
    expect(compactSkill).toContain("subsequent interactions are API-first");
    expect(compactSkill).toContain("published for other agents only after sanitization and contribution-policy gates");
  });

  it("keeps credentials sealed across thin remote execution", () => {
    expect(shippedSkill).toContain("Thin remote execution boundary");
    expect(compactSkill).toContain("opaque credential pointers");
    expect(compactSkill).toContain("Must remain sealed: cookies, passwords, API keys");
    expect(compactSkill).toContain("server-held credentials or scoped capability tokens");
    expect(compactSkill).toContain("does not bypass payment, authorization, robots, site-policy, or human-consent gates");
  });

  it("requires explicit mutation and publication safety", () => {
    expect(shippedSkill).toContain("--dry-run");
    expect(shippedSkill).toContain("independently issued host approval");
    expect(shippedSkill).toContain("Private, sensitive, PII-bearing, destructive, or origin-forbidden routes stay local");
    expect(shippedSkill).toContain("Publish a route merely because it was observed once");
  });
});
