import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DeferredEndpoint } from "./codex-harness-lib.js";
import type { TraceNetworkEvent } from "../src/types/index.js";

export type WebArenaTaskType = "retrieve" | "navigate" | "mutate";
export type WebArenaExpectedStatus =
  | "SUCCESS"
  | "NOT_FOUND_ERROR"
  | "ACTION_NOT_ALLOWED_ERROR"
  | "PERMISSION_DENIED_ERROR"
  | "DATA_VALIDATION_ERROR"
  | "UNKNOWN_ERROR";

export type WebArenaAgentExpectation = {
  task_type: WebArenaTaskType;
  status: WebArenaExpectedStatus;
  retrieved_data: unknown;
};

export type WebArenaNetworkExpectation = {
  url: string | string[];
  http_method: string;
  response_status: number;
  headers?: Record<string, string>;
  post_data?: Record<string, unknown>;
  response_content?: Record<string, unknown>;
};

export type WebArenaTask = {
  task_id: number;
  sites: string[];
  start_urls: string[];
  intent: string;
  intent_template_id?: number;
  agent: WebArenaAgentExpectation;
  network: WebArenaNetworkExpectation[];
};

export type WebArenaEnvMap = Record<string, string>;

export type WebArenaJudgeInput = {
  task: WebArenaTask;
  env: WebArenaEnvMap;
  available_endpoints: DeferredEndpoint[];
  selected_endpoint?: DeferredEndpoint;
  network_events: TraceNetworkEvent[];
  agent_status: WebArenaExpectedStatus;
  retrieved_data: unknown;
};

export type WebArenaJudgeResult = {
  ok: boolean;
  retrieval_ok: boolean;
  selection_ok: boolean;
  status_ok: boolean;
  data_ok: boolean;
  network_ok: boolean;
  matched_network_events: number;
  expected_network_events: number;
  reasons: string[];
};

export const DEFAULT_WEBARENA_VERIFIED_DIR =
  process.env.WEBARENA_VERIFIED_DIR
    ? resolve(process.env.WEBARENA_VERIFIED_DIR)
    : resolve(process.env.HOME ?? "", "Projects", "oss", "webarena-verified");

