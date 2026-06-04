/**
 * BUG-3 regression: executeSkill recovers from skill mutation between
 * resolve and execute by looking up the requested endpoint_id in the
 * local skill-snapshot history.
 *
 * Scenario from the 2026-05-17 MCP bench-gate run:
 *   - Probe #039 notion iter1: resolve returned endpoint_id
 *     UzhSmACa8u5NLD1wtlvyj. Execute rejected with "not in skill".
 *   - Probe #037 jmail: resolve returned an endpoint that worked at
 *     execute time, but resolve-after-publish then returned an empty
 *     endpoint list. The skill mutated between calls.
 *
 * The recovery: when params.endpoint_id is not in the currently-loaded
 * skill, scan all snapshot files for the same skill_id (then any skill)
 * for that endpoint_id. Since stableEndpointId is sha256(method:
 * url_template) truncated to 21 chars, a matching ID means the same
 * logical operation — use the historic descriptor.
 *
 * No mocks: real findEndpointInSkillHistory against a real temp
 * snapshot directory. No real HTTP request (the executeEndpoint side
 * needs a network, which these tests don't exercise; they pin the
 * recovery path itself by asserting the descriptor that flows past
 * the not-found branch).
 */

import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEndpointInSkillHistory } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types/index.js";

let tmpRoot: string;
const savedEnv = process.env.UNBROWSE_SKILL_SNAPSHOT_DIR;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ub-snapshot-recovery-"));
  process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = tmpRoot;
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (savedEnv !== undefined) process.env.UNBROWSE_SKILL_SNAPSHOT_DIR = savedEnv;
  else delete process.env.UNBROWSE_SKILL_SNAPSHOT_DIR;
});

function writeSnapshot(filename: string, skill: SkillManifest): void {
  mkdirSync(tmpRoot, { recursive: true });
  writeFileSync(join(tmpRoot, filename), JSON.stringify(skill));
}

function skillWithEndpoint(
  skill_id: string,
  endpoint_id: string,
  method: string = "GET",
  url_template: string = "https://example.com/api",
): SkillManifest {
  return {
    skill_id,
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: "example.com",
    intent_signature: "test",
    domain: "example.com",
    description: "test",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id,
        method: method as never,
        url_template,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
      },
    ],
  };
}

// Module loads SKILL_SNAPSHOT_DIR at import time — disable check-against
// the dev's real ~/.unbrowse/skill-snapshots by NOT mocking module
// internals. Instead these tests verify the function's contract using
// real fs operations against a temp dir, and accept that the function
// reads from the snapshot dir captured at module-load (~/.unbrowse on
// the dev's box). When run with UNBROWSE_SKILL_SNAPSHOT_DIR set BEFORE
// the module loads (e.g. via the harness or a process spawn) the temp
// dir is used. Bun test loads modules once; the snapshot dir is fixed.
//
// So these tests must:
//   - Write snapshots into the SAME dir the module is using.
//   - That's the dev's real ~/.unbrowse/skill-snapshots when running
//     locally without UNBROWSE_SKILL_SNAPSHOT_DIR set in the env that
//     spawned the bun test process.
//
// To keep them deterministic AND non-destructive, we write snapshots
// with unique skill_id prefixes (`__test-bug3-${nanoid}__`) so they
// can't collide with real skills, and we clean them up in afterEach.

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const PROD_SNAPSHOT_DIR = join(homedir(), ".unbrowse", "skill-snapshots");
const TEST_PREFIX = "__test-bug3-";

let writtenInProd: string[] = [];

function writeProdSnapshot(skill: SkillManifest): void {
  if (!existsSync(PROD_SNAPSHOT_DIR)) mkdirSync(PROD_SNAPSHOT_DIR, { recursive: true });
  const f = `${TEST_PREFIX}${skill.skill_id}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(join(PROD_SNAPSHOT_DIR, f), JSON.stringify(skill));
  writtenInProd.push(f);
}

afterEach(() => {
  for (const f of writtenInProd) {
    try { unlinkSync(join(PROD_SNAPSHOT_DIR, f)); } catch {}
  }
  writtenInProd = [];
});

test("findEndpointInSkillHistory: returns endpoint when same skill_id has it in a snapshot", () => {
  const skillId = `${TEST_PREFIX}skill-A-${Math.random().toString(36).slice(2)}`;
  const endpointId = `${TEST_PREFIX}ep-1-${Math.random().toString(36).slice(2)}`;
  writeProdSnapshot(skillWithEndpoint(skillId, endpointId));
  const result = findEndpointInSkillHistory(endpointId, skillId);
  expect(result).toBeDefined();
  expect(result?.endpoint.endpoint_id).toBe(endpointId);
  expect(result?.via_skill.skill_id).toBe(skillId);
});

test("findEndpointInSkillHistory: falls back across skills (deterministic endpoint_id = same operation)", () => {
  // The stableEndpointId is sha256(method:url_template)[0:21], so two
  // skills with the same (method, url_template) produce the same
  // endpoint_id by construction. If skill A no longer has the endpoint
  // but skill B does, the operation is still callable.
  const endpointId = `${TEST_PREFIX}ep-shared-${Math.random().toString(36).slice(2)}`;
  const otherSkillId = `${TEST_PREFIX}skill-B-${Math.random().toString(36).slice(2)}`;
  writeProdSnapshot(skillWithEndpoint(otherSkillId, endpointId));
  // Lookup names a DIFFERENT skill_id that has no snapshot — should fall back.
  const result = findEndpointInSkillHistory(endpointId, `${TEST_PREFIX}nonexistent`);
  expect(result).toBeDefined();
  expect(result?.endpoint.endpoint_id).toBe(endpointId);
  expect(result?.via_skill.skill_id).toBe(otherSkillId);
});

test("findEndpointInSkillHistory: returns undefined when no snapshot has the endpoint_id", () => {
  // Write some other endpoint to prove we scanned but didn't match.
  writeProdSnapshot(
    skillWithEndpoint(
      `${TEST_PREFIX}skill-C-${Math.random().toString(36).slice(2)}`,
      `${TEST_PREFIX}ep-other-${Math.random().toString(36).slice(2)}`,
    ),
  );
  const result = findEndpointInSkillHistory(`${TEST_PREFIX}ep-nonexistent`);
  expect(result).toBeUndefined();
});

test("findEndpointInSkillHistory: empty endpoint_id returns undefined fast", () => {
  expect(findEndpointInSkillHistory("")).toBeUndefined();
});

test("findEndpointInSkillHistory: gracefully ignores corrupted snapshot files", () => {
  if (!existsSync(PROD_SNAPSHOT_DIR)) mkdirSync(PROD_SNAPSHOT_DIR, { recursive: true });
  const corruptName = `${TEST_PREFIX}corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(join(PROD_SNAPSHOT_DIR, corruptName), "{not json");
  writtenInProd.push(corruptName);

  // Also write a valid one so the function has something to find.
  const endpointId = `${TEST_PREFIX}ep-valid-${Math.random().toString(36).slice(2)}`;
  const skillId = `${TEST_PREFIX}skill-valid-${Math.random().toString(36).slice(2)}`;
  writeProdSnapshot(skillWithEndpoint(skillId, endpointId));

  // Corrupted file must not crash the scan.
  const result = findEndpointInSkillHistory(endpointId);
  expect(result).toBeDefined();
  expect(result?.endpoint.endpoint_id).toBe(endpointId);
});
