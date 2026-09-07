// bench-gate-compare.test.ts — exercises the compare/threshold gate against
// real fixture artifacts on disk. No mocks: writes manifest.json + verdict.json
// + baseline.json to a temp dir and invokes the script with bun.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/bench-gate-compare.ts");

interface FixtureProbe { probe_id: string; lane: string; intent: string; url: string }

function writeFixture(dir: string, probes: FixtureProbe[], verdicts: any[], cli_version = "v6.16.0-preview.0"): { artifactsDir: string; baselinePath: string } {
  const artifactsDir = join(dir, "run");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "manifest.json"), JSON.stringify({
    run_id: "test-run", corpus: "fixture", cli_version, node_version: "v22", started_at: "2026-05-14T00:00:00Z", probes,
  }, null, 2));
  writeFileSync(join(artifactsDir, "verdict.json"), JSON.stringify({ run_id: "test-run", verdicts }, null, 2));
  return { artifactsDir, baselinePath: join(dir, "baseline.json") };
}

function defaultBaseline(): any {
  return {
    schema_version: 1,
    thresholds: {
      index_coverage_min: 0.80,
      retrieve_coverage_min: 0.65,
      anchor_must_pass: true,
      max_new_suspicious_hostile: 0,
    },
    baseline_run: null,
    baseline_cli_version: null,
    baseline_frozen_at: null,
    per_probe_baseline: {},
  };
}