export const DEFAULT_WEBARENA_ENV: WebArenaEnvMap = {
  __SHOPPING__: "http://localhost:7770",
  __SHOPPING_ADMIN__: "http://localhost:7780",
  __REDDIT__: "http://localhost:9999",
  __GITLAB__: "http://localhost:8023",
  __WIKIPEDIA__: "http://localhost:8888",
  __MAP__: "http://localhost:3030",
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function renderTemplate(input: string, env: WebArenaEnvMap): string {
  let rendered = input;
  for (const [needle, replacement] of Object.entries(env)) {
    rendered = rendered.split(needle).join(replacement);
  }
  return rendered;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function parseNetworkExpectation(value: unknown): WebArenaNetworkExpectation | null {
  const record = asObject(value);
  if (!record) return null;
  const url = record.url;
  const response_status = typeof record.response_status === "number" && Number.isFinite(record.response_status)
    ? Math.trunc(record.response_status)
    : 200;
  const http_method = typeof record.http_method === "string" && record.http_method.trim()
    ? record.http_method.trim().toUpperCase()
    : "GET";
  if (!(typeof url === "string" || (Array.isArray(url) && url.every((item) => typeof item === "string")))) {
    return null;
  }
  return {
    url,
    http_method,
    response_status,
    ...(asObject(record.headers) ? { headers: record.headers as Record<string, string> } : {}),
    ...(asObject(record.post_data) ? { post_data: record.post_data as Record<string, unknown> } : {}),
    ...(asObject(record.response_content) ? { response_content: record.response_content as Record<string, unknown> } : {}),
  };
}

function parseTask(entry: unknown): WebArenaTask | null {
  const record = asObject(entry);
  if (!record) return null;
  const task_id = typeof record.task_id === "number" ? Math.trunc(record.task_id) : null;
  const intent = typeof record.intent === "string" ? record.intent.trim() : "";
  const sites = Array.isArray(record.sites)
    ? record.sites.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const start_urls = Array.isArray(record.start_urls)
    ? record.start_urls.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const evals = Array.isArray(record.eval) ? record.eval : [];
  if (task_id == null || !intent || sites.length === 0 || start_urls.length === 0 || evals.length === 0) {
    return null;
  }

  const agentEval = evals.find((item) => asObject(item)?.evaluator === "AgentResponseEvaluator");
  const agentExpected = asObject(asObject(agentEval)?.expected);
  const task_type = typeof agentExpected?.task_type === "string" ? agentExpected.task_type.toLowerCase() : "";
  const status = typeof agentExpected?.status === "string" ? agentExpected.status.toUpperCase() : "";
  if (!["retrieve", "navigate", "mutate"].includes(task_type) || !status) return null;

  const network = evals
    .filter((item) => asObject(item)?.evaluator === "NetworkEventEvaluator")
    .map((item) => parseNetworkExpectation(asObject(item)?.expected))
    .filter((item): item is WebArenaNetworkExpectation => !!item);

  return {
    task_id,
    sites,
    start_urls,
    intent,
    ...(typeof record.intent_template_id === "number" ? { intent_template_id: Math.trunc(record.intent_template_id) } : {}),
    agent: {
      task_type: task_type as WebArenaTaskType,
      status: status as WebArenaExpectedStatus,
      retrieved_data: agentExpected?.retrieved_data ?? null,
    },
    network,
  };
}

export function loadWebArenaVerifiedTasks(options?: {
  repo_dir?: string;
  subset?: "full" | "hard";
  task_ids?: number[];
  sites?: string[];
  limit?: number;
  start?: number;
}): WebArenaTask[] {
  const repoDir = resolve(options?.repo_dir ?? DEFAULT_WEBARENA_VERIFIED_DIR);
  const datasetPath = join(repoDir, "assets", "dataset", "webarena-verified.json");
  if (!existsSync(datasetPath)) throw new Error(`missing WebArena-Verified dataset at ${datasetPath}`);
  const raw = loadJson<unknown[]>(datasetPath);
  let tasks = raw.map(parseTask).filter((task): task is WebArenaTask => !!task);

  if (options?.subset === "hard") {
    const subsetPath = join(repoDir, "assets", "dataset", "subsets", "webarena-verified-hard.json");
    const subset = loadJson<{ task_ids?: number[] }>(subsetPath);
    const keep = new Set((subset.task_ids ?? []).map((taskId) => Math.trunc(taskId)));
    tasks = tasks.filter((task) => keep.has(task.task_id));
  }
  if (options?.task_ids?.length) {
    const keep = new Set(options.task_ids.map((taskId) => Math.trunc(taskId)));
    tasks = tasks.filter((task) => keep.has(task.task_id));
  }
  if (options?.sites?.length) {
    const keep = new Set(options.sites.map((site) => site.toLowerCase()));
    tasks = tasks.filter((task) => task.sites.some((site) => keep.has(site.toLowerCase())));
  }
  tasks = tasks.sort((lhs, rhs) => lhs.task_id - rhs.task_id);
  if ((options?.start ?? 0) > 0) tasks = tasks.slice(options?.start);
  if ((options?.limit ?? 0) > 0) tasks = tasks.slice(0, options?.limit);
  return tasks;
}

export function resolveWebArenaEnvMap(config?: {
  env_file?: string;
  overrides?: Record<string, string>;
}): WebArenaEnvMap {
  let env = { ...DEFAULT_WEBARENA_ENV };
  const envFile = config?.env_file ? resolve(config.env_file) : "";
  if (envFile) {
    const parsed = loadJson<{ environments?: Record<string, { urls?: string[] }> }>(envFile);
    for (const [key, value] of Object.entries(parsed.environments ?? {})) {
      const url = value.urls?.find((entry) => typeof entry === "string" && entry.trim().length > 0);
      if (url) env[key] = url;
    }
  }
  for (const [key, value] of Object.entries(config?.overrides ?? {})) {
    if (value) env[key] = value;
  }
  return env;
}

export function renderTaskStartUrls(task: WebArenaTask, env: WebArenaEnvMap): string[] {
  return task.start_urls.map((url) => renderTemplate(url, env));
}

function maybeRegex(pattern: string): RegExp | null {
  if (!pattern) return null;
  if (pattern.startsWith("^") || pattern.endsWith("$")) {
    try {
      return new RegExp(pattern, "i");
    } catch {
      return null;
    }
  }
  return null;
}

function matchString(actual: string, expected: string): boolean {
  const regex = maybeRegex(expected);
  if (regex) return regex.test(actual);
  return actual.toLowerCase() === expected.toLowerCase();
}

function matchUrl(actual: string, expected: string | string[], env: WebArenaEnvMap): boolean {
  const candidates = Array.isArray(expected) ? expected : [expected];
  return candidates.some((candidate) => matchString(actual, renderTemplate(candidate, env)));
}

function firstNonNull(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) return firstNonNull(value[0]);
  return value;
}

function compareScalar(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected === "number") return actual === expected;
  if (typeof actual === "boolean" && typeof expected === "boolean") return actual === expected;
  return stringify(firstNonNull(actual)).toLowerCase() === stringify(firstNonNull(expected)).toLowerCase();
}

