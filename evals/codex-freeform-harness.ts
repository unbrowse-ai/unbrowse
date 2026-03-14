#!/usr/bin/env bun

import { config as loadEnv } from "dotenv";
import { dirname, join, resolve } from "path";
import { readFileSync, writeFileSync } from "fs";
import { spawn } from "node:child_process";
import { getAuthCookies } from "../src/auth/index.js";
import { startUnbrowseServer, type RunningUnbrowseServer } from "../src/server.js";
import {
  buildAgentExecuteCliArgs,
  compactForArtifact,
  fallbackEndpointOrder,
  normalizeHarnessCases,
  pickFreeformFollowUpUrl,
  type DeferredEndpoint,
  type HarnessCase,
} from "./codex-harness-lib.js";
import { resolveEvalJudgeMode, reviewEvalPayload } from "./codex-eval-review.js";

loadEnv({ quiet: true });
loadEnv({ path: join(dirname(new URL(import.meta.url).pathname), "..", ".env.runtime"), override: false, quiet: true });

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const EVALS_DIR = dirname(new URL(import.meta.url).pathname);
const DEFAULT_RESULTS_PATH = join(EVALS_DIR, "codex-freeform-last-run.json");
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

type StepRecord = {
  kind: "resolve" | "execute" | "follow_url";
  url: string;
  skill_id?: string;
  endpoint_id?: string;
  duration_ms?: number;
  verdict?: AgentVerdict;
  reason?: string;
  source_kind?: string;
  available_endpoint_ids?: string[];
  excerpt?: unknown;
};

type FreeformResult = {
  id: string;
  intent: string;
  auth: boolean;
  final_verdict: AgentVerdict;
  final_reason: string;
  final_source_kind?: string;
  matched_fields: string[];
  missing_fields: string[];
  steps: StepRecord[];
};

let localServer: RunningUnbrowseServer | null = null;

const argv = process.argv.slice(
  typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2,
);
const args = new Set(argv);
const getArg = (flag: string) => argv.find((_, i) => argv[i - 1] === `--${flag}`) ?? "";
const hasFlag = (flag: string) => args.has(`--${flag}`);
const forceCapture = hasFlag("--force-capture") || process.env.UNBROWSE_FORCE_CAPTURE === "1";
const ownsDefaultLocalServer =
  !process.env.UNBROWSE_URL &&
  (BASE_HOST === "127.0.0.1" || BASE_HOST === "localhost") &&
  BASE_PORT === 6969;
const restartServer = hasFlag("--restart-server") || ownsDefaultLocalServer;
const maxReviewCandidates = Math.max(1, Number(getArg("max-candidates") || "3") || 3);
const maxSteps = Math.max(1, Number(getArg("max-steps") || "4") || 4);
const resultsPath = resolve(getArg("out") || DEFAULT_RESULTS_PATH);
const evalJudgeMode = resolveEvalJudgeMode();
const CLI_RATE_LIMIT_RETRIES = Math.max(0, Number(process.env.UNBROWSE_EVAL_RATE_LIMIT_RETRIES || "3"));

