/**
 * popular-unreviewed query primitive — real-filesystem tests.
 *
 * Writes skill manifests to UNBROWSE_SKILL_CACHE_DIR and execution traces
 * to UNBROWSE_TRACE_STORE_DIR, then asks `getPopularUnreviewedSkills` to
 * find them. No mocks — exercises the actual fs reads + filter logic.
 *
 * Forces UNBROWSE_LOCAL_ONLY=1 so `client.listSkills()` reads the cache
 * directory directly instead of attempting an HTTP call.
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
  workDir = mkdtempSync(join(tmpdir(), "unbrowse-popular-"));
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

function writeSkill(opts: {
  skill_id: string;
  domain: string;
  endpoint_ids: string[];
  reviewed_at?: string;
}) {
  const skill = {
    skill_id: opts.skill_id,
    version: "1.0.0",
    domain: opts.domain,
    execution_type: "http",
    intent_signature: `browse ${opts.domain}`,
    intents: [],
    endpoints: opts.endpoint_ids.map((id) => ({ endpoint_id: id })),
    created_at: "2026-05-14T00:00:00Z",
    updated_at: "2026-05-14T00:00:00Z",
    ...(opts.reviewed_at ? { reviewed_at: opts.reviewed_at } : {}),
  };
  writeFileSync(join(skillDir, `${opts.skill_id}.json`), JSON.stringify(skill));
}

function appendTrace(opts: {
  domain: string;
  selected_endpoint_id: string;
  success: boolean;
  timestamp?: string;
}) {
  const trace = {
    trace_id: `t-${Math.random().toString(36).slice(2)}`,
    domain: opts.domain,
    intent: "test intent",
    endpoint_sequence: [opts.selected_endpoint_id],
    selected_endpoint_id: opts.selected_endpoint_id,
    params: {},
    success: opts.success,
    timestamp: opts.timestamp ?? new Date().toISOString(),
  };
  // Replicate the trace-store filename rule (lowercase + strip www. + safe chars)
  const fname = opts.domain.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.\-]/g, "_") + ".jsonl";
  appendFileSync(join(traceDir, fname), JSON.stringify(trace) + "\n", "utf-8");
}

describe("getPopularUnreviewedSkills — filters", () => {
  it("returns empty when no skills exist locally", async () => {
    const { getPopularUnreviewedSkills } = await import("../src/marketplace/popular-unreviewed.js");
    const result = await getPopularUnreviewedSkills();
    expect(result).toEqual([]);
  });

  it("excludes skills that are already reviewed", async () => {
    writeSkill({
      skill_id: "skill-reviewed",
      domain: "reviewed.example",
      endpoint_ids: ["ep1"],
      reviewed_at: "2026-05-14T00:00:00Z",
    });
    for (let i = 0; i < 10; i++) {
      appendTrace({ domain: "reviewed.example", selected_endpoint_id: "ep1", success: true });
    }
    const { getPopularUnreviewedSkills } = await import("../src/marketplace/popular-unreviewed.js");
    const result = await getPopularUnreviewedSkills();
    expect(result.find((s) => s.skill_id === "skill-reviewed")).toBeUndefined();
  });

  it("excludes skills below the execution threshold", async () => {
    writeSkill({ skill_id: "skill-cold", domain: "cold.example", endpoint_ids: ["ep1"] });
    // Only 2 executions, default threshold is 3.
    appendTrace({ domain: "cold.example", selected_endpoint_id: "ep1", success: true });
    appendTrace({ domain: "cold.example", selected_endpoint_id: "ep1", success: true });
    const { getPopularUnreviewedSkills } = await import("../src/marketplace/popular-unreviewed.js");
    const result = await getPopularUnreviewedSkills();
    expect(result.find((s) => s.skill_id === "skill-cold")).toBeUndefined();
  });

  it("includes unreviewed skills with executions above threshold", async () => {
    writeSkill({ skill_id: "skill-hot", domain: "hot.example", endpoint_ids: ["ep1", "ep2"] });
    for (let i = 0; i < 5; i++) {
      appendTrace({ domain: "hot.example", selected_endpoint_id: "ep1", success: true });
    }
    appendTrace({ domain: "hot.example", selected_endpoint_id: "ep2", success: true });
    const { getPopularUnreviewedSkills } = await import("../src/marketplace/popular-unreviewed.js");
    const result = await getPopularUnreviewedSkills();
    const found = result.find((s) => s.skill_id === "skill-hot");
    expect(found).toBeDefined();
    expect(found!.execution_count).toBe(6);
    expect(found!.success_count).toBe(6);
    expect(found!.success_rate).toBe(1);
    expect(found!.most_used_endpoint).toEqual({ endpoint_id: "ep1", uses: 5 });
  });

  it("excludes skills below the success-rate threshold (default 0.7)", async () => {
    writeSkill({ skill_id: "skill-flaky", domain: "flaky.example", endpoint_ids: ["ep1"] });
    // 5 traces, 2 success → 0.4 success rate — should be filtered out.
    for (let i = 0; i < 3; i++) {
      appendTrace({ domain: "flaky.example", selected_endpoint_id: "ep1", success: false });
    }
    for (let i = 0; i < 2; i++) {
      appendTrace({ domain: "flaky.example", selected_endpoint_id: "ep1", success: true });
    }
    const { getPopularUnreviewedSkills } = await import("../src/marketplace/popular-unreviewed.js");
    const result = await getPopularUnreviewedSkills();
    expect(result.find((s) => s.skill_id === "skill-flaky")).toBeUndefined();
  });

  it("sorts results by execution_count descending", async () => {
    writeSkill({ skill_id: "skill-low", domain: "low.example", endpoint_ids: ["ep1"] });
    writeSkill({ skill_id: "skill-mid", domain: "mid.example", endpoint_ids: ["ep1"] });
    writeSkill({ skill_id: "skill-high", domain: "high.example", endpoint_ids: ["ep1"] });
    for (let i = 0; i < 3; i++) appendTrace({ domain: "low.example", selected_endpoint_id: "ep1", success: true });
    for (let i = 0; i < 5; i++) appendTrace({ domain: "mid.example", selected_endpoint_id: "ep1", success: true });
    for (let i = 0; i < 10; i++) appendTrace({ domain: "high.example", selected_endpoint_id: "ep1", success: true });
    const { getPopularUnreviewedSkills } = await import("../src/marketplace/popular-unreviewed.js");
    const result = await getPopularUnreviewedSkills();
    expect(result.map((s) => s.skill_id)).toEqual(["skill-high", "skill-mid", "skill-low"]);
  });

  it("respects min_executions override", async () => {
    writeSkill({ skill_id: "skill-tiny", domain: "tiny.example", endpoint_ids: ["ep1"] });
    appendTrace({ domain: "tiny.example", selected_endpoint_id: "ep1", success: true });
    const { getPopularUnreviewedSkills } = await import("../src/marketplace/popular-unreviewed.js");
    const result = await getPopularUnreviewedSkills({ min_executions: 1 });
    expect(result.find((s) => s.skill_id === "skill-tiny")).toBeDefined();
  });
});
