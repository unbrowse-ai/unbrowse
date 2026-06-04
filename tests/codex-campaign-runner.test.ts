import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildShardPlan, mergeCampaignArtifacts } from "../evals/codex-campaign-runner.js";

describe("codex campaign runner helpers", () => {
  it("builds bounded shard plans from start/count inputs", () => {
    expect(buildShardPlan(103, 10, 55, 25)).toEqual([
      { start: 10, count: 25 },
      { start: 35, count: 25 },
      { start: 60, count: 5 },
    ]);
  });

  it("merges completed shard artifacts into one summary", () => {
    const dir = join(tmpdir(), `unbrowse-campaign-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const artifactA = join(dir, "a.json");
    const artifactB = join(dir, "b.json");
    writeFileSync(artifactA, JSON.stringify({
      summary: { total: 2, pass: 1, fail: 1, satisfied: 1, unsatisfied: 1 },
      results: [
        { id: "a1", final_state: "pass", goal_satisfied: true },
        { id: "a2", final_state: "fail", goal_satisfied: false },
      ],
    }));
    writeFileSync(artifactB, JSON.stringify({
      summary: { total: 1, pass: 1, fail: 0, satisfied: 1, unsatisfied: 0 },
      results: [
        { id: "b1", final_state: "pass", goal_satisfied: true },
      ],
    }));

    const merged = mergeCampaignArtifacts([
      { shard_index: 1, start: 0, count: 2, cases_path: "a-cases.json", artifact_path: artifactA, completed: true, resumed: false },
      { shard_index: 2, start: 2, count: 1, cases_path: "b-cases.json", artifact_path: artifactB, completed: true, resumed: true },
    ]);

    expect(merged.summary).toMatchObject({
      total_cases: 3,
      completed_cases: 3,
      completed_shards: 2,
      total_shards: 2,
      pass: 2,
      fail: 1,
      satisfied: 2,
      unsatisfied: 1,
    });
    expect(merged.results).toHaveLength(3);

    rmSync(dir, { recursive: true, force: true });
  });
});