function usage(): never {
  console.error(
    "Usage:\n" +
    "  bun evals/codex-freeform-harness.ts --intent '...' --url '...' [--params '{...}']\n" +
    "  bun evals/codex-freeform-harness.ts --cases evals/codex-cases.example.json\n" +
    "Optional: --force-capture --restart-server --max-candidates 3 --max-steps 4 --out <path>",
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

function listServerPids(): number[] {
  const pids = new Set<number>();
  try {
    const pidText = readFileSync(
      join(process.env.HOME ?? "", ".unbrowse", "run", `server-${BASE_HOST}-${BASE_PORT}.json`),
      "utf-8",
    );
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

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
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
}

async function ensureServer(): Promise<void> {
  if (await isServerUp() && !restartServer) return;
  if (restartServer) await stopServer();
  if (await isServerUp() && !restartServer) return;
  process.env.UNBROWSE_DISABLE_RATE_LIMIT = "1";
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
    proc.on("error", (error) => settle(() => rejectPromise(error)));
    proc.on("close", (code) => {
      settle(() => {
        let body: any = {};
        try { body = JSON.parse(stdout.trim() || "{}"); } catch { body = {}; }
        resolvePromise({ code: code ?? 1, body, stderr });
      });
    });
  });
}

function isRateLimitedCliResult(result: { code: number; body: any; stderr: string }): boolean {
  const bodyError = typeof result.body?.error === "string" ? result.body.error : "";
  const stderr = result.stderr ?? "";
  return bodyError.includes("Too Many Requests") || stderr.includes("Too Many Requests");
}

async function runCliWithRetry(clientId: string, cliArgs: string[]): Promise<{ code: number; body: any; stderr: string }> {
  let last = await runCli(clientId, cliArgs);
  for (let attempt = 1; attempt <= CLI_RATE_LIMIT_RETRIES && isRateLimitedCliResult(last); attempt++) {
    await Bun.sleep(1000 * attempt);
    last = await runCli(clientId, cliArgs);
  }
  return last;
}

function getSkillId(body: any): string | undefined {
  return body?.skill?.skill_id ?? body?.trace?.skill_id ?? body?.result?.skill_id;
}

function getAvailableEndpoints(body: any): DeferredEndpoint[] {
  return body?.result?.available_endpoints ?? body?.available_endpoints ?? [];
}

function getJudgePayload(body: any): unknown {
  return body?.result ?? body?.trace?.result ?? null;
}

async function evaluateCase(testCase: HarnessCase, index: number): Promise<FreeformResult> {
  if (testCase.auth) {
    const cookies = await getAuthCookies(testCase.auth, { autoExtract: false });
    if (!cookies || cookies.length === 0) {
      return {
        id: testCase.id,
        intent: testCase.intent,
        auth: true,
        final_verdict: "skip",
        final_reason: `missing_${testCase.auth}_auth`,
        final_source_kind: "unknown",
        matched_fields: [],
        missing_fields: testCase.expected_fields,
        steps: [],
      };
    }
  }

  const clientId = `codex-freeform-${index + 1}`;
  const visitedUrls = new Set<string>([testCase.url]);
  const steps: StepRecord[] = [];
  let currentUrl = testCase.url;

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    const resolveStarted = performance.now();
    const resolve = await runCliWithRetry(clientId, [
      "resolve",
      "--intent", testCase.intent,
      "--url", currentUrl,
      ...(testCase.params ? ["--params", JSON.stringify(testCase.params)] : []),
      "--raw",
      ...(forceCapture || stepIndex > 0 ? ["--force-capture"] : []),
    ]);
    const resolveBody = resolve.body;
    const resolveEndpoints = getAvailableEndpoints(resolveBody);
    const resolveSkillId = getSkillId(resolveBody);
    steps.push({
      kind: "resolve",
      url: currentUrl,
      skill_id: resolveSkillId,
      duration_ms: Math.round(performance.now() - resolveStarted),
      verdict: resolve.code === 0 && !resolveBody?.error ? undefined : "fail",
      reason: resolve.code === 0 && !resolveBody?.error ? undefined : String(resolveBody?.error ?? "resolve_failed"),
      available_endpoint_ids: resolveEndpoints.map((endpoint) => endpoint.endpoint_id).filter((value): value is string => typeof value === "string"),
      excerpt: compactForArtifact(resolveBody?.result ?? resolveBody),
    });
    if (resolve.code !== 0 || resolveBody?.error) {
      return {
        id: testCase.id,
        intent: testCase.intent,
        auth: !!testCase.auth,
        final_verdict: "fail",
        final_reason: String(resolveBody?.error ?? "resolve_failed"),
        final_source_kind: "unknown",
        matched_fields: [],
        missing_fields: testCase.expected_fields,
        steps,
      };
    }

    const orderedEndpointIds = fallbackEndpointOrder(resolveEndpoints).slice(0, maxReviewCandidates);
    if (resolveSkillId) {
      for (const endpointId of orderedEndpointIds) {
        const endpoint = resolveEndpoints.find((item) => item.endpoint_id === endpointId);
        const executeStarted = performance.now();
        const execute = await runCliWithRetry(clientId, buildAgentExecuteCliArgs(resolveSkillId, endpointId, {
          intent: testCase.intent,
          url: currentUrl,
          params: testCase.params,
        }).slice(2));
        const review = execute.code === 0 && !execute.body?.error
          ? await reviewEvalPayload({
              intent: testCase.intent,
              expected_fields: testCase.expected_fields,
              payload: getJudgePayload(execute.body),
              endpoint,
              judge_mode: evalJudgeMode,
            })
          : null;
        steps.push({
          kind: "execute",
          url: currentUrl,
          skill_id: resolveSkillId,
          endpoint_id: endpointId,
          duration_ms: Math.round(performance.now() - executeStarted),
          verdict: review?.verdict ?? "fail",
          reason: review?.reason ?? String(execute.body?.error ?? `execute_failed:${endpointId}`),
          source_kind: review?.source_kind ?? "unknown",
          excerpt: compactForArtifact(review?.projected_excerpt ?? execute.body?.result ?? execute.body),
        });
        if (review?.verdict === "pass") {
          return {
            id: testCase.id,
            intent: testCase.intent,
            auth: !!testCase.auth,
            final_verdict: "pass",
            final_reason: review.reason,
            final_source_kind: review.source_kind,
            matched_fields: review.matched_fields,
            missing_fields: review.missing_fields,
            steps,
          };
        }
      }
    }

    const followUrl = pickFreeformFollowUpUrl(currentUrl, resolveEndpoints, visitedUrls);
    if (!followUrl) {
      const lastExecute = [...steps].reverse().find((step) => step.kind === "execute");
      return {
        id: testCase.id,
        intent: testCase.intent,
        auth: !!testCase.auth,
        final_verdict: "fail",
        final_reason: lastExecute?.reason ?? "freeform_no_next_action",
        final_source_kind: lastExecute?.source_kind,
        matched_fields: [],
        missing_fields: testCase.expected_fields,
        steps,
      };
    }
    visitedUrls.add(followUrl);
    steps.push({ kind: "follow_url", url: followUrl, reason: "follow_trigger_url" });
    currentUrl = followUrl;
  }

  const lastExecute = [...steps].reverse().find((step) => step.kind === "execute");
  return {
    id: testCase.id,
    intent: testCase.intent,
    auth: !!testCase.auth,
    final_verdict: "fail",
    final_reason: lastExecute?.reason ?? "freeform_step_budget_exhausted",
    final_source_kind: lastExecute?.source_kind,
    matched_fields: [],
    missing_fields: testCase.expected_fields,
    steps,
  };
}

