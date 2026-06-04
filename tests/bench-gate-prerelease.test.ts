// bench-gate-prerelease.test.ts — exercises the release-it before:init hook
// against real git repos in a temp dir. No mocks. Verifies:
//   - missing stamp → FAIL with instructions
//   - stamp with gate_passed=false → FAIL
//   - stamp commit == HEAD → PASS
//   - stamp older than HEAD but no gate-affecting changes → PASS
//   - stamp older than HEAD AND gate-affecting paths changed → FAIL
//   - uncommitted changes to gate-affecting paths → FAIL
//   - BENCH_GATE_BYPASS=1 → PASS (with warning)
//
// Also tests bench-gate-compare.ts --stamp emits the stamp on PASS only.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK_SCRIPT = join(REPO_ROOT, "scripts/bench-gate-prerelease.sh");
const COMPARE_SCRIPT = join(REPO_ROOT, "scripts/bench-gate-compare.ts");

function sh(cmd: string, cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function initRepo(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "packages/sdk"), { recursive: true });
  mkdirSync(join(dir, "harness/probes"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "src/dummy.ts"), "export const x = 1;");
  writeFileSync(join(dir, "packages/sdk/dummy.ts"), "export const y = 2;");
  writeFileSync(join(dir, "harness/probes/corpus-gate.txt"), "# fixture\n");
  writeFileSync(join(dir, "harness/probes/GATE_JUDGE.md"), "# fixture\n");
  writeFileSync(join(dir, "harness/probes/bench-gate-baseline.json"), JSON.stringify({ thresholds: {} }));
  cpSync(HOOK_SCRIPT, join(dir, "scripts/bench-gate-prerelease.sh"));
  spawnSync("chmod", ["+x", join(dir, "scripts/bench-gate-prerelease.sh")]);
  sh("git init -q && git checkout -q -b main && git add -A && git commit -q -m init", dir);
}

function writeStamp(dir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, ".bench-gate"), { recursive: true });
  const sha = sh("git rev-parse HEAD", dir).stdout.trim();
  const stamp = {
    schema_version: 1,
    commit_sha: sha,
    run_id: "test-run",
    cli_version: "vtest",
    baseline_run: "baseline-1",
    gate_passed: true,
    stamped_at: new Date().toISOString(),
    index_coverage: 0.92,
    retrieve_coverage: 0.75,
    artifact_dir: ".bench-gate/test-run",
    ...overrides,
  };
  writeFileSync(join(dir, ".bench-gate/stamp.json"), JSON.stringify(stamp, null, 2));
}

