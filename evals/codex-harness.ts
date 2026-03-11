#!/usr/bin/env bun

import { config as loadEnv } from "dotenv";
import { dirname, join, resolve } from "path";
import { readFileSync, writeFileSync } from "fs";
import { spawn } from "node:child_process";
import { assessIntentResult } from "../src/intent-match.js";
import { getAuthCookies } from "../src/auth/index.js";
import { buildAgentExecuteCliArgs, compactForArtifact, deriveEndpointSignals, fallbackEndpointOrder, normalizeHarnessCases, type DeferredEndpoint, type HarnessCase, type ReviewQueueCandidate } from "./codex-harness-lib.js";
import { buildLocalHarnessFixtures } from "../src/graph/local-fixtures.js";
import { evaluateDependencyWalks, evaluateLocalHarness, type DependencyWalkCase } from "../src/graph/local-harness.js";
import { startUnbrowseServer, type RunningUnbrowseServer } from "../src/server.js";

loadEnv({ quiet: true });
loadEnv({ path: join(dirname(new URL(import.meta.url).pathname), "..", ".env.runtime"), override: false, quiet: true });

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const EVALS_DIR = dirname(new URL(import.meta.url).pathname);
const DEFAULT_RESULTS_PATH = join(EVALS_DIR, "codex-harness-last-run.json");
const BASE_URL = process.env.UNBROWSE_URL ?? "http://localhost:6969";
const BASE_PORT = (() => {
  try {
    const parsed = new URL(BASE_URL);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return 6969;
  }
})();
const BASE_HOST = (() => {
  try {
    return new URL(BASE_URL).hostname || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
})();
const CLI_TIMEOUT_MS = Number(process.env.UNBROWSE_EVAL_CLI_TIMEOUT_MS || "180000");

type AgentVerdict = "pass" | "fail" | "skip";

type DirectResultRecord = {
  endpoint_id?: string;
  trace_success?: boolean;
  result_excerpt: unknown;
};

type AgentReviewRecord = {
  required: boolean;
  preferred_endpoint_id?: string;
  mode: "shortlist" | "direct_result" | "blocked";
  local_signal?: {
    verdict: string;
    reason: string;
  };
  execute_candidates: Array<{
    endpoint_id: string;
    cli: string[];
  }>;
};

type CaseRecord = {
  id: string;
  intent: string;
  url: string;
  auth: boolean;
  params?: Record<string, unknown>;
  query_source: "none" | "url" | "params" | "mixed";
  collector_status: "ready_for_review" | "fail" | "skip";
  collector_reason: string;
  agent_verdict?: AgentVerdict | null;
  skill_id?: string;
  resolve_ms: number;
  resolve_source?: string;
  selection_mode: "unavailable" | "deferred" | "resolved";
  ordered_endpoint_ids: string[];
  available_endpoints: Array<{
    endpoint_id?: string;
    score?: number;
    description?: string;
    url?: string;
    trigger_url?: string | null;
    schema_summary?: unknown;
  }>;
  direct_result?: DirectResultRecord | null;
  agent_review: AgentReviewRecord;
  resolve_excerpt: unknown;
};

type GraphSection = {
  selection_summary: ReturnType<typeof evaluateLocalHarness>["summary"];
  selection_results: Array<{
    id: string;
    pass: boolean;
    selected?: string;
    expected: string;
    top_hits: string[];
    failure_reason?: string;
  }>;
  dependency_summary: ReturnType<typeof evaluateDependencyWalks>["summary"];
  dependency_results: Array<{
    id: string;
    pass: boolean;
    target_operation_id: string;
    selected_path: string[];
    failure_reason?: string;
  }>;
};

type ReviewQueueItem = {
  id: string;
  intent: string;
  url: string;
  collector_reason: string;
  preferred_endpoint_id?: string;
  local_signal?: {
    verdict: string;
    reason: string;
  };
  direct_result?: unknown;
  candidates: ReviewQueueCandidate[];
};

let localServer: RunningUnbrowseServer | null = null;

const argv = process.argv.slice(
  typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2,
);
const args = new Set(argv);
const getArg = (flag: string) => argv.find((_, i) => argv[i - 1] === `--${flag}`) ?? "";
const hasFlag = (flag: string) => args.has(`--${flag}`);
const forceCapture = hasFlag("--force-capture") || process.env.UNBROWSE_FORCE_CAPTURE === "1";
const restartServer = hasFlag("--restart-server");
const maxReviewCandidates = Math.max(1, Number(getArg("max-candidates") || getArg("max-attempts") || "3") || 3);
const resultsPath = resolve(getArg("out") || DEFAULT_RESULTS_PATH);
const debugHarness = process.env.UNBROWSE_EVAL_DEBUG === "1";
const reviewQueuePath = resultsPath.endsWith(".json")
  ? resultsPath.replace(/\.json$/i, ".review-queue.json")
  : `${resultsPath}.review-queue.json`;

function debug(step: string): void {
  if (debugHarness) console.error(`[codex-harness:debug] ${step}`);
}

function usage(): never {
  console.error(
    "Usage:\n" +
    "  bun evals/codex-harness.ts --intent '...' --url '...' [--params '{...}']\n" +
    "  bun evals/codex-harness.ts --cases evals/codex-cases.example.json\n" +
    "Optional: --force-capture --restart-server --max-candidates 3 --out <path>",
  );
  process.exit(1);
}

function buildCases(): HarnessCase[] {
  const singleIntent = getArg("intent");
  const singleUrl = getArg("url");
  if (singleIntent && singleUrl) {
    return [{
      id: getArg("id") || "single-case",
      intent: singleIntent,
      url: singleUrl,
      auth: getArg("auth") || undefined,
      ...(getArg("params") ? { params: JSON.parse(getArg("params")) as Record<string, unknown> } : {}),
      expected_fields: getArg("expected-fields")
        ? getArg("expected-fields").split(",").map((item) => item.trim()).filter(Boolean)
        : [],
    }];
  }

  const casesPath = getArg("cases");
  if (!casesPath) usage();
  const raw = JSON.parse(readFileSync(resolve(ROOT, casesPath), "utf-8"));
  const cases = normalizeHarnessCases(raw);
  if (cases.length === 0) throw new Error(`no valid cases in ${casesPath}`);
  return cases;
}

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp()) return;
    await Bun.sleep(500);
  }
  throw new Error(`server did not become healthy at ${BASE_URL}`);
}

