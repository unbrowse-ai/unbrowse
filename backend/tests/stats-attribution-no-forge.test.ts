import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Witness (regression guard) for the stats-attribution forge fix: the Tier-1 attribution
// block in POST /v1/stats/execution must derive the credited indexer from the STORED
// skill, NEVER from the forgeable client body.indexer_id — else an attacker credits
// earnings to any agent by reporting a fake successful execution. RED on the old code
// (which did `let indexerId = body.indexer_id`), GREEN once it reads the stored skill.

const src = readFileSync(join(import.meta.dir, "../src/routes/stats.ts"), "utf8");
const attributionBlock = src.slice(src.indexOf("Tier 1 attribution"));

test("attribution does NOT trust body.indexer_id (the forge vector)", () => {
  expect(attributionBlock).not.toMatch(/indexerId\s*=\s*body\.indexer_id/);
});

test("attribution derives the indexer from the stored skill (the authoritative source)", () => {
  expect(attributionBlock).toContain("storedSkill?.indexer_id");
});
