#!/usr/bin/env bun

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { spawn } from "node:child_process";

type CaseEntry = Record<string, unknown>;

type AutonomousArtifact = {
  summary?: {
    total?: number;
    pass?: number;
    fail?: number;
    skip?: number;
    blocked?: number;
    satisfied?: number;
    unsatisfied?: number;
    [key: string]: unknown;
  };
  results?: Array<Record<string, unknown>>;
};

type CampaignShard = {
  shard_index: number;
  start: number;
  count: number;
  cases_path: string;
  artifact_path: string;
};

type CampaignShardResult = {
  shard_index: number;
  start: number;
  count: number;
  cases_path: string;
  artifact_path: string;
  completed: boolean;
  resumed: boolean;
  exit_code?: number;
  summary?: AutonomousArtifact["summary"];
};

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const EVALS_DIR = dirname(new URL(import.meta.url).pathname);
const CAMPAIGNS_DIR = join(EVALS_DIR, "campaigns");

const argv = process.argv.slice(
  typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2,
);
const args = new Set(argv);
const getArg = (flag: string) => argv.find((_, i) => argv[i - 1] === `--${flag}`) ?? "";
const hasFlag = (flag: string) => args.has(`--${flag}`);

function usage(): never {
  console.error(
    "Usage:\n" +
    "  bun evals/codex-campaign-runner.ts --cases evals/codex-cases.product-success.json [opts]\n" +
    "Options:\n" +
    "  --artifact-dir <dir>   Output directory (default: evals/campaigns/<timestamp>)\n" +
    "  --start <n>            Zero-based case offset\n" +
    "  --count <n>            Number of cases to run from start\n" +
    "  --shard-size <n>       Cases per shard (default: 25)\n" +
    "  --resume               Skip completed shard artifacts\n" +
    "  --merge-only           Only merge existing shard artifacts\n" +
    "  --force-capture        Pass through to autonomous harness\n" +
    "  --benchmark            Pass through to autonomous harness\n" +
    "  --restart-server       Pass through to autonomous harness\n" +
    "  --max-rounds <n>       Pass through to autonomous harness\n" +
    "  --max-candidates <n>   Pass through to autonomous harness\n" +
    "  --max-follow-urls <n>  Pass through to autonomous harness\n",
  );
  process.exit(1);
}

function timestampLabel(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function caseEntries(raw: unknown): CaseEntry[] {
  if (Array.isArray(raw)) return raw.filter((entry): entry is CaseEntry => !!entry && typeof entry === "object");
  if (raw && typeof raw === "object" && Array.isArray((raw as { cases?: unknown[] }).cases)) {
    return (raw as { cases: unknown[] }).cases.filter((entry): entry is CaseEntry => !!entry && typeof entry === "object");
  }
  return [];
}

export function buildShardPlan(total: number, start: number, count: number, shardSize: number): Array<{ start: number; count: number }> {
  const plan: Array<{ start: number; count: number }> = [];
  const boundedStart = Math.max(0, Math.min(start, total));
  const boundedCount = Math.max(0, Math.min(count, total - boundedStart));
  for (let offset = 0; offset < boundedCount; offset += shardSize) {
    plan.push({
      start: boundedStart + offset,
      count: Math.min(shardSize, boundedCount - offset),
    });
  }
  return plan;
}

function shardArtifacts(artifactDir: string, entries: CaseEntry[], start: number, count: number, shardSize: number): CampaignShard[] {
  return buildShardPlan(entries.length, start, count, shardSize).map((item, index) => {
    const slice = entries.slice(item.start, item.start + item.count);
    const label = `${String(index + 1).padStart(3, "0")}-${String(item.start).padStart(4, "0")}-${String(item.count).padStart(3, "0")}`;
    const casesPath = join(artifactDir, `cases.${label}.json`);
    const artifactPath = join(artifactDir, `artifact.${label}.json`);
    writeFileSync(casesPath, JSON.stringify({ cases: slice }, null, 2));
    return {
      shard_index: index + 1,
      start: item.start,
      count: item.count,
      cases_path: casesPath,
      artifact_path: artifactPath,
    };
  });
}

function artifactComplete(path: string, expectedCount: number): boolean {
  if (!existsSync(path)) return false;
  try {
    const artifact = readJson(path) as AutonomousArtifact;
    return Number(artifact.summary?.total ?? 0) === expectedCount && Array.isArray(artifact.results);
  } catch {
    return false;
  }
}

function spawnHarness(args: string[]): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("bun", args, {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    });
    proc.on("error", rejectPromise);
    proc.on("close", (code) => resolvePromise(code ?? 1));
  });
}

