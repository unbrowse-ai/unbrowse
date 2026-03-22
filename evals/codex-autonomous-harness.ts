#!/usr/bin/env bun

import { config as loadEnv } from "dotenv";
import { dirname, join, resolve } from "path";
import { readFileSync, writeFileSync } from "fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAuthCookies } from "../src/auth/index.js";
import { getSkillChunk, knownBindingsFromInputs, toAgentSkillChunkView } from "../src/graph/index.js";
import { startUnbrowseServer, type RunningUnbrowseServer } from "../src/server.js";
import type { SkillManifest } from "../src/types/index.js";
import {
  buildAgentExecuteCliArgs,
  compactForArtifact,
  fallbackEndpointOrder,
  normalizeHarnessCases,
  pickFreeformFollowUpUrl,
  type DeferredEndpoint,
  type HarnessCase,
  type HarnessTerminalState,
} from "./codex-harness-lib.js";
import {
  decideRepair,
  evaluateDagReadiness,
  classifyAutonomousFailure,
  summarizeBenchmarkRuns,
  type BenchmarkRunSummary,
  type DagEvaluation,
} from "./codex-autonomous-harness-lib.js";
import { resolveEvalJudgeMode, reviewEvalPayload } from "./codex-eval-review.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

loadEnv({ quiet: true });
loadEnv({ path: join(MODULE_DIR, "..", ".env.runtime"), override: false, quiet: true });
process.env.UNBROWSE_KURI_ATTACH_EXISTING_CHROME ??= "0";

type AutonomousCase = HarnessCase & {
  dag?: {
    target_operation_id?: string;
    target_endpoint_id?: string;
    require_path?: boolean;
  };
  repair?: {
    max_rounds?: number;
    max_candidates?: number;
    max_follow_urls?: number;
  };
};

type CandidateRecord = {
  endpoint_id: string;
  endpoint_url?: string;
  trigger_url?: string | null;
  execute_ms?: number;
  tokens_used?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
  attempt_count: number;
  verdict: "pass" | "fail" | "skip";
  reason: string;
  failure_class: string;
  source_kind: string;
  matched_fields: string[];
  missing_fields: string[];
  row_count: number;
  observed_entity_types: string[];
  validation_failures: string[];
  echoed_params: string[];
  side_effect_observed?: string;
  excerpt: unknown;
};

type SkillSnapshot = {
  skill_id: string;
  domain: string;
  auth_required: boolean;
  endpoint_count: number;
  operation_count: number;
  edge_count: number;
  updated_at?: string;
};

type TraceContext = {
  known_bindings: Record<string, unknown>;
  chunk?: ReturnType<typeof toAgentSkillChunkView>;
  skill_snapshot?: SkillSnapshot;
  source?: string;
  cache_hit?: boolean;
  total_ms?: number;
  tokens_used?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
};

type RepairMemory = {
  visited_urls: string[];
  attempted_endpoint_counts: Record<string, number>;
  failure_class_counts: Record<string, number>;
  reasons_seen: string[];
};

type RoundRecord = {
  round: number;
  run_label?: "cold" | "warm";
  url: string;
  force_capture: boolean;
  resolve_ms: number;
  skill_id?: string;
  available_endpoint_ids: string[];
  dag: DagEvaluation;
  trace_context: TraceContext;
  resolve_excerpt: unknown;
  candidates: CandidateRecord[];
  repair_action: string;
  repair_reason: string;
  repair_memory: RepairMemory;
};

type BenchmarkRecord = {
  mode: "cold-warm";
  cold: BenchmarkRunSummary;
  warm: BenchmarkRunSummary;
  delta: ReturnType<typeof summarizeBenchmarkRuns>;
};

type AutonomousResult = {
  id: string;
  intent: string;
  auth: boolean;
  final_state: "pass" | "fail" | "skip" | "blocked";
  goal_satisfied: boolean;
  allowed_terminal_states: HarnessTerminalState[];
  final_reason: string;
  final_source_kind?: string;
  matched_fields: string[];
  missing_fields: string[];
  repair_memory: RepairMemory;
  rounds: RoundRecord[];
  benchmark?: BenchmarkRecord;
};

const ROOT = join(MODULE_DIR, "..");
const EVALS_DIR = MODULE_DIR;
const DEFAULT_RESULTS_PATH = join(EVALS_DIR, "codex-autonomous-last-run.json");
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
const CLI_RATE_LIMIT_RETRIES = Math.max(0, Number(process.env.UNBROWSE_EVAL_RATE_LIMIT_RETRIES || "3"));