function runCompare(artifactsDir: string, baselinePath: string, extra: string[] = []): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [SCRIPT, "--artifacts", artifactsDir, "--baseline", baselinePath, ...extra], {
    cwd: ROOT, encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let tmp: string;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bench-gate-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("bench-gate-compare", () => {
  it("PASS when all verdicts are PASS, no baseline yet", () => {
    const probes = [
      { probe_id: "001_anchor_a", lane: "anchor", intent: "x", url: "https://a" },
      { probe_id: "002_anchor_b", lane: "anchor", intent: "x", url: "https://b" },
      { probe_id: "003_ssr_a", lane: "ssr-list", intent: "x", url: "https://c" },
    ];
    const verdicts = probes.map(p => ({
      probe_id: p.probe_id,
      index_verdict: "INDEX_PASS", index_reasoning: "ok", retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "ok",
      evidence_quote: "y", suspicious: false,
    }));
    const { artifactsDir, baselinePath } = writeFixture(tmp, probes, verdicts);
    writeFileSync(baselinePath, JSON.stringify(defaultBaseline(), null, 2));
    const r = runCompare(artifactsDir, baselinePath);
    expect(r.code).toBe(0);
    const md = readFileSync(join(artifactsDir, "gate.md"), "utf8");
    expect(md).toContain("gate**: PASS");
    expect(md).toContain("index_coverage: **100.0%**");
    expect(md).toContain("retrieve_coverage: **100.0%**");
  });

  it("FAIL exit code 2 when index_coverage below floor", () => {
    const probes = [
      { probe_id: "001_x", lane: "ssr-list", intent: "x", url: "https://a" },
      { probe_id: "002_x", lane: "ssr-list", intent: "x", url: "https://b" },
      { probe_id: "003_x", lane: "ssr-list", intent: "x", url: "https://c" },
      { probe_id: "004_x", lane: "ssr-list", intent: "x", url: "https://d" },
      { probe_id: "005_x", lane: "ssr-list", intent: "x", url: "https://e" },
    ];
    // 1/5 INDEX_PASS = 20% << 80% floor
    const verdicts = probes.map((p, i) => ({
      probe_id: p.probe_id,
      index_verdict: i === 0 ? "INDEX_PASS" : "INDEX_FAIL_WRONG_SHAPE",
      index_reasoning: "x", retrieve_verdict: i === 0 ? "RETRIEVE_PASS" : "RETRIEVE_FAIL_EMPTY",
      retrieve_reasoning: "x", evidence_quote: "y", suspicious: false,
    }));
    const { artifactsDir, baselinePath } = writeFixture(tmp, probes, verdicts);
    writeFileSync(baselinePath, JSON.stringify(defaultBaseline(), null, 2));
    const r = runCompare(artifactsDir, baselinePath);
    expect(r.code).toBe(2);
    const md = readFileSync(join(artifactsDir, "gate.md"), "utf8");
    expect(md).toContain("gate**: **FAIL**");
    expect(md).toContain("❌ **index_coverage >= floor**");
  });

  it("FAIL on anchor-lane probe regression even if global coverage holds", () => {
    const probes = Array.from({ length: 10 }, (_, i) => ({
      probe_id: `00${i}_${i === 0 ? "anchor" : "ssr"}`,
      lane: i === 0 ? "anchor" : "ssr-list",
      intent: "x", url: `https://${i}`,
    }));
    const verdicts = probes.map((p, i) => ({
      probe_id: p.probe_id,
      // anchor probe FAILS, all 9 others PASS → 90% global, but anchor must pass
      index_verdict: i === 0 ? "INDEX_FAIL_WRONG_SHAPE" : "INDEX_PASS",
      index_reasoning: "x",
      retrieve_verdict: i === 0 ? "RETRIEVE_FAIL_WRONG_ENTITY" : "RETRIEVE_PASS",
      retrieve_reasoning: "x", evidence_quote: "y", suspicious: false,
    }));
    const { artifactsDir, baselinePath } = writeFixture(tmp, probes, verdicts);
    writeFileSync(baselinePath, JSON.stringify(defaultBaseline(), null, 2));
    const r = runCompare(artifactsDir, baselinePath);
    expect(r.code).toBe(2);
    const md = readFileSync(join(artifactsDir, "gate.md"), "utf8");
    expect(md).toContain("❌ **anchor lane must pass**");
  });

  it("FAIL when a per-probe baseline regresses PASS→FAIL", () => {
    const probes = Array.from({ length: 5 }, (_, i) => ({
      probe_id: `p${i}`, lane: "ssr-list", intent: "x", url: `https://${i}`,
    }));
    const verdicts = probes.map((p, i) => ({
      probe_id: p.probe_id,
      // p0 regresses; everyone else still passes
      index_verdict: i === 0 ? "INDEX_FAIL_WRONG_SHAPE" : "INDEX_PASS",
      index_reasoning: "x",
      retrieve_verdict: i === 0 ? "RETRIEVE_FAIL_EMPTY" : "RETRIEVE_PASS",
      retrieve_reasoning: "x", evidence_quote: "y", suspicious: false,
    }));
    const baseline = defaultBaseline();
    baseline.baseline_run = "previous";
    for (const p of probes) {
      baseline.per_probe_baseline[p.probe_id] = { index: "INDEX_PASS", retrieve: "RETRIEVE_PASS", suspicious: false };
    }
    const { artifactsDir, baselinePath } = writeFixture(tmp, probes, verdicts);
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
    const r = runCompare(artifactsDir, baselinePath);
    expect(r.code).toBe(2);
    const md = readFileSync(join(artifactsDir, "gate.md"), "utf8");
    expect(md).toContain("❌ **no per-probe PASS→FAIL regression**");
    expect(md).toContain("p0.index");
    expect(md).toContain("p0.retrieve");
  });

  it("ignores excluded verdicts (auth/blocked) in coverage denominator", () => {
    const probes = [
      { probe_id: "a1", lane: "auth-gated", intent: "x", url: "https://a" },
      { probe_id: "a2", lane: "hostile", intent: "x", url: "https://b" },
      { probe_id: "a3", lane: "ssr-list", intent: "x", url: "https://c" },
    ];
    const verdicts = [
      { probe_id: "a1", index_verdict: "INDEX_EXCLUDED_AUTH", index_reasoning: "", retrieve_verdict: "RETRIEVE_EXCLUDED_AUTH", retrieve_reasoning: "", evidence_quote: "", suspicious: false },
      { probe_id: "a2", index_verdict: "INDEX_EXCLUDED_BLOCKED", index_reasoning: "", retrieve_verdict: "RETRIEVE_EXCLUDED_BLOCKED", retrieve_reasoning: "", evidence_quote: "", suspicious: false },
      { probe_id: "a3", index_verdict: "INDEX_PASS", index_reasoning: "", retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "", evidence_quote: "", suspicious: false },
    ];
    const { artifactsDir, baselinePath } = writeFixture(tmp, probes, verdicts);
    writeFileSync(baselinePath, JSON.stringify(defaultBaseline(), null, 2));
    const r = runCompare(artifactsDir, baselinePath);
    expect(r.code).toBe(0);
    const md = readFileSync(join(artifactsDir, "gate.md"), "utf8");
    // only 1 indexable probe → 100% coverage
    expect(md).toContain("(1/1 indexable)");
    expect(md).toContain("(1/1 retrievable)");
  });

  it("FAIL when new hostile-lane PASS appears (suspicious)", () => {
    const probes = [
      { probe_id: "h1", lane: "hostile", intent: "x", url: "https://hostile1" },
      { probe_id: "h2", lane: "hostile", intent: "x", url: "https://hostile2" },
    ];
    // h1 surprisingly passes (honey-trap?), h2 blocked as expected
    const verdicts = [
      { probe_id: "h1", index_verdict: "INDEX_PASS", index_reasoning: "", retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "", evidence_quote: "", suspicious: true },
      { probe_id: "h2", index_verdict: "INDEX_EXCLUDED_BLOCKED", index_reasoning: "", retrieve_verdict: "RETRIEVE_EXCLUDED_BLOCKED", retrieve_reasoning: "", evidence_quote: "", suspicious: false },
    ];
    const { artifactsDir, baselinePath } = writeFixture(tmp, probes, verdicts);
    writeFileSync(baselinePath, JSON.stringify(defaultBaseline(), null, 2));
    const r = runCompare(artifactsDir, baselinePath);
    expect(r.code).toBe(2);
    const md = readFileSync(join(artifactsDir, "gate.md"), "utf8");
    expect(md).toContain("❌ **no new hostile-lane suspicious**");
  });

  it("--soft never exits non-zero even when checks fail", () => {
    const probes = [{ probe_id: "p0", lane: "ssr-list", intent: "x", url: "https://a" }];
    const verdicts = [{ probe_id: "p0", index_verdict: "INDEX_FAIL_WRONG_SHAPE", index_reasoning: "", retrieve_verdict: "RETRIEVE_FAIL_EMPTY", retrieve_reasoning: "", evidence_quote: "", suspicious: false }];
    const { artifactsDir, baselinePath } = writeFixture(tmp, probes, verdicts);
    writeFileSync(baselinePath, JSON.stringify(defaultBaseline(), null, 2));
    const r = runCompare(artifactsDir, baselinePath, ["--soft"]);
    expect(r.code).toBe(0);
    const md = readFileSync(join(artifactsDir, "gate.md"), "utf8");
    expect(md).toContain("gate**: **FAIL**");
  });

  it("--freeze writes per_probe_baseline into baseline.json without comparing", () => {
    const probes = [
      { probe_id: "p0", lane: "anchor", intent: "x", url: "https://a" },
      { probe_id: "p1", lane: "ssr-list", intent: "x", url: "https://b" },
    ];
    const verdicts = [
      { probe_id: "p0", index_verdict: "INDEX_PASS", index_reasoning: "", retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "", evidence_quote: "", suspicious: false },
      { probe_id: "p1", index_verdict: "INDEX_FAIL_WRONG_SHAPE", index_reasoning: "", retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "", evidence_quote: "", suspicious: false },
    ];
    const { artifactsDir, baselinePath } = writeFixture(tmp, probes, verdicts);
    writeFileSync(baselinePath, JSON.stringify(defaultBaseline(), null, 2));
    const r = runCompare(artifactsDir, baselinePath, ["--freeze"]);
    expect(r.code).toBe(0);
    const updated = JSON.parse(readFileSync(baselinePath, "utf8"));
    expect(updated.baseline_run).toBe("test-run");
    expect(updated.per_probe_baseline.p0.index).toBe("INDEX_PASS");
    expect(updated.per_probe_baseline.p1.index).toBe("INDEX_FAIL_WRONG_SHAPE");
    expect(updated.baseline_frozen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Gate report is NOT written in freeze mode
    expect(existsSync(join(artifactsDir, "gate.md"))).toBe(false);
  });
});