function passThroughFlags(): string[] {
  const next: string[] = [];
  if (hasFlag("force-capture")) next.push("--force-capture");
  if (hasFlag("benchmark")) next.push("--benchmark");
  if (hasFlag("restart-server")) next.push("--restart-server");
  for (const flag of ["max-rounds", "max-candidates", "max-follow-urls"] as const) {
    const value = getArg(flag);
    if (value) next.push(`--${flag}`, value);
  }
  return next;
}

export function mergeCampaignArtifacts(shards: CampaignShardResult[]): {
  summary: Record<string, unknown>;
  shards: CampaignShardResult[];
  results: Array<Record<string, unknown>>;
} {
  const artifacts = shards
    .filter((shard) => shard.completed && existsSync(shard.artifact_path))
    .map((shard) => ({ shard, artifact: readJson(shard.artifact_path) as AutonomousArtifact }));
  const results = artifacts.flatMap(({ artifact }) => Array.isArray(artifact.results) ? artifact.results : []);
  return {
    summary: {
      total_cases: shards.reduce((sum, shard) => sum + shard.count, 0),
      completed_cases: artifacts.reduce((sum, { shard }) => sum + shard.count, 0),
      completed_shards: artifacts.length,
      total_shards: shards.length,
      pass: results.filter((result) => result.final_state === "pass").length,
      fail: results.filter((result) => result.final_state === "fail").length,
      skip: results.filter((result) => result.final_state === "skip").length,
      blocked: results.filter((result) => result.final_state === "blocked").length,
      satisfied: results.filter((result) => result.goal_satisfied === true).length,
      unsatisfied: results.filter((result) => result.goal_satisfied !== true).length,
      mode: "campaign",
    },
    shards,
    results,
  };
}

async function run(): Promise<void> {
  const casesArg = getArg("cases");
  if (!casesArg) usage();

  const casesPath = resolve(ROOT, casesArg);
  const raw = readJson(casesPath);
  const entries = caseEntries(raw);
  if (entries.length === 0) throw new Error(`no valid cases in ${casesPath}`);

  ensureDir(CAMPAIGNS_DIR);
  const artifactDir = resolve(
    ROOT,
    getArg("artifact-dir") || join("evals", "campaigns", `campaign-${timestampLabel()}`),
  );
  ensureDir(artifactDir);

  const start = Math.max(0, Number(getArg("start") || "0") || 0);
  const count = Math.max(0, Number(getArg("count") || String(Math.max(0, entries.length - start))) || 0);
  const shardSize = Math.max(1, Number(getArg("shard-size") || "25") || 25);
  const resume = hasFlag("resume");
  const mergeOnly = hasFlag("merge-only");

  const shards = shardArtifacts(artifactDir, entries, start, count, shardSize);
  const shardResults: CampaignShardResult[] = [];
  const forwarded = passThroughFlags();

  for (const shard of shards) {
    const resumed = resume && artifactComplete(shard.artifact_path, shard.count);
    if (!mergeOnly && !resumed) {
      const exitCode = await spawnHarness([
        "evals/codex-autonomous-harness.ts",
        "--cases", shard.cases_path,
        "--out", shard.artifact_path,
        ...forwarded,
      ]);
      const summary = existsSync(shard.artifact_path)
        ? (readJson(shard.artifact_path) as AutonomousArtifact).summary
        : undefined;
      shardResults.push({
        ...shard,
        completed: exitCode === 0 || !!summary,
        resumed: false,
        exit_code: exitCode,
        summary,
      });
      if (exitCode !== 0 && !existsSync(shard.artifact_path)) break;
    } else {
      const summary = existsSync(shard.artifact_path)
        ? (readJson(shard.artifact_path) as AutonomousArtifact).summary
        : undefined;
      shardResults.push({
        ...shard,
        completed: !!summary,
        resumed,
        summary,
      });
    }
  }

  const merged = mergeCampaignArtifacts(shardResults);
  const mergedPath = join(artifactDir, "campaign-merged.json");
  const statePath = join(artifactDir, "campaign-state.json");
  writeFileSync(mergedPath, JSON.stringify({
    summary: {
      ...merged.summary,
      source_cases_path: casesPath,
      artifact_dir: artifactDir,
      shard_size: shardSize,
      start,
      count,
      resume,
    },
    shards: merged.shards,
    results: merged.results,
  }, null, 2));
  writeFileSync(statePath, JSON.stringify({
    source_cases_path: casesPath,
    artifact_dir: artifactDir,
    shard_size: shardSize,
    start,
    count,
    resume,
    shards: shardResults,
    merged_path: mergedPath,
  }, null, 2));

  console.log(`[codex-campaign] shards=${shardResults.length} completed=${merged.summary.completed_shards} results=${merged.results.length} merged=${mergedPath}`);
  process.exit(Number(merged.summary.unsatisfied ?? 0) > 0 ? 1 : 0);
}

if (import.meta.main) {
  await run().catch((error) => {
    console.error("[codex-campaign] fatal", error);
    process.exit(1);
  });
}