function readPath(input: unknown, rawPath: string): unknown {
  const trimmed = rawPath.replace(/^\$\./, "");
  const segments = trimmed.split(".").flatMap((segment) => {
    const parts = segment.split(/\[([0-9]+)\]/).filter(Boolean);
    return parts.map((part) => (/^[0-9]+$/.test(part) ? Number(part) : part));
  });
  let current: unknown = input;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function matchesObjectSubset(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object") return false;
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = key.startsWith("$.")
      ? readPath(actual, key)
      : (actual as Record<string, unknown>)[key];
    if (asObject(expectedValue)) {
      if (!matchesObjectSubset(actualValue, expectedValue as Record<string, unknown>)) return false;
      continue;
    }
    if (!compareScalar(actualValue, expectedValue)) return false;
  }
  return true;
}

function compareRetrievedData(actual: unknown, expected: unknown): boolean {
  if (expected == null) return true;
  if (!Array.isArray(expected)) return compareScalar(actual, expected);
  if (!Array.isArray(actual)) return false;
  if (expected.length !== actual.length) return false;
  return expected.every((expectedItem, index) => {
    const actualItem = actual[index];
    if (asObject(expectedItem)) return matchesObjectSubset(actualItem, expectedItem as Record<string, unknown>);
    return compareScalar(actualItem, expectedItem);
  });
}

function eventMatchesExpectation(
  event: TraceNetworkEvent,
  expectation: WebArenaNetworkExpectation,
  env: WebArenaEnvMap,
): boolean {
  if (!matchUrl(event.request.url, expectation.url, env)) return false;
  if (event.request.method.toUpperCase() !== expectation.http_method.toUpperCase()) return false;
  if (event.response.status !== expectation.response_status) return false;

  if (expectation.headers) {
    const actualHeaders = Object.fromEntries(event.request.headers.map((header) => [header.name.toLowerCase(), header.value]));
    for (const [key, value] of Object.entries(expectation.headers)) {
      if (!matchString(actualHeaders[key.toLowerCase()] ?? "", renderTemplate(value, env))) return false;
    }
  }

  if (expectation.post_data) {
    let actualPost: unknown = undefined;
    try {
      actualPost = event.request.postData?.text ? JSON.parse(event.request.postData.text) : undefined;
    } catch {
      actualPost = event.request.postData?.text;
    }
    if (!matchesObjectSubset(actualPost, expectation.post_data)) return false;
  }

  if (expectation.response_content) {
    let actualResponse: unknown = undefined;
    try {
      actualResponse = event.response.content?.text ? JSON.parse(event.response.content.text) : undefined;
    } catch {
      actualResponse = event.response.content?.text;
    }
    if (!matchesObjectSubset(actualResponse, expectation.response_content)) return false;
  }

  return true;
}

export function judgeWebArenaTask(input: WebArenaJudgeInput): WebArenaJudgeResult {
  const reasons: string[] = [];
  const retrieval_ok =
    input.task.network.length === 0 ||
    input.available_endpoints.some((endpoint) =>
      input.task.network.some((expectation) => matchUrl(endpoint.url ?? "", expectation.url, input.env)),
    );
  if (!retrieval_ok) reasons.push("retrieval_miss");

  const selection_ok =
    input.task.network.length === 0 ||
    (input.selected_endpoint
      ? input.task.network.some((expectation) => matchUrl(input.selected_endpoint?.url ?? "", expectation.url, input.env))
      : false);
  if (!selection_ok) reasons.push("selection_miss");

  let matched_network_events = 0;
  for (const expectation of input.task.network) {
    if (input.network_events.some((event) => eventMatchesExpectation(event, expectation, input.env))) {
      matched_network_events += 1;
    }
  }
  const network_ok = matched_network_events === input.task.network.length;
  if (!network_ok) reasons.push(`network_miss:${matched_network_events}/${input.task.network.length}`);

  const status_ok = input.agent_status === input.task.agent.status;
  if (!status_ok) reasons.push(`status:${input.agent_status}->${input.task.agent.status}`);

  const data_ok = compareRetrievedData(input.retrieved_data, input.task.agent.retrieved_data);
  if (!data_ok) reasons.push("retrieved_data_mismatch");

  return {
    ok: retrieval_ok && selection_ok && status_ok && data_ok && network_ok,
    retrieval_ok,
    selection_ok,
    status_ok,
    data_ok,
    network_ok,
    matched_network_events,
    expected_network_events: input.task.network.length,
    reasons,
  };
}