let localServer: RunningUnbrowseServer | null = null;

const argv = process.argv.slice(
  typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2,
);
const args = new Set(argv);
const getArg = (flag: string) => argv.find((_, i) => argv[i - 1] === `--${flag}`) ?? "";
const hasFlag = (flag: string) => args.has(flag) || args.has(flag.startsWith("--") ? flag : `--${flag}`);
const forceCapture = hasFlag("force-capture") || process.env.UNBROWSE_FORCE_CAPTURE === "1";
const restartServer = hasFlag("restart-server");
const maxRounds = Math.max(1, Number(getArg("max-rounds") || "6") || 6);
const maxCandidates = Math.max(1, Number(getArg("max-candidates") || "4") || 4);
const maxFollowUrls = Math.max(0, Number(getArg("max-follow-urls") || "3") || 3);
const benchmarkMode = hasFlag("benchmark") || process.env.UNBROWSE_EVAL_BENCHMARK === "1";
const resultsPath = resolve(getArg("out") || DEFAULT_RESULTS_PATH);
const evalJudgeMode = resolveEvalJudgeMode();

function usage(): never {
  console.error(
    "Usage:\n" +
    "  bun evals/codex-autonomous-harness.ts --intent '...' --url '...' [--params '{...}']\n" +
    "  bun evals/codex-autonomous-harness.ts --cases evals/codex-cases.example.json\n" +
    "Optional: --force-capture --benchmark --restart-server --max-rounds 6 --max-candidates 4 --max-follow-urls 3 --out <path>",
  );
  process.exit(1);
}

function rawCaseEntries(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    : raw && typeof raw === "object" && Array.isArray((raw as { cases?: unknown[] }).cases)
      ? (raw as { cases: unknown[] }).cases.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      : [];
}

function sanitizeDag(value: unknown): AutonomousCase["dag"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const target_operation_id = typeof record.target_operation_id === "string" ? record.target_operation_id : undefined;
  const target_endpoint_id = typeof record.target_endpoint_id === "string" ? record.target_endpoint_id : undefined;
  const require_path = typeof record.require_path === "boolean" ? record.require_path : undefined;
  if (!target_operation_id && !target_endpoint_id && require_path == null) return undefined;
  return { ...(target_operation_id ? { target_operation_id } : {}), ...(target_endpoint_id ? { target_endpoint_id } : {}), ...(require_path != null ? { require_path } : {}) };
}

function sanitizeRepair(value: unknown): AutonomousCase["repair"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const next: NonNullable<AutonomousCase["repair"]> = {};
  if (typeof record.max_rounds === "number" && Number.isFinite(record.max_rounds)) next.max_rounds = Math.max(1, Math.trunc(record.max_rounds));
  if (typeof record.max_candidates === "number" && Number.isFinite(record.max_candidates)) next.max_candidates = Math.max(1, Math.trunc(record.max_candidates));
  if (typeof record.max_follow_urls === "number" && Number.isFinite(record.max_follow_urls)) next.max_follow_urls = Math.max(0, Math.trunc(record.max_follow_urls));
  return Object.keys(next).length > 0 ? next : undefined;
}

