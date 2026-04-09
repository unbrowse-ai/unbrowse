#!/usr/bin/env bun
/**
 * Version regression runner — installs each published CLI version in isolation,
 * runs a standard capability matrix, and archives results for regression tracking.
 *
 * Usage:
 *   bun evals/version-regression.ts                          # run all stable versions
 *   bun evals/version-regression.ts --from 2.12.0            # start from version
 *   bun evals/version-regression.ts --versions 3.0.0,3.1.0   # specific versions only
 *   bun evals/version-regression.ts --latest 5               # last N stable versions
 *   bun evals/version-regression.ts --skill /path/to/SKILL.md # load a skill file
 *   bun evals/version-regression.ts --results                # show saved results table
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "fs";
import { join, dirname } from "path";
import { appendRun, loadHistory, type RunRecord, type CaseSnapshot } from "./regression-tracker.js";

const EVALS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(EVALS_DIR, "..");
const RESULTS_PATH = join(EVALS_DIR, "version-regression-last-run.json");
const HISTORY_HARNESS = "version";

// ── Capability test cases ────────────────────────────────────────────────────

interface CapabilityCase {
  id: string;
  description: string;
  /** CLI args to pass to the unbrowse binary */
  args: string[];
  /** Timeout in ms */
  timeout: number;
  /** How to judge the output */
  judge: (result: CliResult) => "pass" | "fail";
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  body: any;
  duration_ms: number;
  error?: string;
}

const CASES: CapabilityCase[] = [
  {
    id: "version-flag",
    description: "CLI responds to --version",
    args: ["--version"],
    timeout: 10_000,
    judge: (r) => r.code === 0 && /^\d+\.\d+\.\d+/.test(r.stdout.trim()) ? "pass" : "fail",
  },
  {
    id: "health-check",
    description: "Server starts and health endpoint responds",
    args: ["health"],
    timeout: 30_000,
    judge: (r) => r.code === 0 ? "pass" : "fail",
  },
  {
    id: "skills-list",
    description: "Skills listing returns without error",
    args: ["skills"],
    timeout: 30_000,
    judge: (r) => r.code === 0 ? "pass" : "fail",
  },
  {
    id: "resolve-github",
    description: "Resolve: search repositories on github.com",
    args: ["resolve", "--intent", "search repositories", "--url", "https://github.com/search?q=openai&type=repositories", "--json"],
    timeout: 60_000,
    judge: (r) => {
      if (r.code !== 0) return "fail";
      // Has available_endpoints or result data
      if (r.body?.available_endpoints?.length > 0) return "pass";
      if (r.body?.result) return "pass";
      if (r.body?.skill) return "pass";
      return "fail";
    },
  },
  {
    id: "resolve-npm",
    description: "Resolve: get package info on npmjs.com",
    args: ["resolve", "--intent", "get package info", "--url", "https://www.npmjs.com/package/openai", "--json"],
    timeout: 60_000,
    judge: (r) => {
      if (r.code !== 0) return "fail";
      if (r.body?.available_endpoints?.length > 0) return "pass";
      if (r.body?.result) return "pass";
      if (r.body?.skill) return "pass";
      return "fail";
    },
  },
  {
    id: "resolve-pypi",
    description: "Resolve: get package info on pypi.org",
    args: ["resolve", "--intent", "get package info", "--url", "https://pypi.org/project/openai/", "--json"],
    timeout: 60_000,
    judge: (r) => {
      if (r.code !== 0) return "fail";
      if (r.body?.available_endpoints?.length > 0) return "pass";
      if (r.body?.result) return "pass";
      if (r.body?.skill) return "pass";
      return "fail";
    },
  },
  {
    id: "resolve-hn",
    description: "Resolve: search hacker news",
    args: ["resolve", "--intent", "search hacker news", "--url", "https://hn.algolia.com/", "--params", '{"q":"openai"}', "--json"],
    timeout: 60_000,
    judge: (r) => {
      if (r.code !== 0) return "fail";
      if (r.body?.available_endpoints?.length > 0) return "pass";
      if (r.body?.result) return "pass";
      if (r.body?.skill) return "pass";
      return "fail";
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getStableVersions(): string[] {
  const raw = execSync("npm view unbrowse versions --json", { encoding: "utf-8" });
  const all: string[] = JSON.parse(raw);
  return all.filter((v) => !v.includes("-")); // exclude previews, experiments, etc.
}

function semverCompare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function runBinary(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeout: number,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      });
    } catch (e) {
      resolve({
        code: 1,
        stdout: "",
        stderr: "",
        body: {},
        duration_ms: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill("SIGKILL"); } catch {}
        resolve({
          code: 1,
          stdout,
          stderr,
          body: {},
          duration_ms: Date.now() - start,
          error: `timeout after ${timeout}ms`,
        });
      }
    }, timeout);

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (d) => { stdout += d; });
    proc.stderr?.on("data", (d) => { stderr += d; });
    proc.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          code: 1,
          stdout,
          stderr,
          body: {},
          duration_ms: Date.now() - start,
          error: e.message,
        });
      }
    });
    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        let body: any = {};
        try { body = JSON.parse(stdout.trim() || "{}"); } catch {}
        resolve({ code: code ?? 1, stdout, stderr, body, duration_ms: Date.now() - start });
      }
    });
  });
}

