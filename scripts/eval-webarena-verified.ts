#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { executeSkill, rankEndpoints } from "../src/execution/index.js";
import { resolveAndExecute } from "../src/orchestrator/index.js";
import type { DeferredEndpoint } from "../evals/codex-harness-lib.js";
import {
  judgeWebArenaTask,
  loadWebArenaVerifiedTasks,
  renderTaskStartUrls,
  resolveWebArenaEnvMap,
  type WebArenaExpectedStatus,
} from "../evals/webarena-verified-lib.js";

type RunRecord = {
  task_id: number;
  sites: string[];
  intent: string;
  url: string;
  available_endpoint_count: number;
  selected_endpoint_id?: string;
  selected_endpoint_url?: string;
  agent_status: WebArenaExpectedStatus;
  env_ready: boolean;
  judge: ReturnType<typeof judgeWebArenaTask>;
  error?: string;
};

const argv = process.argv.slice(typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2);
const args = new Set(argv);
const getArg = (flag: string) => argv.find((_, index) => argv[index - 1] === `--${flag}`) ?? "";
const hasFlag = (flag: string) => args.has(`--${flag}`);

const taskIdsArg = getArg("task-ids");
const taskIds = taskIdsArg
  ? taskIdsArg
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.trunc(value))
  : [];

const sitesArg = getArg("sites");
const sites = sitesArg
  ? sitesArg
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  : [];

const subsetArg = (getArg("subset") || "hard").toLowerCase();
const subset = subsetArg === "full" ? "full" : "hard";
const limit = Math.max(0, Number(getArg("limit") || "0") || 0);
const start = Math.max(0, Number(getArg("start") || "0") || 0);
const outPath = resolve(getArg("out") || `evals/webarena-verified-${subset}-last-run.json`);
const inventoryOnly = hasFlag("inventory") || hasFlag("dry-run");
const forceCapture = hasFlag("force-capture");
const envConfig = getArg("env-config");
const repoDir = getArg("repo-dir");

const env = resolveWebArenaEnvMap({
  ...(envConfig ? { env_file: envConfig } : {}),
  overrides: {
    ...(process.env.WA_SHOPPING_URL ? { __SHOPPING__: process.env.WA_SHOPPING_URL } : {}),
    ...(process.env.WA_SHOPPING_ADMIN_URL ? { __SHOPPING_ADMIN__: process.env.WA_SHOPPING_ADMIN_URL } : {}),
    ...(process.env.WA_REDDIT_URL ? { __REDDIT__: process.env.WA_REDDIT_URL } : {}),
    ...(process.env.WA_GITLAB_URL ? { __GITLAB__: process.env.WA_GITLAB_URL } : {}),
    ...(process.env.WA_WIKIPEDIA_URL ? { __WIKIPEDIA__: process.env.WA_WIKIPEDIA_URL } : {}),
    ...(process.env.WA_MAP_URL ? { __MAP__: process.env.WA_MAP_URL } : {}),
  },
});

const tasks = loadWebArenaVerifiedTasks({
  ...(repoDir ? { repo_dir: repoDir } : {}),
  subset,
  ...(taskIds.length > 0 ? { task_ids: taskIds } : {}),
  ...(sites.length > 0 ? { sites } : {}),
  ...(limit > 0 ? { limit } : {}),
  ...(start > 0 ? { start } : {}),
});

const hostProbeCache = new Map<string, boolean>();

function usage(): never {
  console.error(
    "Usage:\n" +
    "  bun scripts/eval-webarena-verified.ts --subset hard|full [--limit 5]\n" +
    "Options: --inventory --task-ids 1,2,3 --sites gitlab,reddit --env-config path --repo-dir path --start N --limit N --out path --force-capture",
  );
  process.exit(1);
}

async function isUrlReachable(url: string): Promise<boolean> {
  if (hostProbeCache.has(url)) return hostProbeCache.get(url)!;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2_500),
    });
    const ok = res.status > 0;
    hostProbeCache.set(url, ok);
    return ok;
  } catch {
    hostProbeCache.set(url, false);
    return false;
  }
}

function toDeferredEndpoint(skillDomain: string | undefined, ranked: ReturnType<typeof rankEndpoints>): DeferredEndpoint[] {
  return ranked.slice(0, 10).map((entry) => ({
    endpoint_id: entry.endpoint.endpoint_id,
    score: entry.score,
    trigger_url: entry.endpoint.trigger_url ?? null,
    url: entry.endpoint.url_template,
    description: entry.endpoint.description ?? `ranked endpoint for ${skillDomain ?? "unknown"}`,
  }));
}

