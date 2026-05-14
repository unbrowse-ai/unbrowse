// bench-gate-judge.test.ts — exercises the judge PREP + VALIDATE modes
// against real fixture artifacts. The judge script no longer renders
// verdicts itself (the agent in-thread does that), so these tests cover:
//   - prep mode writes judge.bundle.md + verdict.template.json
//   - --dry-run writes stub verdict.json (for harness↔compare contract tests)
//   - --validate rejects malformed verdict.json, accepts well-formed
//
// No mocks. Real fs, real script via bun.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/bench-gate-judge.ts");
const RUBRIC = join(ROOT, "harness/probes/GATE_JUDGE.md");

function writeRun(dir: string, probes: { probe_id: string; lane: string; intent: string; url: string }[]): string {
  const run = join(dir, "run");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "manifest.json"), JSON.stringify({
    run_id: "test-run", corpus: "fixture", cli_version: "v6.16-test", node_version: "v22",
    started_at: "2026-05-14T00:00:00Z", probes,
  }));
  for (const p of probes) {
    const pdir = join(run, p.probe_id);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "capture.meta.json"), JSON.stringify({ total_endpoints_captured: 0 }));
    writeFileSync(join(pdir, "capture.html.excerpt"), "<html>fixture</html>");
    writeFileSync(join(pdir, "resolve.shortlist.json"), JSON.stringify({ available_endpoints: [] }));
    writeFileSync(join(pdir, "resolve.pick.json"), "null");
    writeFileSync(join(pdir, "execute.response.raw"), "{}");
    writeFileSync(join(pdir, "execute.meta.json"), "{}");
    writeFileSync(join(pdir, "timings.json"), "{}");
  }
  return run;
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bench-gate-judge-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("bench-gate-judge — prep mode", () => {
  it("writes judge.bundle.md and verdict.template.json (no verdict.json)", () => {
    const probes = [
      { probe_id: "001_anchor_hn", lane: "anchor", intent: "get hn", url: "https://news.ycombinator.com/" },
      { probe_id: "002_hostile_tm", lane: "hostile", intent: "x", url: "https://ticketmaster.com/" },
    ];
    const runDir = writeRun(tmp, probes);
    const r = run(["--artifacts", runDir]);
    expect(r.code).toBe(0);
    expect(existsSync(join(runDir, "judge.bundle.md"))).toBe(true);
    expect(existsSync(join(runDir, "verdict.template.json"))).toBe(true);
    // Prep mode must NOT write verdict.json — that's the agent's job.
    expect(existsSync(join(runDir, "verdict.json"))).toBe(false);

    const bundle = readFileSync(join(runDir, "judge.bundle.md"), "utf8");
    expect(bundle).toContain("# Bench-Gate Judge Bundle — test-run");
    expect(bundle).toContain("## 001_anchor_hn");
    expect(bundle).toContain("## 002_hostile_tm");
    expect(bundle).toContain("INDEX_PASS"); // rubric inline
    expect(bundle).toContain("RETRIEVE_PASS");
    expect(bundle).toContain("capture.meta.json");
    expect(bundle).toContain("execute.response.raw");

    const tpl = JSON.parse(readFileSync(join(runDir, "verdict.template.json"), "utf8"));
    expect(tpl.run_id).toBe("test-run");
    expect(tpl.verdicts).toHaveLength(2);
    expect(tpl.verdicts[0].probe_id).toBe("001_anchor_hn");
  });

  it("prints agent instructions on stderr", () => {
    const runDir = writeRun(tmp, [{ probe_id: "p0", lane: "ssr-list", intent: "x", url: "https://x" }]);
    const r = run(["--artifacts", runDir]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("AGENT JUDGE STEP");
    expect(r.stderr).toContain("Read");
    expect(r.stderr).toContain("Write");
    expect(r.stderr).toContain("verdict.json");
    expect(r.stderr).toContain("--validate");
  });
});

describe("bench-gate-judge — --dry-run stub mode", () => {
  it("writes stub verdict.json with lane-shaped verdicts (for contract tests only)", () => {
    const probes = [
      { probe_id: "a0", lane: "anchor", intent: "x", url: "https://a" },
      { probe_id: "h0", lane: "hostile", intent: "x", url: "https://h" },
      { probe_id: "g0", lane: "auth-gated", intent: "x", url: "https://g" },
    ];
    const runDir = writeRun(tmp, probes);
    const r = run(["--artifacts", runDir, "--dry-run"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(readFileSync(join(runDir, "verdict.json"), "utf8"));
    expect(out.verdicts).toHaveLength(3);
    expect(out.verdicts.find((v: any) => v.probe_id === "h0").index_verdict).toBe("INDEX_EXCLUDED_BLOCKED");
    expect(out.verdicts.find((v: any) => v.probe_id === "g0").index_verdict).toBe("INDEX_EXCLUDED_AUTH");
    expect(out.verdicts.find((v: any) => v.probe_id === "a0").index_verdict).toBe("INDEX_FAIL_NO_ENDPOINTS");
    for (const v of out.verdicts) expect(v.index_reasoning).toContain("[dry-run stub]");
  });
});

describe("bench-gate-judge — --validate mode", () => {
  it("OK when verdict.json conforms to schema and covers every probe", () => {
    const probes = [{ probe_id: "p0", lane: "anchor", intent: "x", url: "https://a" }];
    const runDir = writeRun(tmp, probes);
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify({
      run_id: "test-run",
      verdicts: [{
        probe_id: "p0", index_verdict: "INDEX_PASS", index_reasoning: "ok",
        retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "ok",
        evidence_quote: "x", suspicious: false,
      }],
    }));
    const r = run(["--artifacts", runDir, "--validate"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("conforms to schema");
  });

  it("FAIL when an enum value is wrong", () => {
    const probes = [{ probe_id: "p0", lane: "anchor", intent: "x", url: "https://a" }];
    const runDir = writeRun(tmp, probes);
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify({
      run_id: "test-run",
      verdicts: [{
        probe_id: "p0", index_verdict: "INDEX_TOTALLY_MADE_UP", index_reasoning: "",
        retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "",
        evidence_quote: "", suspicious: false,
      }],
    }));
    const r = run(["--artifacts", runDir, "--validate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not in enum");
  });

  it("FAIL when a probe is missing a verdict", () => {
    const probes = [
      { probe_id: "p0", lane: "anchor", intent: "x", url: "https://a" },
      { probe_id: "p1", lane: "ssr-list", intent: "x", url: "https://b" },
    ];
    const runDir = writeRun(tmp, probes);
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify({
      run_id: "test-run",
      verdicts: [{
        probe_id: "p0", index_verdict: "INDEX_PASS", index_reasoning: "",
        retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "",
        evidence_quote: "", suspicious: false,
      }],
    }));
    const r = run(["--artifacts", runDir, "--validate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('manifest probe "p1" has no verdict entry');
  });

  it("FAIL when a probe_id is not in the manifest", () => {
    const probes = [{ probe_id: "p0", lane: "anchor", intent: "x", url: "https://a" }];
    const runDir = writeRun(tmp, probes);
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify({
      run_id: "test-run",
      verdicts: [
        { probe_id: "p0", index_verdict: "INDEX_PASS", index_reasoning: "", retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "", evidence_quote: "", suspicious: false },
        { probe_id: "p_HALLUCINATED", index_verdict: "INDEX_PASS", index_reasoning: "", retrieve_verdict: "RETRIEVE_PASS", retrieve_reasoning: "", evidence_quote: "", suspicious: false },
      ],
    }));
    const r = run(["--artifacts", runDir, "--validate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not in the manifest");
  });

  it("FAIL when a required field is missing", () => {
    const probes = [{ probe_id: "p0", lane: "anchor", intent: "x", url: "https://a" }];
    const runDir = writeRun(tmp, probes);
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify({
      run_id: "test-run",
      verdicts: [{ probe_id: "p0", index_verdict: "INDEX_PASS" }],
    }));
    const r = run(["--artifacts", runDir, "--validate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/missing required field/);
  });
});

describe("bench-gate-judge — sanity", () => {
  it("rubric file exists at expected path", () => {
    expect(existsSync(RUBRIC)).toBe(true);
  });
});