function writeResults(results: FreeformResult[]): void {
  writeFileSync(resultsPath, JSON.stringify({
    summary: {
      total: results.length,
      pass: results.filter((result) => result.final_verdict === "pass").length,
      fail: results.filter((result) => result.final_verdict === "fail").length,
      skip: results.filter((result) => result.final_verdict === "skip").length,
      max_steps: maxSteps,
      max_review_candidates: maxReviewCandidates,
      force_capture: forceCapture,
      mode: "freeform",
    },
    results,
  }, null, 2));
}

export async function runFreeformHarnessCli(): Promise<void> {
  let exitCode = 0;
  try {
    await ensureServer();
    const cases = buildCases();
    const results: FreeformResult[] = [];
    writeResults(results);
    for (let i = 0; i < cases.length; i++) {
      const result = await evaluateCase(cases[i]!, i);
      results.push(result);
      writeResults(results);
      console.log(`[codex-freeform] ${i + 1}/${cases.length} ${result.id} status=${result.final_verdict} reason=${result.final_reason}`);
    }
    exitCode = results.some((result) => result.final_verdict !== "pass") ? 1 : 0;
  } finally {
    if (localServer) {
      try { await localServer.close(); } catch { /* best effort */ }
    }
    localServer = null;
  }
  process.exit(exitCode);
}

if (import.meta.main) {
  await runFreeformHarnessCli().catch((error) => {
    console.error("[codex-freeform] fatal", error);
    process.exit(1);
  });
}