function buildCases(): AutonomousCase[] {
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
      ...(getArg("target-operation") || getArg("target-endpoint") || hasFlag("--require-dag")
        ? {
            dag: {
              ...(getArg("target-operation") ? { target_operation_id: getArg("target-operation") } : {}),
              ...(getArg("target-endpoint") ? { target_endpoint_id: getArg("target-endpoint") } : {}),
              ...(hasFlag("--require-dag") ? { require_path: true } : {}),
            },
          }
        : {}),
    }];
  }

  const casesPath = getArg("cases");
  if (!casesPath) usage();
  const raw = JSON.parse(readFileSync(resolve(ROOT, casesPath), "utf-8"));
  const normalized = normalizeHarnessCases(raw);
  const entries = rawCaseEntries(raw);
  if (normalized.length === 0) throw new Error(`no valid cases in ${casesPath}`);
  return normalized.map((testCase, index) => {
    const rawEntry = entries[index] ?? {};
    const dag = sanitizeDag(rawEntry.dag);
    const repair = sanitizeRepair(rawEntry.repair);
    return {
      ...testCase,
      ...(dag ? { dag } : {}),
      ...(repair ? { repair } : {}),
    };
  });
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
    const out = Bun.spawnSync(["lsof", "-ti", `tcp:${BASE_PORT}`], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
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

export function getResolvedSkillId(body: any): string | undefined {
  return body?.result?.skill_id ?? body?.result?.learned_skill_id ?? body?.skill?.skill_id ?? body?.trace?.skill_id;
}

function getSkill(body: any): SkillManifest | undefined {
  return body?.skill ?? body?.result?.skill;
}

function getAvailableEndpoints(body: any): DeferredEndpoint[] {
  return body?.result?.available_endpoints ?? body?.available_endpoints ?? [];
}

export function synthesizeDeferredEndpointsFromSkill(skill?: SkillManifest): DeferredEndpoint[] {
  if (!skill) return [];
  return skill.endpoints.map((endpoint) => ({
    endpoint_id: endpoint.endpoint_id,
    url: endpoint.url_template,
    trigger_url: endpoint.trigger_url,
    schema_summary: endpoint.response_schema,
  }));
}

async function fetchResolvedSkill(skillId: string, clientId: string): Promise<SkillManifest | undefined> {
  try {
    const res = await fetch(`${BASE_URL}/v1/skills/${encodeURIComponent(skillId)}`, {
      headers: {
        "x-unbrowse-client-id": clientId,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return undefined;
    return await res.json() as SkillManifest;
  } catch {
    return undefined;
  }
}

function getJudgePayload(body: any): unknown {
  return body?.result ?? body?.trace?.result ?? null;
}

function allowedTerminalStates(testCase: AutonomousCase): HarnessTerminalState[] {
  return testCase.validate?.terminal_ok?.length ? testCase.validate.terminal_ok : ["pass"];
}

function isSatisfiedTerminalState(testCase: AutonomousCase, state: HarnessTerminalState): boolean {
  return allowedTerminalStates(testCase).includes(state);
}

function buildSkillSnapshot(skill?: SkillManifest): SkillSnapshot | undefined {
  if (!skill) return undefined;
  return {
    skill_id: skill.skill_id,
    domain: skill.domain,
    auth_required: !!skill.auth_profile_ref,
    endpoint_count: skill.endpoints.length,
    operation_count: skill.operation_graph?.operations.length ?? 0,
    edge_count: skill.operation_graph?.edges.length ?? 0,
    updated_at: skill.updated_at,
  };
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

function summarizeRepairMemory(state: {
  visitedUrls: Set<string>;
  attemptedEndpointCounts: Map<string, number>;
  failureClassCounts: Map<string, number>;
  reasonsSeen: string[];
}): RepairMemory {
  return {
    visited_urls: [...state.visitedUrls],
    attempted_endpoint_counts: Object.fromEntries([...state.attemptedEndpointCounts.entries()].sort(([lhs], [rhs]) => lhs.localeCompare(rhs))),
    failure_class_counts: Object.fromEntries([...state.failureClassCounts.entries()].sort(([lhs], [rhs]) => lhs.localeCompare(rhs))),
    reasons_seen: uniqueStrings(state.reasonsSeen).slice(-20),
  };
}

function incrementCount(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveTelemetry(body: any): Pick<TraceContext, "source" | "total_ms" | "tokens_used" | "tokens_saved" | "tokens_saved_pct"> {
  return {
    source: typeof body?.source === "string" ? body.source : typeof body?.timing?.source === "string" ? body.timing.source : undefined,
    cache_hit: body?.timing?.cache_hit === true,
    total_ms: numberOrUndefined(body?.timing?.total_ms),
    tokens_used: numberOrUndefined(body?.trace?.tokens_used),
    tokens_saved: numberOrUndefined(body?.timing?.tokens_saved ?? body?.trace?.tokens_saved),
    tokens_saved_pct: numberOrUndefined(body?.timing?.tokens_saved_pct ?? body?.trace?.tokens_saved_pct),
  };
}

function executeTelemetry(body: any): Pick<CandidateRecord, never> & {
  tokens_used?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
} {
  return {
    tokens_used: numberOrUndefined(body?.trace?.tokens_used),
    tokens_saved: numberOrUndefined(body?.trace?.tokens_saved),
    tokens_saved_pct: numberOrUndefined(body?.trace?.tokens_saved_pct),
  };
}

function summarizeRun(result: AutonomousResult, label: "cold" | "warm"): BenchmarkRunSummary {
  const totalResolveMs = result.rounds.reduce((sum, round) => sum + round.resolve_ms, 0);
  const totalExecuteMs = result.rounds.reduce(
    (sum, round) => sum + round.candidates.reduce((inner, candidate) => inner + (candidate.execute_ms ?? 0), 0),
    0,
  );
  const totalMs = totalResolveMs + totalExecuteMs;
  const firstRound = result.rounds[0];
  const lastRound = result.rounds[result.rounds.length - 1];
  const tokenSnapshots = result.rounds.flatMap((round) => [
    ...(round.trace_context.tokens_used != null ? [round.trace_context.tokens_used] : []),
    ...round.candidates.flatMap((candidate) => candidate.tokens_used != null ? [candidate.tokens_used] : []),
  ]);
  const savedSnapshots = result.rounds.flatMap((round) => [
    ...(round.trace_context.tokens_saved != null ? [round.trace_context.tokens_saved] : []),
    ...round.candidates.flatMap((candidate) => candidate.tokens_saved != null ? [candidate.tokens_saved] : []),
  ]);
  const savedPctSnapshots = result.rounds.flatMap((round) => [
    ...(round.trace_context.tokens_saved_pct != null ? [round.trace_context.tokens_saved_pct] : []),
    ...round.candidates.flatMap((candidate) => candidate.tokens_saved_pct != null ? [candidate.tokens_saved_pct] : []),
  ]);

  return {
    label,
    final_state: result.final_state,
    goal_satisfied: result.goal_satisfied,
    final_reason: result.final_reason,
    total_rounds: result.rounds.length,
    total_resolve_ms: totalResolveMs,
    total_execute_ms: totalExecuteMs,
    total_ms: totalMs,
    first_source: firstRound?.trace_context.source,
    final_source: lastRound?.trace_context.source,
    total_tokens_used: tokenSnapshots.reduce((sum, value) => sum + value, 0),
    total_tokens_saved: savedSnapshots.reduce((sum, value) => sum + value, 0),
    avg_tokens_saved_pct: savedPctSnapshots.length > 0
      ? Math.round(savedPctSnapshots.reduce((sum, value) => sum + value, 0) / savedPctSnapshots.length)
      : 0,
  };
}

async function evaluateCase(
  testCase: AutonomousCase,
  index: number,
  opts?: { initial_force_capture?: boolean; run_label?: "cold" | "warm" },
): Promise<AutonomousResult> {
  if (testCase.auth) {
    const cookies = await getAuthCookies(testCase.auth, { autoExtract: false });
    if (!cookies || cookies.length === 0) {
      return {
        id: testCase.id,
        intent: testCase.intent,
        auth: true,
        final_state: "skip",
        goal_satisfied: isSatisfiedTerminalState(testCase, "skip"),
        allowed_terminal_states: allowedTerminalStates(testCase),
        final_reason: `missing_${testCase.auth}_auth`,
        matched_fields: [],
        missing_fields: testCase.expected_fields,
        repair_memory: {
          visited_urls: [testCase.url],
          attempted_endpoint_counts: {},
          failure_class_counts: { auth: 1 },
          reasons_seen: [`missing_${testCase.auth}_auth`],
        },
        rounds: [],
      };
    }
  }

  const caseMaxRounds = testCase.repair?.max_rounds ?? maxRounds;
  const caseMaxCandidates = testCase.repair?.max_candidates ?? maxCandidates;
  const caseMaxFollowUrls = testCase.repair?.max_follow_urls ?? maxFollowUrls;
  const requireDagPath = testCase.dag?.require_path ?? !!(testCase.dag?.target_endpoint_id || testCase.dag?.target_operation_id);

  const clientId = `codex-autonomous-${index + 1}${opts?.run_label ? `-${opts.run_label}` : ""}`;
  const visitedUrls = new Set<string>([testCase.url]);
  const attemptedEndpointCounts = new Map<string, number>();
  const failureClassCounts = new Map<string, number>();
  const reasonsSeen: string[] = [];
  const rounds: RoundRecord[] = [];
  let currentUrl = testCase.url;
  let followCount = 0;

  for (let roundIndex = 0; roundIndex < caseMaxRounds; roundIndex++) {
    const initialForceCapture = opts?.initial_force_capture ?? forceCapture;
    const forceCaptureThisRound = initialForceCapture || roundIndex > 0;
    const resolveStarted = performance.now();
    let resolveResult: { code: number; body: any; stderr: string };
    try {
      resolveResult = await runCliWithRetry(clientId, [
        "resolve",
        "--intent", testCase.intent,
        "--url", currentUrl,
        ...(testCase.params ? ["--params", JSON.stringify(testCase.params)] : []),
        "--raw",
        ...(forceCaptureThisRound ? ["--force-capture"] : []),
      ]);
    } catch (error) {
      const failure = classifyAutonomousFailure(error instanceof Error ? error.message : String(error));
      const roundRecord: RoundRecord = {
        round: roundIndex + 1,
        ...(opts?.run_label ? { run_label: opts.run_label } : {}),
        url: currentUrl,
        force_capture: forceCaptureThisRound,
        resolve_ms: Math.round(performance.now() - resolveStarted),
        available_endpoint_ids: [],
        dag: {
          available: false,
          reachable: false,
          selected_path: [],
          reason: "resolve_threw",
        },
        trace_context: {
          known_bindings: compactForArtifact(knownBindingsFromInputs(testCase.params ?? {}, currentUrl)) as Record<string, unknown>,
          ...resolveTelemetry({}),
        },
        resolve_excerpt: compactForArtifact(error instanceof Error ? error.message : String(error)),
        candidates: [],
        repair_action: "pending",
        repair_reason: "pending",
        repair_memory: summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen }),
      };
      const decision = decideRepair({
        round: roundIndex,
        max_rounds: caseMaxRounds,
        already_force_captured: forceCaptureThisRound,
        follow_url: null,
        follow_budget_remaining: caseMaxFollowUrls - followCount,
        failure,
      });
      incrementCount(failureClassCounts, failure.class);
      reasonsSeen.push(decision.reason);
      roundRecord.repair_action = decision.action;
      roundRecord.repair_reason = decision.reason;
      roundRecord.repair_memory = summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen });
      rounds.push(roundRecord);
      if (decision.action === "stop") {
        return {
          id: testCase.id,
          intent: testCase.intent,
          auth: !!testCase.auth,
          final_state: decision.terminal_state,
          goal_satisfied: isSatisfiedTerminalState(testCase, decision.terminal_state),
          allowed_terminal_states: allowedTerminalStates(testCase),
          final_reason: decision.reason,
          matched_fields: [],
          missing_fields: testCase.expected_fields,
          repair_memory: summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen }),
          rounds,
        };
      }
      continue;
    }
    const resolveMs = Math.round(performance.now() - resolveStarted);
    const resolveBody = resolveResult.body;
    const resolveSkillId = getResolvedSkillId(resolveBody);
    const learnedSkillId = typeof resolveBody?.result?.learned_skill_id === "string" ? resolveBody.result.learned_skill_id : undefined;
    const embeddedResolveSkill = getSkill(resolveBody);
    const resolveSkill = learnedSkillId
      ? (embeddedResolveSkill?.skill_id === learnedSkillId ? embeddedResolveSkill : await fetchResolvedSkill(learnedSkillId, clientId) ?? embeddedResolveSkill)
      : embeddedResolveSkill;
    const resolveEndpoints = getAvailableEndpoints(resolveBody);
    const hydratedResolveEndpoints = resolveEndpoints.length > 0 ? resolveEndpoints : synthesizeDeferredEndpointsFromSkill(resolveSkill);
    const rawOrderedEndpointIds = fallbackEndpointOrder(hydratedResolveEndpoints);
    const orderedEndpointIds = [
      ...rawOrderedEndpointIds.filter((endpointId) => !attemptedEndpointCounts.has(endpointId)),
      ...rawOrderedEndpointIds.filter((endpointId) => attemptedEndpointCounts.has(endpointId)),
    ].slice(0, caseMaxCandidates);
    const dag = evaluateDagReadiness({
      skill: resolveSkill,
      target_operation_id: testCase.dag?.target_operation_id,
      target_endpoint_id: testCase.dag?.target_endpoint_id,
      candidate_endpoint_ids: orderedEndpointIds,
    });
    const knownBindings = knownBindingsFromInputs(testCase.params ?? {}, currentUrl);
    const chunk = resolveSkill
      ? getSkillChunk(resolveSkill, {
          intent: testCase.intent,
          known_bindings: knownBindings,
          seed_operation_id: dag.target_operation_id,
          max_operations: 8,
        })
      : undefined;
    const roundRecord: RoundRecord = {
      round: roundIndex + 1,
      ...(opts?.run_label ? { run_label: opts.run_label } : {}),
      url: currentUrl,
      force_capture: forceCaptureThisRound,
      resolve_ms: resolveMs,
      skill_id: resolveSkillId,
      available_endpoint_ids: orderedEndpointIds,
      dag,
      trace_context: {
        known_bindings: compactForArtifact(knownBindings) as Record<string, unknown>,
        ...(chunk ? { chunk: toAgentSkillChunkView(chunk) } : {}),
        ...(resolveSkill ? { skill_snapshot: buildSkillSnapshot(resolveSkill) } : {}),
        ...resolveTelemetry(resolveBody),
      },
      resolve_excerpt: compactForArtifact(resolveBody?.result ?? resolveBody),
      candidates: [],
      repair_action: "pending",
      repair_reason: "pending",
      repair_memory: summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen }),
    };

    if (resolveResult.code !== 0 || resolveBody?.error) {
      const failure = classifyAutonomousFailure(String(resolveBody?.error ?? "resolve_failed"), resolveBody);
      const decision = decideRepair({
        round: roundIndex,
        max_rounds: caseMaxRounds,
        already_force_captured: forceCaptureThisRound,
        follow_url: null,
        follow_budget_remaining: caseMaxFollowUrls - followCount,
        failure,
      });
      incrementCount(failureClassCounts, failure.class);
      reasonsSeen.push(decision.reason);
      roundRecord.repair_action = decision.action;
      roundRecord.repair_reason = decision.reason;
      roundRecord.repair_memory = summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen });
      rounds.push(roundRecord);
      if (decision.action === "stop") {
        return {
          id: testCase.id,
          intent: testCase.intent,
          auth: !!testCase.auth,
          final_state: decision.terminal_state,
          goal_satisfied: isSatisfiedTerminalState(testCase, decision.terminal_state),
          allowed_terminal_states: allowedTerminalStates(testCase),
          final_reason: decision.reason,
          matched_fields: [],
          missing_fields: testCase.expected_fields,
          repair_memory: summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen }),
          rounds,
        };
      }
      continue;
    }

    let lastReason = requireDagPath && !dag.reachable ? dag.reason : "no_candidate_pass";
    let lastSourceKind: string | undefined;
    let lastMatchedFields: string[] = [];
    let lastMissingFields = [...testCase.expected_fields];
    const directReview = await reviewEvalPayload({
      intent: testCase.intent,
      expected_fields: testCase.expected_fields,
      payload: getJudgePayload(resolveBody),
      judge_mode: evalJudgeMode,
      validate: testCase.validate,
      params: testCase.params,
    });
    roundRecord.candidates.push({
      endpoint_id: resolveBody?.trace?.endpoint_id ?? "direct_result",
      attempt_count: 0,
      verdict: directReview.verdict,
      reason: directReview.reason,
      failure_class: directReview.verdict === "pass" ? "none" : classifyAutonomousFailure(directReview.reason, directReview.projected_excerpt).class,
      source_kind: directReview.source_kind,
      matched_fields: directReview.matched_fields,
      missing_fields: directReview.missing_fields,
      row_count: directReview.row_count,
      observed_entity_types: directReview.observed_entity_types,
      validation_failures: directReview.validation_failures,
      echoed_params: directReview.echoed_params,
      side_effect_observed: directReview.side_effect_observed,
      ...executeTelemetry(resolveBody),
      excerpt: compactForArtifact(directReview.projected_excerpt),
    });
    if (directReview.verdict === "pass" && (!requireDagPath || dag.reachable)) {
      roundRecord.repair_action = "complete";
      roundRecord.repair_reason = "pass";
      rounds.push(roundRecord);
      return {
        id: testCase.id,
        intent: testCase.intent,
        auth: !!testCase.auth,
        final_state: "pass",
        goal_satisfied: isSatisfiedTerminalState(testCase, "pass"),
        allowed_terminal_states: allowedTerminalStates(testCase),
        final_reason: directReview.reason,
        final_source_kind: directReview.source_kind,
        matched_fields: directReview.matched_fields,
        missing_fields: directReview.missing_fields,
        repair_memory: summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen }),
        rounds,
      };
    }
    lastReason = directReview.verdict === "pass" && requireDagPath && !dag.reachable ? dag.reason : directReview.reason;
    lastSourceKind = directReview.source_kind;
    lastMatchedFields = directReview.matched_fields;
    lastMissingFields = directReview.missing_fields;

    if (hydratedResolveEndpoints.length > 0 && resolveSkillId) {
      for (const endpointId of orderedEndpointIds) {
        const endpoint = hydratedResolveEndpoints.find((item) => item.endpoint_id === endpointId);
        const attemptCount = incrementCount(attemptedEndpointCounts, endpointId);
        const executeStarted = performance.now();
        let execute;
        try {
          execute = await runCliWithRetry(
            clientId,
            buildAgentExecuteCliArgs(resolveSkillId, endpointId, {
              intent: testCase.intent,
              url: currentUrl,
              params: testCase.params,
            }).slice(2),
          );
        } catch (error) {
          execute = {
            code: 1,
            body: { error: error instanceof Error ? error.message : String(error) },
            stderr: "",
          };
        }
        const executeMs = Math.round(performance.now() - executeStarted);
        const review = execute.code === 0 && !execute.body?.error
          ? await reviewEvalPayload({
              intent: testCase.intent,
              expected_fields: testCase.expected_fields,
              payload: getJudgePayload(execute.body),
              endpoint,
              judge_mode: evalJudgeMode,
              validate: testCase.validate,
              params: testCase.params,
            })
          : {
              verdict: "fail" as const,
              reason: String(execute.body?.error ?? `execute_failed:${endpointId}`),
              source_kind: "empty" as const,
              matched_fields: [],
              missing_fields: testCase.expected_fields,
              projected_excerpt: execute.body,
              row_count: 0,
              observed_entity_types: [],
              validation_failures: [],
              echoed_params: [],
              side_effect_observed: undefined,
            };
        const failureClass = review.verdict === "pass" ? "none" : classifyAutonomousFailure(review.reason, review.projected_excerpt).class;
        if (failureClass !== "none") incrementCount(failureClassCounts, failureClass);
        if (review.reason) reasonsSeen.push(review.reason);
        roundRecord.candidates.push({
          endpoint_id: endpointId,
          endpoint_url: endpoint?.url,
          trigger_url: endpoint?.trigger_url,
          execute_ms: executeMs,
          attempt_count: attemptCount,
          verdict: review.verdict,
          reason: review.reason,
          failure_class: failureClass,
          source_kind: review.source_kind,
          matched_fields: review.matched_fields,
          missing_fields: review.missing_fields,
          row_count: review.row_count,
          observed_entity_types: review.observed_entity_types,
          validation_failures: review.validation_failures,
          echoed_params: review.echoed_params,
          side_effect_observed: review.side_effect_observed,
          ...executeTelemetry(execute.body),
          excerpt: compactForArtifact(review.projected_excerpt),
        });
        if (review.verdict === "pass" && (!requireDagPath || dag.reachable)) {
          roundRecord.repair_action = "complete";
          roundRecord.repair_reason = "pass";
          rounds.push(roundRecord);
          return {
            id: testCase.id,
            intent: testCase.intent,
            auth: !!testCase.auth,
            final_state: "pass",
            goal_satisfied: isSatisfiedTerminalState(testCase, "pass"),
            allowed_terminal_states: allowedTerminalStates(testCase),
            final_reason: review.reason,
            final_source_kind: review.source_kind,
            matched_fields: review.matched_fields,
            missing_fields: review.missing_fields,
            repair_memory: summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen }),
            rounds,
          };
        }
        lastReason = review.verdict === "pass" && requireDagPath && !dag.reachable ? dag.reason : review.reason;
        lastSourceKind = review.source_kind;
        lastMatchedFields = review.matched_fields;
        lastMissingFields = review.missing_fields;
      }
    }

    const followUrl = pickFreeformFollowUpUrl(currentUrl, resolveEndpoints, visitedUrls);
    const failure = classifyAutonomousFailure(lastReason, roundRecord);
    const decision = decideRepair({
      round: roundIndex,
      max_rounds: caseMaxRounds,
      already_force_captured: forceCaptureThisRound,
      follow_url: followUrl,
      follow_budget_remaining: caseMaxFollowUrls - followCount,
      failure,
    });
    incrementCount(failureClassCounts, failure.class);
    reasonsSeen.push(decision.reason);
    roundRecord.repair_action = decision.action;
    roundRecord.repair_reason = decision.reason;
    roundRecord.repair_memory = summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen });
    rounds.push(roundRecord);

    if (decision.action === "follow_url") {
      visitedUrls.add(decision.next_url);
      currentUrl = decision.next_url;
      followCount += 1;
      continue;
    }
    if (decision.action === "retry_force_capture") {
      continue;
    }
    return {
      id: testCase.id,
      intent: testCase.intent,
      auth: !!testCase.auth,
      final_state: decision.terminal_state,
      goal_satisfied: isSatisfiedTerminalState(testCase, decision.terminal_state),
      allowed_terminal_states: allowedTerminalStates(testCase),
      final_reason: decision.reason,
      final_source_kind: lastSourceKind,
      matched_fields: lastMatchedFields,
      missing_fields: lastMissingFields,
      repair_memory: summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen }),
      rounds,
    };
  }

  const lastRound = rounds[rounds.length - 1];
  const lastCandidate = lastRound?.candidates[lastRound.candidates.length - 1];
  return {
    id: testCase.id,
    intent: testCase.intent,
    auth: !!testCase.auth,
    final_state: "fail",
    goal_satisfied: isSatisfiedTerminalState(testCase, "fail"),
    allowed_terminal_states: allowedTerminalStates(testCase),
    final_reason: lastCandidate?.reason ?? "autonomous_round_budget_exhausted",
    final_source_kind: lastCandidate?.source_kind,
    matched_fields: lastCandidate?.matched_fields ?? [],
    missing_fields: lastCandidate?.missing_fields ?? testCase.expected_fields,
    repair_memory: summarizeRepairMemory({ visitedUrls, attemptedEndpointCounts, failureClassCounts, reasonsSeen }),
    rounds,
  };
}

