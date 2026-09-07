/**
 * Tests for the earnings-side helpers in src/marketplace/popular-unreviewed.ts:
 *   - computeMilestoneState (pure)
 *   - getMyContributions (real-filesystem; uses UNBROWSE_SKILL_CACHE_DIR +
 *     UNBROWSE_TRACE_STORE_DIR + UNBROWSE_LOCAL_ONLY env knobs)
 *
 * No mocks — same pattern as tests/popular-unreviewed.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let skillDir: string;
let traceDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "unbrowse-earnings-"));
  skillDir = join(workDir, "skill-cache");
  traceDir = join(workDir, "traces");
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });

  savedEnv.UNBROWSE_SKILL_CACHE_DIR = process.env.UNBROWSE_SKILL_CACHE_DIR;
  savedEnv.UNBROWSE_TRACE_STORE_DIR = process.env.UNBROWSE_TRACE_STORE_DIR;
  savedEnv.UNBROWSE_LOCAL_ONLY = process.env.UNBROWSE_LOCAL_ONLY;
  process.env.UNBROWSE_SKILL_CACHE_DIR = skillDir;
  process.env.UNBROWSE_TRACE_STORE_DIR = traceDir;
  process.env.UNBROWSE_LOCAL_ONLY = "1";
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeSkill(skill: Record<string, unknown> & { skill_id: string }) {
  writeFileSync(join(skillDir, `${skill.skill_id}.json`), JSON.stringify(skill));
}

function appendTrace(opts: { domain: string; selected_endpoint_id: string; success: boolean }) {
  const trace = {
    trace_id: `t-${Math.random().toString(36).slice(2)}`,
    domain: opts.domain,
    intent: "test",
    endpoint_sequence: [opts.selected_endpoint_id],
    selected_endpoint_id: opts.selected_endpoint_id,
    params: {},
    success: opts.success,
    timestamp: new Date().toISOString(),
  };
  const fname = opts.domain.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.\-]/g, "_") + ".jsonl";
  appendFileSync(join(traceDir, fname), JSON.stringify(trace) + "\n", "utf-8");
}

describe("computeMilestoneState — pure math", () => {
  it("0 earnings → next is $1, 0% progress, nothing passed", async () => {
    const { computeMilestoneState } = await import("../src/marketplace/popular-unreviewed.js");
    const m = computeMilestoneState(0);
    expect(m.passed_usd).toEqual([]);
    expect(m.next_usd).toBe(1);
    expect(m.progress_to_next_pct).toBe(0);
  });

  it("$0.50 → next is $1, 50% progress", async () => {
    const { computeMilestoneState } = await import("../src/marketplace/popular-unreviewed.js");
    const m = computeMilestoneState(0.5);
    expect(m.passed_usd).toEqual([]);
    expect(m.next_usd).toBe(1);
    expect(m.progress_to_next_pct).toBe(50);
  });

  it("$5 → next is $10, 50%, passed $1", async () => {
    const { computeMilestoneState } = await import("../src/marketplace/popular-unreviewed.js");
    const m = computeMilestoneState(5);
    expect(m.passed_usd).toEqual([1]);
    expect(m.next_usd).toBe(10);
    expect(m.progress_to_next_pct).toBe(50);
  });

  it("$1234 → all milestones passed, next_usd is null, 100%", async () => {
    const { computeMilestoneState } = await import("../src/marketplace/popular-unreviewed.js");
    const m = computeMilestoneState(1234);
    expect(m.passed_usd).toEqual([1, 10, 100, 1000]);
    expect(m.next_usd).toBeNull();
    expect(m.progress_to_next_pct).toBe(100);
  });

  it("exactly on milestone (=$10) counts as passed AND points to next", async () => {
    const { computeMilestoneState } = await import("../src/marketplace/popular-unreviewed.js");
    const m = computeMilestoneState(10);
    expect(m.passed_usd).toEqual([1, 10]);
    expect(m.next_usd).toBe(100);
  });
});

describe("getMyContributions — real-fs join of skill cache + trace store", () => {
  it("returns [] when no local skills match the agent", async () => {
    const { getMyContributions } = await import("../src/marketplace/popular-unreviewed.js");
    const out = await getMyContributions("agent-nobody");
    expect(out).toEqual([]);
  });

  it("includes skills where the agent is the indexer", async () => {
    writeSkill({
      skill_id: "skill-mine",
      version: "1.0.0",
      domain: "mine.example",
      execution_type: "http",
      endpoints: [{ endpoint_id: "ep1" }],
      created_at: "2026-05-14T00:00:00Z",
      updated_at: "2026-05-14T00:00:00Z",
      indexer_id: "agent-me",
    });
    for (let i = 0; i < 4; i++) appendTrace({ domain: "mine.example", selected_endpoint_id: "ep1", success: true });
    const { getMyContributions } = await import("../src/marketplace/popular-unreviewed.js");
    const out = await getMyContributions("agent-me");
    expect(out).toHaveLength(1);
    expect(out[0]!.skill_id).toBe("skill-mine");
    expect(out[0]!.role).toBe("indexer");
    expect(out[0]!.local_execution_count).toBe(4);
  });

  it("includes skills where the agent is a contributor (not indexer)", async () => {
    writeSkill({
      skill_id: "skill-co",
      version: "1.0.0",
      domain: "co.example",
      execution_type: "http",
      endpoints: [{ endpoint_id: "ep1" }],
      created_at: "2026-05-14T00:00:00Z",
      updated_at: "2026-05-14T00:00:00Z",
      indexer_id: "agent-other",
      contributors: [
        { agent_id: "agent-me", wallet_address: "0xme", endpoints_contributed: 1, cumulative_delta: 0.5, share: 0.3, first_contributed_at: "x", last_contributed_at: "y" },
        { agent_id: "agent-other", endpoints_contributed: 2, cumulative_delta: 1, share: 0.7, first_contributed_at: "x", last_contributed_at: "y" },
      ],
    });
    const { getMyContributions } = await import("../src/marketplace/popular-unreviewed.js");
    const out = await getMyContributions("agent-me");
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("contributor");
    expect(out[0]!.share).toBe(0.3);
    expect(out[0]!.endpoints_contributed).toBe(1);
  });

  it("excludes skills the agent never touched", async () => {
    writeSkill({
      skill_id: "skill-other",
      version: "1.0.0",
      domain: "other.example",
      execution_type: "http",
      endpoints: [{ endpoint_id: "ep1" }],
      created_at: "2026-05-14T00:00:00Z",
      updated_at: "2026-05-14T00:00:00Z",
      indexer_id: "agent-stranger",
    });
    const { getMyContributions } = await import("../src/marketplace/popular-unreviewed.js");
    const out = await getMyContributions("agent-me");
    expect(out).toEqual([]);
  });

  it("sorts by local_execution_count descending", async () => {
    writeSkill({
      skill_id: "skill-low",
      version: "1.0.0",
      domain: "low.example",
      execution_type: "http",
      endpoints: [{ endpoint_id: "ep1" }],
      created_at: "2026-05-14T00:00:00Z",
      updated_at: "2026-05-14T00:00:00Z",
      indexer_id: "agent-me",
    });
    writeSkill({
      skill_id: "skill-hot",
      version: "1.0.0",
      domain: "hot.example",
      execution_type: "http",
      endpoints: [{ endpoint_id: "ep1" }],
      created_at: "2026-05-14T00:00:00Z",
      updated_at: "2026-05-14T00:00:00Z",
      indexer_id: "agent-me",
    });
    for (let i = 0; i < 2; i++) appendTrace({ domain: "low.example", selected_endpoint_id: "ep1", success: true });
    for (let i = 0; i < 9; i++) appendTrace({ domain: "hot.example", selected_endpoint_id: "ep1", success: true });
    const { getMyContributions } = await import("../src/marketplace/popular-unreviewed.js");
    const out = await getMyContributions("agent-me");
    expect(out.map((c) => c.skill_id)).toEqual(["skill-hot", "skill-low"]);
  });

  it("empty agentId short-circuits to []", async () => {
    writeSkill({
      skill_id: "skill-x",
      version: "1.0.0",
      domain: "x.example",
      execution_type: "http",
      endpoints: [{ endpoint_id: "ep1" }],
      created_at: "2026-05-14T00:00:00Z",
      updated_at: "2026-05-14T00:00:00Z",
      indexer_id: "agent-me",
    });
    const { getMyContributions } = await import("../src/marketplace/popular-unreviewed.js");
    const out = await getMyContributions("");
    expect(out).toEqual([]);
  });
});