function listServerPids(): number[] {
  const pids = new Set<number>();
  try {
    const pidText = readFileSync(join(process.env.HOME ?? "", ".unbrowse", "run", "server-127.0.0.1-6969.json"), "utf-8");
    const pid = JSON.parse(pidText).pid;
    if (typeof pid === "number" && Number.isFinite(pid)) pids.add(pid);
  } catch {
    // best effort
  }
  try {
    const out = Bun.spawnSync(["lsof", "-ti", `tcp:${BASE_PORT}`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const text = out.stdout.toString().trim();
    for (const line of text.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isFinite(pid)) pids.add(pid);
    }
  } catch {
    // best effort
  }
  return [...pids];
}

async function stopServer(): Promise<void> {
  const pids = listServerPids();
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await isServerUp())) return;
    await Bun.sleep(250);
  }
  for (const pid of listServerPids()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }
  const hardDeadline = Date.now() + 5_000;
  while (Date.now() < hardDeadline) {
    if (!(await isServerUp())) return;
    await Bun.sleep(250);
  }
  throw new Error(`failed to stop server on ${BASE_URL}`);
}

async function ensureServer(): Promise<void> {
  if (await isServerUp() && !restartServer) return;
  if (restartServer) {
    await stopServer();
  }
  if (await isServerUp() && !restartServer) return;
  localServer = await startUnbrowseServer({
    host: BASE_HOST,
    port: BASE_PORT,
    pidFile: undefined,
    scheduleVerification: false,
  });
}

async function runCli(clientId: string, cliArgs: string[]): Promise<{ code: number; body: any; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("bun", ["src/cli.ts", ...cliArgs, "--no-auto-start"], {
      cwd: ROOT,
      env: {
        ...process.env,
        UNBROWSE_URL: BASE_URL,
        UNBROWSE_CLIENT_ID: clientId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      settle(() => rejectPromise(new Error(`cli_timeout:${cliArgs[0] ?? "command"}:${CLI_TIMEOUT_MS}`)));
    }, CLI_TIMEOUT_MS);

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => { stdout += chunk; });
    proc.stderr?.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", (error) => {
      settle(() => rejectPromise(error));
    });
    proc.on("close", (code) => {
      settle(() => {
        let body: any = {};
        try {
          body = JSON.parse(stdout.trim() || "{}");
        } catch {
          body = {};
        }
        resolvePromise({ code: code ?? 1, body, stderr });
      });
    });
  });
}