function writeResults(results: AutonomousResult[]): void {
  const benchmarkResults = results.filter((result) => result.benchmark);
  const benchmarkSummary = benchmarkResults.length > 0
    ? {
        cases: benchmarkResults.length,
        cold_total_ms: benchmarkResults.reduce((sum, result) => sum + (result.benchmark?.cold.total_ms ?? 0), 0),
        warm_total_ms: benchmarkResults.reduce((sum, result) => sum + (result.benchmark?.warm.total_ms ?? 0), 0),
        speedup_ms: benchmarkResults.reduce((sum, result) => sum + (result.benchmark?.delta.speedup_ms ?? 0), 0),
        cold_tokens_used: benchmarkResults.reduce((sum, result) => sum + (result.benchmark?.cold.total_tokens_used ?? 0), 0),
        warm_tokens_used: benchmarkResults.reduce((sum, result) => sum + (result.benchmark?.warm.total_tokens_used ?? 0), 0),
        token_delta: benchmarkResults.reduce((sum, result) => sum + (result.benchmark?.delta.token_delta ?? 0), 0),
      }
    : undefined;
  writeFileSync(resultsPath, JSON.stringify({
    summary: {
      total: results.length,
      pass: results.filter((result) => result.final_state === "pass").length,
      fail: results.filter((result) => result.final_state === "fail").length,
      skip: results.filter((result) => result.final_state === "skip").length,
      blocked: results.filter((result) => result.final_state === "blocked").length,
      satisfied: results.filter((result) => result.goal_satisfied).length,
      unsatisfied: results.filter((result) => !result.goal_satisfied).length,
      max_rounds: maxRounds,
      max_candidates: maxCandidates,
      max_follow_urls: maxFollowUrls,
      force_capture: forceCapture,
      benchmark: benchmarkMode,
      mode: "autonomous",
      ...(benchmarkSummary ? { benchmark_summary: benchmarkSummary } : {}),
    },
    results,
  }, null, 2));
}

