/**
 * Issue #232 — delta attribution client-side wiring
 *
 * Reproduces the bug: recordExecution never sends indexer_id, so the backend
 * never triggers recordAttribution.
 *
 * The fix: buildExecutionPayload must include indexer_id when available on the
 * skill manifest, and fall back to the local agent identity from config.
 *
 * Run:
 *   bun test tests/delta-attribution-wiring.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildExecutionPayload, getAgentId, hashApiKey } from "../src/client/index.js";
import type { ExecutionTrace, SkillManifest } from "../src/types/index.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    trace_id: "t-001",
    skill_id: "skill-abc",
    endpoint_id: "ep-1",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    success: true,
    status_code: 200,
    ...overrides,
  };
}

function makeSkill(overrides?: Partial<SkillManifest>): SkillManifest {
  return {
    skill_id: "skill-abc",
    version: "1.0.0",
    schema_version: "1",
    name: "example.com",
    intent_signature: "search products",
    domain: "example.com",
    description: "test skill",
    owner_type: "agent",
    execution_type: "http",
    endpoints: [],
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildExecutionPayload — indexer_id wiring (#232)", () => {
  const origApiKey = process.env.UNBROWSE_API_KEY;
  const origConfigDir = process.env.UNBROWSE_CONFIG_DIR;
  let emptyConfigDir: string;

  beforeEach(() => {
    emptyConfigDir = join(tmpdir(), `unbrowse-delta-attribution-${Date.now()}`);
    mkdirSync(emptyConfigDir, { recursive: true });
    process.env.UNBROWSE_CONFIG_DIR = emptyConfigDir;
    delete process.env.UNBROWSE_API_KEY;
  });

  afterEach(() => {
    if (origApiKey !== undefined) process.env.UNBROWSE_API_KEY = origApiKey;
    else delete process.env.UNBROWSE_API_KEY;
    if (origConfigDir !== undefined) process.env.UNBROWSE_CONFIG_DIR = origConfigDir;
    else delete process.env.UNBROWSE_CONFIG_DIR;
    if (existsSync(emptyConfigDir)) rmSync(emptyConfigDir, { recursive: true });
  });

  it("includes indexer_id from skill manifest when present", () => {
    const skill = makeSkill({ indexer_id: "agent-xyz" });
    const trace = makeTrace();

    const payload = buildExecutionPayload(skill.skill_id, trace.endpoint_id, trace, skill);

    expect(payload.indexer_id).toBe("agent-xyz");
    expect(payload.skill_id).toBe("skill-abc");
    expect(payload.endpoint_id).toBe("ep-1");
  });

  it("omits indexer_id when skill has no indexer_id and no local api key", () => {
    const skill = makeSkill();
    const trace = makeTrace();

    const payload = buildExecutionPayload(skill.skill_id, trace.endpoint_id, trace, skill);

    expect(payload.indexer_id).toBeUndefined();
  });

  it("falls back to a hashed local api key when skill has no indexer_id", () => {
    process.env.UNBROWSE_API_KEY = "test-api-key";
    const skill = makeSkill();
    const trace = makeTrace();

    const payload = buildExecutionPayload(skill.skill_id, trace.endpoint_id, trace, skill);

    expect(payload.indexer_id).toBe(hashApiKey("test-api-key"));
  });

  it("strips result data from trace (only metadata for scoring)", () => {
    const trace = makeTrace({ result: { big: "response data" } });
    const skill = makeSkill({ indexer_id: "agent-123" });

    const payload = buildExecutionPayload(skill.skill_id, trace.endpoint_id, trace, skill);

    expect(payload.trace.result).toBeUndefined();
    expect(payload.trace.success).toBe(true);
    expect(payload.indexer_id).toBe("agent-123");
  });

  it("accepts explicit indexer_id override", () => {
    const skill = makeSkill({ indexer_id: "agent-from-skill" });
    const trace = makeTrace();

    const payload = buildExecutionPayload(
      skill.skill_id, trace.endpoint_id, trace, skill,
      { indexer_id: "explicit-override" },
    );

    expect(payload.indexer_id).toBe("explicit-override");
  });

  it("handles null skill gracefully", () => {
    const trace = makeTrace();

    const payload = buildExecutionPayload("skill-abc", "ep-1", trace, null);

    expect(payload.indexer_id).toBeUndefined();
    expect(payload.skill_id).toBe("skill-abc");
  });

  it("handles undefined skill gracefully", () => {
    const trace = makeTrace();

    const payload = buildExecutionPayload("skill-abc", "ep-1", trace);

    expect(payload.indexer_id).toBeUndefined();
    expect(payload.skill_id).toBe("skill-abc");
  });
});

describe("getAgentId — local identity derivation (#232)", () => {
  let testDir: string;
  const origConfigDir = process.env.UNBROWSE_CONFIG_DIR;

  beforeEach(() => {
    testDir = join(tmpdir(), `unbrowse-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.UNBROWSE_CONFIG_DIR = testDir;
  });

  afterEach(() => {
    if (origConfigDir !== undefined) {
      process.env.UNBROWSE_CONFIG_DIR = origConfigDir;
    } else {
      delete process.env.UNBROWSE_CONFIG_DIR;
    }
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("returns agent_id from saved config when present", () => {
    writeFileSync(
      join(testDir, "config.json"),
      JSON.stringify({
        api_key: "key-abc",
        agent_id: "agent-saved-123",
        agent_name: "test-agent",
        registered_at: new Date().toISOString(),
        tos_accepted_version: null,
        tos_accepted_at: null,
      }),
    );

    const agentId = getAgentId();
    expect(agentId).toBe("agent-saved-123");
  });

  it("returns null when no config exists", () => {
    const agentId = getAgentId();
    expect(agentId).toBeNull();
  });
});

describe("SkillManifest type supports indexer_id (#232)", () => {
  it("skill manifest type includes optional indexer_id field", () => {
    const skill = makeSkill({ indexer_id: "idx-123" });
    expect(skill.indexer_id).toBe("idx-123");
  });

  it("skill manifest without indexer_id defaults to undefined", () => {
    const skill = makeSkill();
    expect(skill.indexer_id).toBeUndefined();
  });
});