function getSkillId(body: any): string | undefined {
  return body?.skill?.skill_id ?? body?.trace?.skill_id ?? body?.result?.skill_id;
}

function getAvailableEndpoints(body: any): DeferredEndpoint[] {
  return body?.result?.available_endpoints ?? body?.available_endpoints ?? [];
}

function getResolvedEndpointId(body: any): string | undefined {
  return body?.trace?.endpoint_id;
}

function getJudgePayload(body: any): unknown {
  return body?.result ?? body?.trace?.result ?? null;
}

function extractVerdict(body: any, intent: string): { verdict: string; reason: string } {
  const local = assessIntentResult(getJudgePayload(body), intent);
  return { verdict: local.verdict, reason: local.reason };
}

function orderEndpoints(endpoints: DeferredEndpoint[]): { mode: "fallback"; ordered: string[] } {
  return { mode: "fallback", ordered: fallbackEndpointOrder(endpoints) };
}

function emptyAgentReview(): AgentReviewRecord {
  return {
    required: false,
    mode: "blocked",
    execute_candidates: [],
  };
}

function inferQuerySource(url: string, params?: Record<string, unknown>): CaseRecord["query_source"] {
  let urlHasQuery = false;
  try {
    urlHasQuery = [...new URL(url).searchParams.keys()].length > 0;
  } catch {
    urlHasQuery = false;
  }
  const paramHasQuery = !!params && Object.keys(params).length > 0;
  if (urlHasQuery && paramHasQuery) return "mixed";
  if (paramHasQuery) return "params";
  if (urlHasQuery) return "url";
  return "none";
}

function buildGraphSection(): GraphSection {
  const { skills, cases } = buildLocalHarnessFixtures();
  const selection = evaluateLocalHarness(skills, cases);
  const walks: DependencyWalkCase[] = [
    {
      id: "discord-message-pipeline",
      skill_id: "fixture-discord",
      intent: "get messages",
      authenticated: true,
      contextUrl: "https://discord.com/channels/@me",
      target_operation_id: "discord-messages",
      expected_path: ["discord-guilds", "discord-channels", "discord-messages"],
    },
    {
      id: "github-repo-detail-pipeline",
      skill_id: "fixture-github",
      intent: "get repository details",
      initial_params: { q: "openai" },
      contextUrl: "https://github.com/search?q=openai&type=repositories",
      target_operation_id: "github-repo-detail",
      expected_path: ["github-search", "github-repo-detail"],
    },
    {
      id: "market-detail-pipeline",
      skill_id: "fixture-market",
      intent: "get listing details",
      initial_params: { q: "bike" },
      contextUrl: "https://example-market.com/search?q=bike",
      target_operation_id: "market-detail",
      expected_path: ["market-search", "market-detail"],
    },
    {
      id: "linkedin-detail-pipeline",
      skill_id: "fixture-linkedin",
      intent: "get profile details",
      authenticated: true,
      initial_params: { q: "openai" },
      contextUrl: "https://www.linkedin.com/search/results/people/?keywords=openai",
      target_operation_id: "linkedin-profile-detail",
      expected_path: ["linkedin-search-people", "linkedin-profile-detail"],
    },
    {
      id: "html-form-job-detail-pipeline",
      skill_id: "fixture-form-html",
      intent: "get job details",
      contextUrl: "https://jobs.example.com/roles",
      target_operation_id: "job-detail",
      expected_path: ["jobs-form-options", "jobs-search", "job-detail"],
    },
  ];
  const dependency = evaluateDependencyWalks(skills, walks);
  return {
    selection_summary: selection.summary,
    selection_results: selection.results.map((result) => ({
      id: result.id,
      pass: result.pass,
      ...(result.selected ? { selected: `${result.selected.skill_id}:${result.selected.operation_id}` } : {}),
      expected: `${result.expected_skill_id}:${result.expected_operation_id}`,
      top_hits: result.top_hits.map((hit) => `${hit.skill_id}:${hit.operation_id}`),
      ...(result.failure_reason ? { failure_reason: result.failure_reason } : {}),
    })),
    dependency_summary: dependency.summary,
    dependency_results: dependency.results.map((result) => ({
      id: result.id,
      pass: result.pass,
      target_operation_id: result.target_operation_id,
      selected_path: result.selected_path,
      ...(result.failure_reason ? { failure_reason: result.failure_reason } : {}),
    })),
  };
}