export async function runAutonomousHarnessCli(): Promise<void> {
  let exitCode = 0;
  try {
    await ensureServer();
    const cases = buildCases();
    const results: AutonomousResult[] = [];
    writeResults(results);
    for (let i = 0; i < cases.length; i++) {
      let result: AutonomousResult;
      if (benchmarkMode) {
        const cold = await evaluateCase(cases[i]!, i, { initial_force_capture: true, run_label: "cold" });
        const warm = await evaluateCase(cases[i]!, i, { initial_force_capture: false, run_label: "warm" });
        const coldSummary = summarizeRun(cold, "cold");
        const warmSummary = summarizeRun(warm, "warm");
        result = {
          ...warm,
          rounds: [...cold.rounds, ...warm.rounds],
          benchmark: {
            mode: "cold-warm",
            cold: coldSummary,
            warm: warmSummary,
            delta: summarizeBenchmarkRuns(coldSummary, warmSummary),
          },
        };
      } else {
        result = await evaluateCase(cases[i]!, i);
      }
      results.push(result);
      writeResults(results);
      const benchSuffix = result.benchmark
        ? ` cold=${result.benchmark.cold.total_ms}ms warm=${result.benchmark.warm.total_ms}ms token_delta=${result.benchmark.delta.token_delta}`
        : "";
      console.log(`[codex-autonomous] ${i + 1}/${cases.length} ${result.id} state=${result.final_state} satisfied=${result.goal_satisfied} reason=${result.final_reason}${benchSuffix}`);
    }
    exitCode = results.some((result) => !result.goal_satisfied) ? 1 : 0;
  } finally {
    if (localServer) {
      try { await localServer.close(); } catch { /* best effort */ }
    }
    localServer = null;
  }
  process.exit(exitCode);
}

if (import.meta.main) {
  await runAutonomousHarnessCli().catch((error) => {
    console.error("[codex-autonomous] fatal", error);
    process.exit(1);
  });
}
