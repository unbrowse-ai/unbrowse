import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adaptWebArenaVerified } from "../scripts/adapt-webarena-verified.js";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "evals", "codex-cases.webarena-verified.adapted.json");

describe("webarena verified adapted corpus", () => {
  it("stays regenerated from the official dataset", () => {
    const generated = adaptWebArenaVerified();
    const checkedIn = JSON.parse(readFileSync(OUT, "utf-8"));

    expect(checkedIn.meta.counts).toEqual(generated.meta.counts);
    expect(checkedIn.cases).toEqual(generated.cases);
  });

  it("keeps full benchmark counts and stable-env tags", () => {
    const raw = JSON.parse(readFileSync(OUT, "utf-8")) as {
      meta: { counts: { total: number; hard_subset: number; stable_env_candidate: number; stable_env_hard_subset: number; single_site_stable_env_candidate: number } };
      cases: Array<{ id: string; benchmark_task_id: number; tags: string[]; sites: string[]; expected_fields: string[]; validate?: { terminal_ok?: string[] } }>;
    };

    expect(raw.meta.counts.total).toBe(812);
    expect(raw.meta.counts.hard_subset).toBe(258);
    expect(raw.meta.counts.stable_env_candidate).toBe(480);
    expect(raw.meta.counts.stable_env_hard_subset).toBe(158);
    expect(raw.meta.counts.single_site_stable_env_candidate).toBe(475);

    const ids = new Set<string>();
    for (const testCase of raw.cases) {
      expect(ids.has(testCase.id)).toBe(false);
      ids.add(testCase.id);
      expect(testCase.expected_fields.length).toBeGreaterThan(0);
      expect((testCase.validate?.terminal_ok ?? []).length).toBeGreaterThan(0);
    }

    const task11 = raw.cases.find((testCase) => testCase.benchmark_task_id === 11);
    expect(task11?.tags).toContain("hard_subset");
    expect(task11?.tags).toContain("stable_env_candidate");
    expect(task11?.sites).toEqual(["shopping_admin"]);
  });
});