function runHook(dir: string, env: Record<string, string> = {}): { code: number; stderr: string } {
  const r = spawnSync("bash", ["scripts/bench-gate-prerelease.sh"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bench-gate-pre-")); initRepo(tmp); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("bench-gate-prerelease hook", () => {
  it("FAILs with instructions when no stamp exists", () => {
    const r = runHook(tmp);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no bench-gate stamp");
    expect(r.stderr).toContain("bun run bench:gate:full");
    expect(r.stderr).toContain("--stamp");
  });

  it("FAILs when stamp.gate_passed is false", () => {
    writeStamp(tmp, { gate_passed: false });
    const r = runHook(tmp);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gate_passed=false");
  });

  it("PASSes when stamp commit_sha matches HEAD exactly", () => {
    writeStamp(tmp);
    const r = runHook(tmp);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("stamp matches HEAD");
  });

  it("PASSes when stamp is older but no gate-affecting paths changed", () => {
    writeStamp(tmp);
    // Make a docs-only commit; should not require re-judging
    writeFileSync(join(tmp, "README.md"), "# docs only\n");
    sh("git add README.md && git commit -q -m 'docs only'", tmp);
    const r = runHook(tmp);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("no gate-affecting changes");
  });

  it("FAILs when src/ changes since stamp", () => {
    writeStamp(tmp);
    writeFileSync(join(tmp, "src/dummy.ts"), "export const x = 2;");
    sh("git add src/dummy.ts && git commit -q -m 'change src'", tmp);
    const r = runHook(tmp);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gate-affecting paths changed");
    expect(r.stderr).toContain("src/dummy.ts");
  });

  it("FAILs when packages/sdk/ changes since stamp", () => {
    writeStamp(tmp);
    writeFileSync(join(tmp, "packages/sdk/dummy.ts"), "export const y = 99;");
    sh("git add . && git commit -q -m 'change sdk'", tmp);
    const r = runHook(tmp);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("packages/sdk/dummy.ts");
  });

  it("FAILs when corpus or rubric changes since stamp", () => {
    writeStamp(tmp);
    writeFileSync(join(tmp, "harness/probes/corpus-gate.txt"), "# new probe row\n");
    sh("git add . && git commit -q -m 'change corpus'", tmp);
    const r = runHook(tmp);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("corpus-gate.txt");
  });

  it("FAILs when there are uncommitted changes to gate-affecting paths", () => {
    writeStamp(tmp);
    writeFileSync(join(tmp, "src/dummy.ts"), "export const x = 2;");
    const r = runHook(tmp);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("uncommitted changes");
    expect(r.stderr).toContain("src/dummy.ts");
  });

  it("BENCH_GATE_BYPASS=1 PASSes loudly when stamp is missing", () => {
    const r = runHook(tmp, { BENCH_GATE_BYPASS: "1" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("BYPASSED");
    expect(r.stderr).toContain("agent-gated");
  });
});

describe("bench-gate-compare --stamp", () => {
  function setupRunDir(dir: string): string {
    const runDir = join(dir, ".bench-gate/test-run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify({
      run_id: "test-run", corpus: "fixture", cli_version: "vtest", node_version: "v22",
      started_at: "2026-05-14T00:00:00Z",
      probes: [{ probe_id: "p0", lane: "anchor", intent: "x", url: "https://a" }],
    }));
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify({
      run_id: "test-run",
      verdicts: [{
        probe_id: "p0", index_verdict: "INDEX_PASS", index_reasoning: "ok",
        retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "ok",
        evidence_quote: "x", suspicious: false,
      }],
    }));
    return runDir;
  }

  it("writes .bench-gate/stamp.json on PASS with --stamp", () => {
    const runDir = setupRunDir(tmp);
    writeFileSync(join(tmp, "harness/probes/bench-gate-baseline.json"), JSON.stringify({
      schema_version: 1,
      thresholds: { index_coverage_min: 0.5, retrieve_coverage_min: 0.5, anchor_must_pass: true, max_new_suspicious_hostile: 0 },
      baseline_run: null, baseline_cli_version: null, baseline_frozen_at: null,
      per_probe_baseline: {},
    }));
    const r = spawnSync("bun", [
      COMPARE_SCRIPT,
      "--artifacts", runDir,
      "--baseline", join(tmp, "harness/probes/bench-gate-baseline.json"),
      "--stamp",
    ], { cwd: tmp, encoding: "utf8" });
    expect(r.status).toBe(0);
    const stampPath = join(tmp, ".bench-gate/stamp.json");
    expect(existsSync(stampPath)).toBe(true);
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    expect(stamp.gate_passed).toBe(true);
    expect(stamp.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp.run_id).toBe("test-run");
  });

  it("does NOT write stamp on FAIL", () => {
    const runDir = setupRunDir(tmp);
    // Set floor higher than coverage to force FAIL
    writeFileSync(join(tmp, "harness/probes/bench-gate-baseline.json"), JSON.stringify({
      schema_version: 1,
      thresholds: { index_coverage_min: 1.5, retrieve_coverage_min: 0.5, anchor_must_pass: true, max_new_suspicious_hostile: 0 },
      baseline_run: null, baseline_cli_version: null, baseline_frozen_at: null,
      per_probe_baseline: {},
    }));
    const r = spawnSync("bun", [
      COMPARE_SCRIPT,
      "--artifacts", runDir,
      "--baseline", join(tmp, "harness/probes/bench-gate-baseline.json"),
      "--stamp",
    ], { cwd: tmp, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(existsSync(join(tmp, ".bench-gate/stamp.json"))).toBe(false);
  });
});

describe("bench-gate-prerelease — release-it config wiring", () => {
  it(".release-it.json before:init runs the hook", () => {
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, ".release-it.json"), "utf8"));
    const before = cfg.hooks?.["before:init"];
    expect(before).toBeDefined();
    const flat = Array.isArray(before) ? before.join("\n") : String(before);
    expect(flat).toContain("scripts/bench-gate-prerelease.sh");
  });
});