// ── Per-version test runner ──────────────────────────────────────────────────

interface VersionResult {
  version: string;
  install_ok: boolean;
  install_error?: string;
  cases: Record<string, { status: "pass" | "fail" | "skip"; ms: number; reason?: string }>;
  total_ms: number;
}

async function testVersion(version: string, skillPath?: string): Promise<VersionResult> {
  const tmpDir = join(ROOT, "tmp", `unbrowse-${version}-${Date.now()}`);
  const start = Date.now();
  const result: VersionResult = {
    version,
    install_ok: false,
    cases: {},
    total_ms: 0,
  };

  try {
    // 1. Create isolated install dir
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: `unbrowse-test-${version}`, private: true }));

    console.log(`  [${version}] Installing...`);
    try {
      execSync(`npm install unbrowse@${version} --no-save --ignore-scripts=false`, {
        cwd: tmpDir,
        encoding: "utf-8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      result.install_ok = true;
    } catch (e) {
      result.install_error = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      console.log(`  [${version}] Install failed: ${result.install_error.slice(0, 80)}`);
      // Mark all cases as skip
      for (const c of CASES) {
        result.cases[c.id] = { status: "skip", ms: 0, reason: "install failed" };
      }
      result.total_ms = Date.now() - start;
      return result;
    }

    const binPath = join(tmpDir, "node_modules", ".bin", "unbrowse");
    if (!existsSync(binPath)) {
      result.install_error = "binary not found after install";
      for (const c of CASES) {
        result.cases[c.id] = { status: "skip", ms: 0, reason: "binary not found" };
      }
      result.total_ms = Date.now() - start;
      return result;
    }

    // Copy skill file into the test dir if provided
    if (skillPath && existsSync(skillPath)) {
      cpSync(skillPath, join(tmpDir, "SKILL.md"));
    }

    // Use a unique port per version to avoid conflicts
    const port = 19200 + Math.floor(Math.random() * 800);
    const env: Record<string, string> = {
      UNBROWSE_PORT: String(port),
      UNBROWSE_HOST: "127.0.0.1",
      HOME: process.env.HOME ?? "/tmp",
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      // Suppress telemetry in test runs
      UNBROWSE_TELEMETRY: "off",
      DO_NOT_TRACK: "1",
    };

    // 2. Run each capability case
    console.log(`  [${version}] Running ${CASES.length} capability tests (port ${port})...`);

    let serverProc: ChildProcess | null = null;

    for (const testCase of CASES) {
      const caseStart = Date.now();
      try {
        const cliResult = await runBinary(binPath, testCase.args, env, testCase.timeout);
        const status = testCase.judge(cliResult);
        result.cases[testCase.id] = {
          status,
          ms: cliResult.duration_ms,
          reason: status === "fail"
            ? (cliResult.error ?? (cliResult.stderr.slice(0, 150) || `exit=${cliResult.code}`))
            : undefined,
        };
      } catch (e) {
        result.cases[testCase.id] = {
          status: "fail",
          ms: Date.now() - caseStart,
          reason: e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150),
        };
      }

      const c = result.cases[testCase.id];
      const icon = c.status === "pass" ? "\x1b[32m✓\x1b[0m" : c.status === "fail" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m-\x1b[0m";
      console.log(`    ${icon} ${testCase.id} (${c.ms}ms)${c.reason ? ` — ${c.reason.slice(0, 60)}` : ""}`);
    }

    // Kill any server the CLI might have auto-started on our port
    try {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { encoding: "utf-8", timeout: 5_000 });
    } catch {}

  } finally {
    // Cleanup
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    result.total_ms = Date.now() - start;
  }

  return result;
}