function deriveAgentStatus(trace: { success: boolean; status_code?: number; error?: string }, result: unknown): WebArenaExpectedStatus {
  const resultError = result && typeof result === "object" && !Array.isArray(result)
    ? typeof (result as Record<string, unknown>).error === "string"
      ? String((result as Record<string, unknown>).error)
      : ""
    : "";
  const error = `${trace.error ?? ""} ${resultError}`.toLowerCase();
  if (trace.success) return "SUCCESS";
  if (trace.status_code === 401 || trace.status_code === 403 || error.includes("auth_required")) return "PERMISSION_DENIED_ERROR";
  if (trace.status_code === 404 || error.includes("no_endpoints") || error.includes("not_found")) return "NOT_FOUND_ERROR";
  if (error.includes("confirmation_required") || error.includes("action_not_allowed")) return "ACTION_NOT_ALLOWED_ERROR";
  if (error.includes("validation")) return "DATA_VALIDATION_ERROR";
  return "UNKNOWN_ERROR";
}

function extractRetrievedData(result: unknown): unknown {
  if (result == null) return null;
  if (Array.isArray(result)) return result;
  if (typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  for (const key of ["result", "data", "items"]) {
    if (record[key] != null) return record[key];
  }
  return result;
}

async function runTask(task: typeof tasks[number]): Promise<RunRecord> {
  const [url] = renderTaskStartUrls(task, env);
  const envReady = await isUrlReachable(url);
  if (!envReady) {
    const judge = judgeWebArenaTask({
      task,
      env,
      available_endpoints: [],
      network_events: [],
      agent_status: "UNKNOWN_ERROR",
      retrieved_data: null,
    });
    return {
      task_id: task.task_id,
      sites: task.sites,
      intent: task.intent,
      url,
      available_endpoint_count: 0,
      agent_status: "UNKNOWN_ERROR",
      env_ready: false,
      judge,
      error: "environment_unreachable",
    };
  }

  const resolved = await resolveAndExecute(task.intent, {}, { url }, { raw: true }, {
    force_capture: forceCapture,
    contextUrl: url,
    intent: task.intent,
    client_scope: "webarena-verified",
  });
  const ranked = resolved.skill ? rankEndpoints(resolved.skill.endpoints, task.intent, resolved.skill.domain, url) : [];
  const available = toDeferredEndpoint(resolved.skill?.domain, ranked);

  const selectedEndpointId = resolved.trace.endpoint_id || ranked[0]?.endpoint.endpoint_id;
  const selected = available.find((endpoint) => endpoint.endpoint_id === selectedEndpointId);
  let trace = resolved.trace;
  let actualResult = resolved.result;

  if ((!selectedEndpointId || !trace.network_events?.length) && resolved.skill && selectedEndpointId) {
    const executed = await executeSkill(
      resolved.skill,
      { endpoint_id: selectedEndpointId, url },
      { raw: true },
      { intent: task.intent, contextUrl: url, force_capture: forceCapture, client_scope: "webarena-verified" },
    );
    trace = executed.trace;
    actualResult = executed.result;
  }

  const agent_status = deriveAgentStatus(trace, actualResult);
  const judge = judgeWebArenaTask({
    task,
    env,
    available_endpoints: available,
    selected_endpoint: selected,
    network_events: trace.network_events ?? [],
    agent_status,
    retrieved_data: extractRetrievedData(actualResult),
  });

  return {
    task_id: task.task_id,
    sites: task.sites,
    intent: task.intent,
    url,
    available_endpoint_count: available.length,
    ...(selected?.endpoint_id ? { selected_endpoint_id: selected.endpoint_id } : {}),
    ...(selected?.url ? { selected_endpoint_url: selected.url } : {}),
    agent_status,
    env_ready: true,
    judge,
  };
}

async function main(): Promise<void> {
  if (tasks.length === 0) usage();

  const inventory = tasks.map((task) => ({
    task_id: task.task_id,
    sites: task.sites,
    task_type: task.agent.task_type,
    expected_status: task.agent.status,
    start_urls: renderTaskStartUrls(task, env),
    network_expectations: task.network.length,
  }));

  if (inventoryOnly) {
    const summary = {
      subset,
      total: inventory.length,
      env,
      inventory,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`[webarena-verified] inventory ${inventory.length} tasks -> ${outPath}`);
    return;
  }

  const results: RunRecord[] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    console.log(`[webarena-verified] ${index + 1}/${tasks.length} task=${task.task_id} sites=${task.sites.join(",")} intent=${task.intent}`);
    results.push(await runTask(task));
  }

  const pass = results.filter((result) => result.judge.ok).length;
  const blocked = results.filter((result) => !result.env_ready).length;
  const summary = {
    subset,
    total: results.length,
    pass,
    fail: results.length - pass,
    blocked,
    env,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));
  console.log(`[webarena-verified] pass=${pass}/${results.length} blocked=${blocked} -> ${outPath}`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[webarena-verified] fatal", error);
  process.exit(1);
});