async function evaluateCase(testCase: HarnessCase, index: number): Promise<CaseRecord> {
  const clientId = `codex-harness-${index + 1}`;
  if (testCase.auth) {
    const cookies = await getAuthCookies(testCase.auth);
    if (!cookies || cookies.length === 0) {
      return {
        id: testCase.id,
        intent: testCase.intent,
        url: testCase.url,
        auth: true,
        ...(testCase.params ? { params: testCase.params } : {}),
        query_source: inferQuerySource(testCase.url, testCase.params),
        collector_status: "skip",
        collector_reason: `missing_${testCase.auth}_cookies`,
        agent_verdict: null,
        resolve_ms: 0,
        selection_mode: "unavailable",
        ordered_endpoint_ids: [],
        available_endpoints: [],
        direct_result: null,
        agent_review: {
          ...emptyAgentReview(),
          mode: "blocked",
        },
        resolve_excerpt: null,
      };
    }
  }

  const baseRecord: Omit<CaseRecord, "collector_status" | "collector_reason" | "selection_mode" | "ordered_endpoint_ids"> = {
    id: testCase.id,
    intent: testCase.intent,
    url: testCase.url,
    auth: !!testCase.auth,
    ...(testCase.params ? { params: testCase.params } : {}),
    query_source: inferQuerySource(testCase.url, testCase.params),
    agent_verdict: null,
    skill_id: undefined,
    resolve_ms: 0,
    resolve_source: undefined,
    available_endpoints: [],
    direct_result: null,
    resolve_excerpt: null,
    agent_review: emptyAgentReview(),
  };

  let resolveMs = 0;
  let resolve;
  try {
    const resolveStarted = performance.now();
    resolve = await runCli(clientId, [
      "resolve",
      "--intent", testCase.intent,
      "--url", testCase.url,
      ...(testCase.params ? ["--params", JSON.stringify(testCase.params)] : []),
      "--raw",
      ...(forceCapture ? ["--force-capture"] : []),
    ]);
    resolveMs = Math.round(performance.now() - resolveStarted);
  } catch (error) {
    return {
      ...baseRecord,
      collector_status: "fail",
      collector_reason: error instanceof Error ? error.message : String(error),
      selection_mode: "unavailable",
      ordered_endpoint_ids: [],
    };
  }

  const resolveSkillId = getSkillId(resolve.body);
  const availableEndpoints = getAvailableEndpoints(resolve.body);
  baseRecord.skill_id = resolveSkillId;
  baseRecord.resolve_ms = resolveMs;
  baseRecord.resolve_source = resolve.body?.source ?? resolve.body?.timing?.source;
  baseRecord.available_endpoints = availableEndpoints.slice(0, 8).map((endpoint) => ({
    endpoint_id: endpoint.endpoint_id,
    score: endpoint.score,
    description: (endpoint as Record<string, unknown>).description as string | undefined,
    url: endpoint.url,
    trigger_url: endpoint.trigger_url,
    schema_summary: compactForArtifact(endpoint.schema_summary),
  }));
  baseRecord.resolve_excerpt = compactForArtifact(resolve.body);

  if (resolve.code !== 0 || resolve.body?.error) {
    return {
      ...baseRecord,
      collector_status: "fail",
      collector_reason: String(resolve.body?.error ?? "resolve_failed"),
      selection_mode: "unavailable",
      ordered_endpoint_ids: [],
    };
  }

  const immediateVerdict = extractVerdict(resolve.body, testCase.intent);
  if (!availableEndpoints.length) {
    return {
      ...baseRecord,
      collector_status: "ready_for_review",
      collector_reason: "agent_review_direct_result",
      selection_mode: "resolved",
      ordered_endpoint_ids: getResolvedEndpointId(resolve.body) ? [getResolvedEndpointId(resolve.body)!] : [],
      direct_result: {
        endpoint_id: getResolvedEndpointId(resolve.body),
        trace_success: resolve.body?.trace?.success,
        result_excerpt: compactForArtifact(getJudgePayload(resolve.body)),
      },
      agent_review: {
        required: true,
        mode: "direct_result",
        local_signal: immediateVerdict,
        execute_candidates: [],
      },
    };
  }

  const ordered = orderEndpoints(availableEndpoints);
  const reviewedOrdered = ordered.ordered.slice(0, maxReviewCandidates);
  return {
    ...baseRecord,
    collector_status: "ready_for_review",
    collector_reason: reviewedOrdered.length > 0 ? "agent_select_endpoint" : "agent_review_pending",
    selection_mode: "deferred",
    ordered_endpoint_ids: ordered.ordered,
    agent_review: {
      required: true,
      mode: "shortlist",
      local_signal: immediateVerdict,
      ...(reviewedOrdered[0] ? { preferred_endpoint_id: reviewedOrdered[0] } : {}),
      execute_candidates: resolveSkillId
        ? reviewedOrdered.map((endpointId) => ({
            endpoint_id: endpointId,
            cli: buildAgentExecuteCliArgs(resolveSkillId, endpointId, testCase),
          }))
        : [],
    },
  };
}

