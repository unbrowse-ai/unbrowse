// FALSIFIER for the eviction-during-retry bug observed on probe 003
// (crates.io 2026-05-19).
//
// Bug sequence:
//   1. /v1/skills/X/execute called with endpoint_id=E1
//   2. First execute returns HTTP 404
//   3. executeEndpoint evicts E1 from local cache (src/execution/index.ts:3473)
//   4. Recovery branch at src/api/routes.ts:2044 triggers (status_code===404 +
//      skill.domain + not browser-capture)
//   5. Recovery calls resolveAndExecute(intent, {...execParams, url})
//   6. execParams.endpoint_id is STILL E1 — but E1 was just evicted
//   7. Second execute returns `endpoint_not_found` even though the skill
//      still has E2 available
//
// Fix: strip endpoint_id from recoveryParams before recursion. Recovery
// should let resolve pick a fresh endpoint.
//
// This is a structural test — read the recovery branch source and verify
// the destructuring is in place. A pure-shape unit test on
// resolveAndExecute would need to spin the entire orchestrator + db.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routesPath = join(import.meta.dir, "..", "src", "api", "routes.ts");
const src = readFileSync(routesPath, "utf8");

describe("recovery branch strips evicted endpoint_id before re-resolve", () => {
  test("recovery destructures endpoint_id out of execParams", () => {
    // The fix is at api/routes.ts within the
    // `if (execResult.trace.status_code === 404 ...)` recovery branch.
    // We expect a destructure that pulls endpoint_id off execParams.
    // Looking for: `const { endpoint_id: ... } = execParams`
    expect(src).toMatch(/const\s*\{\s*endpoint_id[^}]*\}\s*=\s*execParams/);
  });

  test("recovery resolveAndExecute call does NOT spread execParams directly", () => {
    // Pre-fix the call was `{ ...execParams, url: recoveryUrl }`.
    // Post-fix it's `{ ...recoveryParams, url: recoveryUrl }`.
    // The `recoveryParams` name flags that endpoint_id was stripped.
    const recoveryBlock = extractRecoveryBlock(src);
    expect(recoveryBlock).toBeTruthy();
    expect(recoveryBlock).toContain("recoveryParams");
    expect(recoveryBlock).not.toMatch(/resolveAndExecute\([^)]*\.\.\.execParams\s*,\s*url:/);
  });

  test("recovery comment cites probe 003 crates.io evidence", () => {
    // Without the why, future-me deletes this destructure as cosmetic.
    const block = extractRecoveryBlock(src);
    expect(block).toMatch(/probe\s*003|crates\.io|endpoint_not_found/i);
  });
});

function extractRecoveryBlock(source: string): string | null {
  // Find the 404 stale-endpoint recovery branch by its marker comment.
  const start = source.indexOf("Auto-recovery: if endpoint returned 404");
  if (start === -1) return null;
  // Roughly 80 lines of branch body — capture enough to see the
  // destructure + resolveAndExecute call.
  return source.slice(start, start + 3500);
}
