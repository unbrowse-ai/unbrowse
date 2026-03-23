#!/usr/bin/env bun

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WEBARENA_ENV,
  DEFAULT_WEBARENA_VERIFIED_DIR,
  loadWebArenaVerifiedTasks,
  renderTaskStartUrls,
  type WebArenaExpectedStatus,
  type WebArenaTask,
  type WebArenaTaskType,
} from "../evals/webarena-verified-lib.js";

type AdaptedWebArenaCase = {
  id: string;
  benchmark_task_id: number;
  suite: "webarena-verified";
  task_type: WebArenaTaskType;
  status: WebArenaExpectedStatus;
  sites: string[];
  tags: string[];
  start_urls: string[];
  rendered_start_urls: string[];
  url: string;
  intent: string;
  expected_fields: string[];
  validate: {
    terminal_ok: string[];
    min_rows?: number;
  };
  benchmark: {
    retrieved_data: unknown;
    network: WebArenaTask["network"];
    intent_template_id?: number;
  };
};

type AdaptedWebArenaCorpus = {
  meta: {
    name: string;
    description: string;
    generated_at: string;
    source: {
      repo_dir: string;
      dataset_path: string;
      hard_subset_path: string;
    };
    counts: {
      total: number;
      hard_subset: number;
      stable_env_candidate: number;
      stable_env_hard_subset: number;
      single_site_stable_env_candidate: number;
      by_task_type: Record<string, number>;
      by_site_combo: Record<string, number>;
    };
    adaptation_notes: string[];
  };
  cases: AdaptedWebArenaCase[];
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT = join(ROOT, "evals", "codex-cases.webarena-verified.adapted.json");

function getArg(flag: string): string {
  const argv = process.argv.slice(typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2);
  return argv.find((_, index) => argv[index - 1] === `--${flag}`) ?? "";
}

function hasFlag(flag: string): boolean {
  const argv = process.argv.slice(typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2);
  return argv.includes(`--${flag}`);
}

function loadHardSubsetIds(repoDir: string): Set<number> {
  const subsetPath = join(repoDir, "assets", "dataset", "subsets", "webarena-verified-hard.json");
  const raw = JSON.parse(readFileSync(subsetPath, "utf-8")) as { task_ids?: number[] };
  return new Set((raw.task_ids ?? []).map((taskId) => Math.trunc(taskId)));
}

function inferExpectedFields(task: WebArenaTask): string[] {
  const value = task.agent.retrieved_data;
  if (Array.isArray(value)) {
    if (value.length === 0) return task.agent.task_type === "retrieve" ? ["value"] : ["status"];
    if (value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const fields = new Set<string>();
      for (const item of value.slice(0, 5) as Array<Record<string, unknown>>) {
        for (const key of Object.keys(item)) fields.add(key);
      }
      return [...fields].sort();
    }
    return ["value"];
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort();
  }
  if (task.agent.task_type === "retrieve") return ["value"];
  return ["status"];
}

function terminalOk(status: WebArenaExpectedStatus): string[] {
  switch (status) {
    case "SUCCESS":
      return ["pass"];
    case "PERMISSION_DENIED_ERROR":
    case "ACTION_NOT_ALLOWED_ERROR":
      return ["blocked", "fail"];
    default:
      return ["fail", "blocked"];
  }
}

function siteCombo(task: WebArenaTask): string {
  return task.sites.join("+");
}

function stableEnvCandidate(task: WebArenaTask): boolean {
  return task.sites.every((site) => ["shopping", "shopping_admin", "reddit"].includes(site));
}

function adaptTask(task: WebArenaTask, hardSubset: Set<number>): AdaptedWebArenaCase {
  const rendered = renderTaskStartUrls(task, DEFAULT_WEBARENA_ENV);
  const tags = [
    task.agent.task_type,
    ...task.sites.map((site) => `site:${site}`),
    ...(hardSubset.has(task.task_id) ? ["hard_subset"] : []),
    ...(stableEnvCandidate(task) ? ["stable_env_candidate"] : []),
    ...(task.sites.length === 1 ? ["single_site"] : ["multi_site"]),
  ];

  return {
    id: `webarena-verified-${task.task_id}`,
    benchmark_task_id: task.task_id,
    suite: "webarena-verified",
    task_type: task.agent.task_type,
    status: task.agent.status,
    sites: task.sites,
    tags,
    start_urls: task.start_urls,
    rendered_start_urls: rendered,
    url: rendered[0] ?? task.start_urls[0] ?? "",
    intent: task.intent,
    expected_fields: inferExpectedFields(task),
    validate: {
      terminal_ok: terminalOk(task.agent.status),
      ...(task.agent.task_type === "retrieve" ? { min_rows: 1 } : {}),
    },
    benchmark: {
      retrieved_data: task.agent.retrieved_data,
      network: task.network,
      ...(task.intent_template_id != null ? { intent_template_id: task.intent_template_id } : {}),
    },
  };
}

export function adaptWebArenaVerified(repoDir = DEFAULT_WEBARENA_VERIFIED_DIR): AdaptedWebArenaCorpus {
  const resolvedRepoDir = resolve(repoDir);
  const datasetPath = join(resolvedRepoDir, "assets", "dataset", "webarena-verified.json");
  const hardSubsetPath = join(resolvedRepoDir, "assets", "dataset", "subsets", "webarena-verified-hard.json");
  const generatedAt = new Date(Math.max(
    statSync(datasetPath).mtimeMs,
    statSync(hardSubsetPath).mtimeMs,
  )).toISOString();

  const tasks = loadWebArenaVerifiedTasks({ repo_dir: resolvedRepoDir, subset: "full" });
  const hardSubset = loadHardSubsetIds(resolvedRepoDir);
  const byTaskType: Record<string, number> = {};
  const bySiteCombo: Record<string, number> = {};
  let stable = 0;
  let stableHard = 0;
  let stableSingle = 0;
  for (const task of tasks) {
    byTaskType[task.agent.task_type] = (byTaskType[task.agent.task_type] ?? 0) + 1;
    const combo = siteCombo(task);
    bySiteCombo[combo] = (bySiteCombo[combo] ?? 0) + 1;
    if (stableEnvCandidate(task)) {
      stable += 1;
      if (hardSubset.has(task.task_id)) stableHard += 1;
      if (task.sites.length === 1) stableSingle += 1;
    }
  }

  return {
    meta: {
      name: "WebArena-Verified Adapted Corpus",
      description: "Repo-local adaptation of the official WebArena-Verified dataset. Preserves task/site/agent/network truth and adds repo-native ids, rendered start URLs, expected_fields, and tags for slicing the full benchmark inside Unbrowse eval workflows.",
      generated_at: generatedAt,
      source: {
        repo_dir: resolvedRepoDir,
        dataset_path: datasetPath,
        hard_subset_path: hardSubsetPath,
      },
      counts: {
        total: tasks.length,
        hard_subset: hardSubset.size,
        stable_env_candidate: stable,
        stable_env_hard_subset: stableHard,
        single_site_stable_env_candidate: stableSingle,
        by_task_type: byTaskType,
        by_site_combo: bySiteCombo,
      },
      adaptation_notes: [
        "Uses the official WebArena-Verified dataset as the source of truth for intent, status, retrieved_data, and network expectations.",
        "Adds repo-native ids, rendered start URLs, expected_fields, and slice tags so benchmark tasks can live inside the Unbrowse eval corpus layout.",
        "stable_env_candidate tags the task families currently compatible with the locally healthy benchmark envs: shopping, shopping_admin, and reddit.",
        "This file is broader than eval:core. Keep eval:core curated; use this corpus for benchmark slicing and future promotion work.",
      ],
    },
    cases: tasks.map((task) => adaptTask(task, hardSubset)),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

if (import.meta.main) {
  const repoDir = resolve(getArg("repo-dir") || DEFAULT_WEBARENA_VERIFIED_DIR);
  const outPath = resolve(getArg("out") || DEFAULT_OUT);
  const next = stableStringify(adaptWebArenaVerified(repoDir));
  if (hasFlag("check")) {
    const current = readFileSync(outPath, "utf-8");
    if (current !== next) {
      console.error(`[adapt-webarena-verified] out of date: ${outPath}`);
      process.exit(1);
    }
    console.log(`[adapt-webarena-verified] up to date: ${outPath}`);
    process.exit(0);
  }
  writeFileSync(outPath, next, "utf-8");
  console.log(`[adapt-webarena-verified] wrote ${outPath}`);
}
