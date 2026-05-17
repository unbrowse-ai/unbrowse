/**
 * Smoke tests for the MCP-driven bench gate.
 *
 * No mocks. The prep script + collector are run as real subprocesses
 * against a temp HOME so we don't touch the developer's real
 * ~/.unbrowse vault / skill-snapshots. We assert structural
 * invariants the parent agent and the downstream validator depend on:
 *
 *   - prep wipes the clean-slate dirs (skill-snapshots, queue/pending,
 *     route-cache) when --keep-index is NOT set
 *   - prep writes one subagent.prompt.md + subagent.context.json per
 *     probe and a manifest.json that lists them
 *   - collector consolidates per-probe result.json into a verdict.json
 *     that conforms to the bench-gate-judge.ts --validate schema
 *
 * These are CONTRACT tests, not bench-gate execution. The full gate run
 * spawns Agent-tool calls which only the parent agent can do from
 * inside Claude Code; this file pins the structural surface those
 * subagents will see.
 */

import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PREP = join(REPO_ROOT, "scripts/bench-gate-mcp.sh");
const COLLECT = join(REPO_ROOT, "scripts/bench-gate-mcp-collect.ts");
const VALIDATE = join(REPO_ROOT, "scripts/bench-gate-judge.ts");

let tmpHome: string;
let tmpOut: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ubgmcp-home-"));
  tmpOut = mkdtempSync(join(tmpdir(), "ubgmcp-out-"));
  // Seed the clean-slate dirs with sentinel files so we can prove the
  // prep script wiped them.
  for (const d of [
    join(tmpHome, ".unbrowse", "skill-snapshots"),
    join(tmpHome, ".unbrowse", "queue", "pending"),
    join(tmpHome, ".unbrowse", "route-cache"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(tmpHome, ".unbrowse/skill-snapshots/sentinel.json"), "{}");
  writeFileSync(join(tmpHome, ".unbrowse/queue/pending/sentinel.json"), "{}");
  writeFileSync(join(tmpHome, ".unbrowse/route-cache/sentinel.json"), "{}");
});