// ── Archive version results ──────────────────────────────────────────────────

function archiveVersionResult(vr: VersionResult): void {
  const cases: Record<string, CaseSnapshot> = {};
  for (const [id, c] of Object.entries(vr.cases)) {
    cases[id] = { status: c.status, ms: c.ms, reason: c.reason };
  }

  const caseList = Object.values(cases);
  const record: RunRecord = {
    ts: new Date().toISOString(),
    sha: vr.version, // Use version as the "sha" for version runs
    branch: "npm",
    version: vr.version,
    harness: HISTORY_HARNESS,
    summary: {
      total: caseList.length,
      pass: caseList.filter((c) => c.status === "pass").length,
      fail: caseList.filter((c) => c.status === "fail").length,
      skip: caseList.filter((c) => c.status === "skip").length,
      install_ok: vr.install_ok,
    },
    cases,
  };

  appendRun(record);
}

// ── Results display ──────────────────────────────────────────────────────────

function statusChar(s: string): string {
  switch (s) {
    case "pass": return "\x1b[32m✓\x1b[0m";
    case "fail": return "\x1b[31m✗\x1b[0m";
    case "skip": return "\x1b[33m-\x1b[0m";
    default: return "?";
  }
}

function printVersionMatrix(results: VersionResult[]): void {
  if (results.length === 0) return;

  const caseIds = CASES.map((c) => c.id);
  const maxIdLen = Math.max(...caseIds.map((id) => id.length), 20);

  console.log("\n  Version Capability Matrix\n");

  // Header
  const versionLabels = results.map((r) => r.version.padStart(8));
  console.log(`  ${"Capability".padEnd(maxIdLen)}  ${versionLabels.join("  ")}`);
  console.log("  " + "─".repeat(maxIdLen + results.length * 10 + 2));

  // Rows
  for (const caseId of caseIds) {
    const cells = results.map((r) => {
      const c = r.cases[caseId];
      return c ? `   ${statusChar(c.status)}    ` : "   ?    ";
    });
    console.log(`  ${caseId.padEnd(maxIdLen)}  ${cells.join("")}`);
  }

  // Summary row
  console.log("  " + "─".repeat(maxIdLen + results.length * 10 + 2));
  const rates = results.map((r) => {
    const total = Object.keys(r.cases).length;
    const pass = Object.values(r.cases).filter((c) => c.status === "pass").length;
    return total > 0 ? `  ${((pass / total) * 100).toFixed(0).padStart(3)}%   ` : "   N/A   ";
  });
  console.log(`  ${"Pass rate".padEnd(maxIdLen)}  ${rates.join("")}`);
  console.log();
}