function writeResults(results: CaseRecord[], graph: GraphSection): void {
  const review_queue: ReviewQueueItem[] = results
    .filter((result) => result.collector_status === "ready_for_review")
    .map((result) => {
      const candidates: ReviewQueueCandidate[] = result.ordered_endpoint_ids
        .slice(0, maxReviewCandidates)
        .map((endpointId, index) => {
          const endpoint = result.available_endpoints.find((item) => item.endpoint_id === endpointId);
          return {
            rank: index + 1,
            endpoint_id: endpointId,
            score: endpoint?.score,
            description: endpoint?.description,
            url: endpoint?.url,
            trigger_url: endpoint?.trigger_url,
            signals: deriveEndpointSignals(endpoint ?? { endpoint_id: endpointId }),
            cli: result.agent_review.execute_candidates.find((candidate) => candidate.endpoint_id === endpointId)?.cli,
          };
        });

      return {
        id: result.id,
        intent: result.intent,
        url: result.url,
        collector_reason: result.collector_reason,
        ...(result.agent_review.preferred_endpoint_id ? { preferred_endpoint_id: result.agent_review.preferred_endpoint_id } : {}),
        ...(result.agent_review.local_signal ? { local_signal: result.agent_review.local_signal } : {}),
        ...(result.direct_result ? { direct_result: result.direct_result.result_excerpt } : {}),
        candidates,
      };
    });

  const summary = {
    total: results.length,
    ready_for_review: results.filter((result) => result.collector_status === "ready_for_review").length,
    fail: results.filter((result) => result.collector_status === "fail").length,
    skip: results.filter((result) => result.collector_status === "skip").length,
    agent_pass: results.filter((result) => result.agent_verdict === "pass").length,
    agent_fail: results.filter((result) => result.agent_verdict === "fail").length,
    agent_skip: results.filter((result) => result.agent_verdict === "skip").length,
    review_required: results.filter((result) => result.agent_review.required).length,
    graph_selection_fail: graph.selection_summary.failed,
    graph_dependency_fail: graph.dependency_summary.failed,
    force_capture: forceCapture,
    max_review_candidates: maxReviewCandidates,
    review_queue_path: reviewQueuePath,
  };
  writeFileSync(resultsPath, JSON.stringify({ summary, graph, review_queue, results }, null, 2));
  writeFileSync(reviewQueuePath, JSON.stringify({
    summary: {
      total: review_queue.length,
      source_artifact: resultsPath,
      max_review_candidates: maxReviewCandidates,
    },
    queue: review_queue,
  }, null, 2));
}

export async function runHarnessCli(): Promise<void> {
  let exitCode = 0;
  try {
    debug("ensureServer:start");
    await ensureServer();
    debug("ensureServer:done");
    const cases = buildCases();
    debug(`buildCases:done count=${cases.length}`);
    const graph = buildGraphSection();
    debug("buildGraphSection:done");
    const results: CaseRecord[] = [];
    writeResults(results, graph);
    debug("writeResults:seeded");
    for (let i = 0; i < cases.length; i++) {
      debug(`evaluateCase:start index=${i}`);
      const result = await evaluateCase(cases[i]!, i);
      results.push(result);
      writeResults(results, graph);
      console.log(`[codex-harness] ${i + 1}/${cases.length} ${result.id} status=${result.collector_status} mode=${result.selection_mode} reason=${result.collector_reason}`);
    }
    const failed = results.some((result) => result.collector_status === "fail") ||
      graph.selection_summary.failed > 0 ||
      graph.dependency_summary.failed > 0;
    exitCode = failed ? 1 : 0;
  } finally {
    if (localServer) {
      try {
        await localServer.close();
      } catch {
        // best-effort cleanup for local eval server
      }
    }
    localServer = null;
  }
  process.exit(exitCode);
}

if (import.meta.main) {
  await runHarnessCli().catch((error) => {
    console.error("[codex-harness] fatal", error);
    process.exit(1);
  });
}