afterEach(() => {
  for (const d of [tmpHome, tmpOut]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  if (savedHome !== undefined) process.env.HOME = savedHome;
});

function runPrep(args: string[], corpus: string): { stdout: string; stderr: string; runDir: string } {
  const r = spawnSync("bash", [PREP, "--corpus", corpus, ...args], {
    env: { ...process.env, HOME: tmpHome, OUT_DIR: tmpOut },
    encoding: "utf8",
    timeout: 30_000,
    cwd: REPO_ROOT,
  });
  // The script prints the run dir as its last stdout line.
  const stdout = r.stdout ?? "";
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  return { stdout, stderr: r.stderr ?? "", runDir: lastLine };
}

function writeCorpus(rows: string[]): string {
  const p = join(tmpOut, "test-corpus.txt");
  writeFileSync(p, rows.join("\n") + "\n");
  return p;
}

test("prep: wipes clean-slate dirs by default", () => {
  const corpus = writeCorpus([
    "anchor | none | easy | dom-artifact | get top hn stories | https://news.ycombinator.com/",
  ]);
  const { runDir } = runPrep(["--limit", "1", "--iterations", "1"], corpus);
  expect(existsSync(join(runDir, "manifest.json"))).toBe(true);
  expect(existsSync(join(tmpHome, ".unbrowse/skill-snapshots/sentinel.json"))).toBe(false);
  expect(existsSync(join(tmpHome, ".unbrowse/queue/pending/sentinel.json"))).toBe(false);
  expect(existsSync(join(tmpHome, ".unbrowse/route-cache/sentinel.json"))).toBe(false);
});

test("prep: --keep-index preserves the existing index", () => {
  const corpus = writeCorpus([
    "anchor | none | easy | dom-artifact | x | https://example.com/",
  ]);
  const { runDir } = runPrep(["--limit", "1", "--iterations", "1", "--keep-index"], corpus);
  expect(existsSync(join(runDir, "manifest.json"))).toBe(true);
  expect(existsSync(join(tmpHome, ".unbrowse/skill-snapshots/sentinel.json"))).toBe(true);
});

test("prep: emits one subagent.prompt.md + context.json per probe", () => {
  const corpus = writeCorpus([
    "anchor | none | easy | dom-artifact | a | https://example.com/",
    "anchor | none | easy | dom-artifact | b | https://example.org/",
    "anchor | none | easy | dom-artifact | c | https://example.net/",
  ]);
  const { runDir } = runPrep(["--iterations", "2"], corpus);
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  expect(manifest.transport).toBe("mcp");
  expect(manifest.driver).toBe("subagent");
  expect(manifest.iterations).toBe(2);
  expect(manifest.probes.length).toBe(3);
  for (const p of manifest.probes) {
    const dir = join(runDir, p.probe_id);
    expect(existsSync(join(dir, "subagent.prompt.md"))).toBe(true);
    expect(existsSync(join(dir, "subagent.context.json"))).toBe(true);
    const ctx = JSON.parse(readFileSync(join(dir, "subagent.context.json"), "utf8"));
    expect(ctx.probe_id).toBe(p.probe_id);
    expect(ctx.result_path).toContain("subagent.result.json");
    expect(ctx.iterations).toBe(2);
    const prompt = readFileSync(join(dir, "subagent.prompt.md"), "utf8");
    // The prompt must instruct the subagent to use MCP tools only and
    // must reference the canonical loop steps.
    expect(prompt).toContain("mcp__unbrowse__unbrowse_resolve");
    expect(prompt).toContain("mcp__unbrowse__unbrowse_go");
    expect(prompt).toContain("mcp__unbrowse__unbrowse_close");
    expect(prompt).toContain("mcp__unbrowse__unbrowse_execute");
    expect(prompt).toContain("Do NOT use the unbrowse CLI");
  }
});

test("collector: consolidates per-probe results into verdict.json that the validator accepts", () => {
  const corpus = writeCorpus([
    "anchor | none | easy | dom-artifact | a | https://a.example.com/",
    "anchor | none | easy | dom-artifact | b | https://b.example.com/",
  ]);
  const { runDir } = runPrep(["--iterations", "1"], corpus);
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));

  // Write a minimal real-shape subagent.result.json for each probe.
  for (const p of manifest.probes) {
    const result = {
      probe_id: p.probe_id,
      lane: p.lane,
      intent: p.intent,
      url: p.url,
      iterations: [
        {
          iteration: 1,
          pre_index_resolve: "MISS",
          phases: {
            browse: { status: "ok", ms: 1234, notes: "rendered" },
            publish: { status: "ok", endpoints_published: 2 },
            resolve_after_publish: { available_endpoints: 2, skill_id: "abc" },
            execute: { status_code: 200, response_bytes: 4096, looks_relevant: true },
          },
          outcome: "PASS",
          evidence_quote: "[{...real-shape stub from test...}]",
        },
      ],
      stability: "STABLE",
      summary: "test stub — both iterations pass",
    };
    writeFileSync(
      join(runDir, p.probe_id, "subagent.result.json"),
      JSON.stringify(result),
    );
  }

  const collect = spawnSync("bun", [COLLECT, "--artifacts", runDir], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: REPO_ROOT,
  });
  expect(collect.status).toBe(0);

  const verdictPath = join(runDir, "verdict.json");
  const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
  expect(verdict.run_id).toBeDefined();
  expect(Array.isArray(verdict.verdicts)).toBe(true);
  expect(verdict.verdicts.length).toBe(2);
  for (const v of verdict.verdicts) {
    expect(v.index_verdict).toBe("INDEX_PASS");
    expect(v.retrieve_verdict).toBe("RETRIEVE_PASS");
    expect(v.suspicious).toBe(false);
  }

  // Validator must accept it.
  const validate = spawnSync("bun", [VALIDATE, "--validate", "--artifacts", runDir], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: REPO_ROOT,
  });
  expect(validate.status).toBe(0);
});

test("collector: flags FLAKY runs as suspicious even when iter-1 passed", () => {
  const corpus = writeCorpus([
    "anchor | none | easy | dom-artifact | flaky | https://flaky.example/",
  ]);
  const { runDir } = runPrep(["--iterations", "2"], corpus);
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  const p = manifest.probes[0];

  writeFileSync(
    join(runDir, p.probe_id, "subagent.result.json"),
    JSON.stringify({
      probe_id: p.probe_id,
      iterations: [
        {
          iteration: 1,
          phases: {
            publish: { status: "ok", endpoints_published: 1 },
            resolve_after_publish: { available_endpoints: 1, skill_id: "x" },
            execute: { status_code: 200, response_bytes: 100, looks_relevant: true },
          },
          outcome: "PASS",
          evidence_quote: "ok",
        },
        {
          iteration: 2,
          phases: { execute: { status_code: 500, response_bytes: 0, looks_relevant: false } },
          outcome: "FAIL_EXECUTE_ERROR",
          evidence_quote: "500",
        },
      ],
      stability: "FLAKY",
      summary: "iter 2 hit a 500",
    }),
  );

  const collect = spawnSync("bun", [COLLECT, "--artifacts", runDir], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: REPO_ROOT,
  });
  expect(collect.status).toBe(0);
  const v = JSON.parse(readFileSync(join(runDir, "verdict.json"), "utf8")).verdicts[0];
  expect(v.index_verdict).toBe("INDEX_PASS");
  expect(v.retrieve_verdict).toBe("RETRIEVE_PASS");
  // The PASS labels come from iter-1, but the FLAKY stability must
  // bubble up as "suspicious: true" so the parent re-audits.
  expect(v.suspicious).toBe(true);
});