function printSavedResults(): void {
  const history = loadHistory(HISTORY_HARNESS);
  if (history.length === 0) {
    console.log("\n  No version regression results found.\n");
    return;
  }

  const caseIds = [...new Set(history.flatMap((h) => Object.keys(h.cases)))].sort();
  const maxIdLen = Math.max(...caseIds.map((id) => id.length), 20);

  console.log(`\n  Version Regression History — ${history.length} runs\n`);

  const labels = history.map((h) => h.version.padStart(8));
  console.log(`  ${"Capability".padEnd(maxIdLen)}  ${labels.join("  ")}`);
  console.log("  " + "─".repeat(maxIdLen + history.length * 10 + 2));

  for (const caseId of caseIds) {
    const cells = history.map((h) => {
      const c = h.cases[caseId];
      return c ? `   ${statusChar(c.status)}    ` : "   ?    ";
    });
    console.log(`  ${caseId.padEnd(maxIdLen)}  ${cells.join("")}`);
  }

  console.log("  " + "─".repeat(maxIdLen + history.length * 10 + 2));
  const rates = history.map((h) => {
    const total = Object.keys(h.cases).length;
    const pass = Object.values(h.cases).filter((c: any) => c.status === "pass").length;
    return total > 0 ? `  ${((pass / total) * 100).toFixed(0).padStart(3)}%   ` : "   N/A   ";
  });
  console.log(`  ${"Pass rate".padEnd(maxIdLen)}  ${rates.join("")}`);
  console.log();
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  Version Regression Runner — test capabilities across published CLI versions

  Usage:
    bun evals/version-regression.ts                          # all stable versions from 2.8.0+
    bun evals/version-regression.ts --from 3.0.0             # versions >= 3.0.0
    bun evals/version-regression.ts --versions 3.0.0,3.1.0   # specific versions
    bun evals/version-regression.ts --latest 5               # last 5 stable versions
    bun evals/version-regression.ts --skill /path/to/SKILL.md # copy skill into test dir
    bun evals/version-regression.ts --results                # show saved results matrix

  Options:
    --from VERSION      Only test versions >= this (default: 2.8.0)
    --versions A,B,C    Test only these specific versions
    --latest N          Test last N stable versions
    --skill PATH        Copy this file as SKILL.md into each test dir
    --results           Print saved results matrix and exit
    --concurrency N     Parallel version installs (default: 1)
`);
    process.exit(0);
  }

  // Results-only mode
  if (args.includes("--results")) {
    printSavedResults();
    process.exit(0);
  }

  // Determine which versions to test
  let versions: string[];

  if (args.includes("--versions")) {
    versions = args[args.indexOf("--versions") + 1].split(",");
  } else {
    const all = getStableVersions();
    const from = args.includes("--from")
      ? args[args.indexOf("--from") + 1]
      : "2.8.0";

    versions = all.filter((v) => semverCompare(v, from) >= 0);

    if (args.includes("--latest")) {
      const n = parseInt(args[args.indexOf("--latest") + 1], 10) || 5;
      versions = versions.slice(-n);
    }
  }

  versions.sort(semverCompare);

  const skillPath = args.includes("--skill")
    ? args[args.indexOf("--skill") + 1]
    : undefined;

  console.log(`\n  Testing ${versions.length} versions: ${versions.join(", ")}`);
  if (skillPath) console.log(`  Skill: ${skillPath}`);
  console.log();

  const results: VersionResult[] = [];

  for (const version of versions) {
    const vr = await testVersion(version, skillPath);
    results.push(vr);
    archiveVersionResult(vr);
    console.log(`  [${version}] Done in ${(vr.total_ms / 1000).toFixed(1)}s\n`);
  }

  // Write full results
  writeFileSync(RESULTS_PATH, JSON.stringify({ ts: new Date().toISOString(), results }, null, 2));

  // Print matrix
  printVersionMatrix(results);

  // Detect regressions between consecutive versions
  const regressions: string[] = [];
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const curr = results[i];
    for (const [caseId, cSnap] of Object.entries(curr.cases)) {
      const pSnap = prev.cases[caseId];
      if (pSnap && pSnap.status === "pass" && cSnap.status !== "pass") {
        regressions.push(`  ${caseId}: ${prev.version} ✓ → ${curr.version} ✗${cSnap.reason ? ` (${cSnap.reason.slice(0, 60)})` : ""}`);
      }
    }
  }

  if (regressions.length > 0) {
    console.log(`  \x1b[31m${regressions.length} REGRESSION(S) ACROSS VERSIONS\x1b[0m\n`);
    for (const r of regressions) console.log(r);
    console.log();
  } else {
    console.log("  No regressions detected across tested versions.\n");
  }

  console.log(`  Results: ${RESULTS_PATH}`);
  console.log(`  History: evals/history/${HISTORY_HARNESS}.jsonl\n`);
}
