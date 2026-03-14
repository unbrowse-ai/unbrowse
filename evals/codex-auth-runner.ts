#!/usr/bin/env bun

import { config as loadEnv } from "dotenv";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import { BrowserManager } from "agent-browser/dist/browser.js";
import { getAuthCookies, getProfilePath } from "../src/auth/index.js";
import { getRegistrableDomain, isDomainMatch } from "../src/domain.js";
import { startUnbrowseServer, type RunningUnbrowseServer } from "../src/server.js";
import { storeCredential } from "../src/vault/index.js";
import { compactForArtifact } from "./codex-harness-lib.js";
import {
  corpusSummary,
  filterAuthEvalCases,
  loadAuthEvalCases,
  summarizeWorkflow,
  toHarnessCase,
  workflowStepToHarnessCase,
  type AuthBootstrapConfig,
  type AuthEvalCase,
  type AuthBootstrapStep,
  type AuthWorkflowStep,
  type WorkflowStepPhase,
} from "./codex-auth-runner-lib.js";

loadEnv({ quiet: true });
loadEnv({ path: join(dirname(new URL(import.meta.url).pathname), "..", ".env.runtime"), override: false, quiet: true });

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const EVALS_DIR = dirname(new URL(import.meta.url).pathname);
const DEFAULT_CASES_PATH = join(EVALS_DIR, "codex-cases.auth-popular.json");
const DEFAULT_RESULTS_PATH = join(EVALS_DIR, "codex-auth-eval-last-run.json");
const LOCAL_BASE_URL = "http://127.0.0.1:6969";
const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 6969;
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const STEP_TIMEOUT_MS = 30_000;
const HARNESS_TIMEOUT_MS = Number(process.env.UNBROWSE_AUTH_EVAL_TIMEOUT_MS || "300000");

type BootstrapOutcome = {
  strategy: AuthBootstrapConfig["strategy"];
  status: "ready" | "skip" | "fail";
  reason: string;
  cookies_found: number;
  matched_required_cookies: string[];
  login_url?: string;
  success_url?: string;
  elapsed_ms: number;
  used_existing_session: boolean;
};

type HarnessOutcome = {
  artifact_path: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  final_state?: string;
  goal_satisfied?: boolean;
  final_reason?: string;
  matched_fields?: string[];
  missing_fields?: string[];
  rounds?: number;
  total_ms?: number;
  performance_total_ms?: number;
  performance_basis?: "raw" | "warm";
  total_errors?: number;
  benchmark?: {
    cold_total_ms: number;
    warm_total_ms: number;
    speedup_ms: number;
    token_delta: number;
  };
};

type WorkflowStepOutcome = {
  id: string;
  title?: string;
  phase: WorkflowStepPhase;
  required: boolean;
  step_max_total_ms?: number;
  artifact_path: string;
  final_state: "pass" | "fail" | "skip" | "blocked";
  goal_satisfied: boolean;
  final_reason: string;
  matched_fields: string[];
  missing_fields: string[];
  total_ms: number;
  performance_total_ms: number;
  performance_basis: "raw" | "warm";
  rounds: number;
  benchmark?: HarnessOutcome["benchmark"];
};

type WorkflowOutcome = {
  total_ms: number;
  performance_total_ms: number;
  error_count: number;
  failed_step_ids: string[];
  exceeded_step_budget_ids: string[];
  exceeded_total_budget: boolean;
  step_results: WorkflowStepOutcome[];
};

type AuthRunResult = {
  id: string;
  suite_round: number;
  suite: string;
  site?: string;
  url: string;
  intent: string;
  popularity?: AuthEvalCase["popularity"];
  bootstrap: BootstrapOutcome;
  harness?: HarnessOutcome;
  workflow?: WorkflowOutcome;
  final_state: string;
  goal_satisfied: boolean;
  final_reason: string;
};

const argv = process.argv.slice(
  typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2,
);
const args = new Set(argv);
const getArg = (flag: string) => argv.find((_, i) => argv[i - 1] === `--${flag}`) ?? "";
const hasFlag = (flag: string) => args.has(`--${flag}`);

const casesPath = resolve(getArg("cases") || DEFAULT_CASES_PATH);
const suite = getArg("suite") || "all";
const idFilter = getArg("id");
const top = Math.max(0, Number(getArg("top") || "0") || 0);
const suiteRounds = Math.max(1, Number(getArg("suite-rounds") || "3") || 3);
const maxRounds = Math.max(1, Number(getArg("max-rounds") || "6") || 6);
const maxCandidates = Math.max(1, Number(getArg("max-candidates") || "4") || 4);
const maxFollowUrls = Math.max(0, Number(getArg("max-follow-urls") || "3") || 3);
const resultsPath = resolve(getArg("out") || DEFAULT_RESULTS_PATH);
const interactiveLogin = hasFlag("interactive-login");
const benchmarkMode = hasFlag("benchmark");
let localServer: RunningUnbrowseServer | null = null;

function usage(): never {
  console.error(
    "Usage:\n" +
    "  bun evals/codex-auth-runner.ts [--cases evals/codex-cases.auth-popular.json]\n" +
    "Optional: --suite popular-cookie-reuse|scripted-demo|all --id <case-id> --top 10 --suite-rounds 3 --interactive-login --benchmark --max-rounds 6 --max-candidates 4 --max-follow-urls 3 --out <path>",
  );
  process.exit(1);
}

function resolveBinding(raw: string, config: AuthBootstrapConfig): string {
  return raw
    .replace(/\$USERNAME/g, config.username ?? "")
    .replace(/\$PASSWORD/g, config.password ?? "")
    .replace(/\$EMAIL/g, config.email ?? "")
    .replace(/\$NAME/g, config.name ?? "")
    .replace(/\$OTP_CODE/g, "");
}

function requiredCookies(cookies: Array<{ name: string }>, required: string[] | undefined): string[] {
  if (!required || required.length === 0) return [];
  const names = new Set(cookies.map((cookie) => cookie.name));
  return required.filter((name) => names.has(name));
}

async function applyBootstrapStep(page: any, step: AuthBootstrapStep, config: AuthBootstrapConfig): Promise<void> {
  switch (step.action) {
    case "fill":
      await page.locator(step.selector).fill(resolveBinding(step.value, config), { timeout: STEP_TIMEOUT_MS });
      return;
    case "click":
      await page.locator(step.selector).click({ timeout: STEP_TIMEOUT_MS });
      return;
    case "wait_for_url":
      await page.waitForURL(step.pattern, { timeout: STEP_TIMEOUT_MS });
      return;
    case "wait_for_selector":
      await page.locator(step.selector).waitFor({ timeout: STEP_TIMEOUT_MS });
      return;
    case "sleep":
      await new Promise((resolveSleep) => setTimeout(resolveSleep, step.ms));
      return;
  }
}

async function persistCookies(domain: string, cookies: Array<{
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}>): Promise<void> {
  const storable = cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expires: cookie.expires,
  }));
  await storeCredential(`auth:${getRegistrableDomain(domain)}`, JSON.stringify({ cookies: storable }));
}

async function scriptedLogin(testCase: AuthEvalCase): Promise<BootstrapOutcome> {
  const started = Date.now();
  const config = testCase.auth_bootstrap;
  const authDomain = testCase.auth ?? new URL(testCase.url).hostname;
  if (!config.login_url || !config.steps || config.steps.length === 0) {
    return {
      strategy: config.strategy,
      status: "fail",
      reason: "missing_scripted_login_steps",
      cookies_found: 0,
      matched_required_cookies: [],
      login_url: config.login_url,
      success_url: config.success_url,
      elapsed_ms: Date.now() - started,
      used_existing_session: false,
    };
  }

  const browser = new BrowserManager();
  try {
    await browser.launch({
      action: "launch",
      id: nanoid(),
      headless: true,
      profile: getProfilePath(authDomain),
      userAgent: CHROME_UA,
    });
    const page = browser.getPage();
    await page.goto(config.login_url, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
    for (const step of config.steps) {
      await applyBootstrapStep(page, step, config);
    }
    if (config.success_url) {
      await page.waitForURL(config.success_url, { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const finalUrl = page.url();
    const context = browser.getContext();
    const cookies = context ? await context.cookies() : [];
    const domainCookies = cookies.filter((cookie: { domain: string }) => isDomainMatch(cookie.domain, authDomain));
    if (domainCookies.length === 0) {
      const successUrlReached = !!config.success_url && (() => {
        try {
          return new URL(finalUrl).href === new URL(config.success_url!).href;
        } catch {
          return finalUrl === config.success_url;
        }
      })();
      if (successUrlReached) {
        return {
          strategy: config.strategy,
          status: "ready",
          reason: "scripted_login_profile_only",
          cookies_found: 0,
          matched_required_cookies: [],
          login_url: config.login_url,
          success_url: config.success_url,
          elapsed_ms: Date.now() - started,
          used_existing_session: false,
        };
      }
      return {
        strategy: config.strategy,
        status: "fail",
        reason: "no_cookies_captured",
        cookies_found: 0,
        matched_required_cookies: [],
        login_url: config.login_url,
        success_url: config.success_url,
        elapsed_ms: Date.now() - started,
        used_existing_session: false,
      };
    }
    await persistCookies(authDomain, domainCookies);
    const matched = requiredCookies(domainCookies, config.required_cookie_names);
    return {
      strategy: config.strategy,
      status: "ready",
      reason: matched.length === 0 && config.required_cookie_names?.length
        ? "scripted_login_cookies_missing_named_auth_cookie"
        : "scripted_login_ok",
      cookies_found: domainCookies.length,
      matched_required_cookies: matched,
      login_url: config.login_url,
      success_url: config.success_url,
      elapsed_ms: Date.now() - started,
      used_existing_session: false,
    };
  } catch (error) {
    return {
      strategy: config.strategy,
      status: "fail",
      reason: error instanceof Error ? error.message : String(error),
      cookies_found: 0,
      matched_required_cookies: [],
      login_url: config.login_url,
      success_url: config.success_url,
      elapsed_ms: Date.now() - started,
      used_existing_session: false,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function cookieReuse(testCase: AuthEvalCase): Promise<BootstrapOutcome> {
  const started = Date.now();
  const authDomain = testCase.auth ?? new URL(testCase.url).hostname;
  const cookies = await getAuthCookies(authDomain);
  const matched = requiredCookies(cookies ?? [], testCase.auth_bootstrap.required_cookie_names);
  if (!cookies || cookies.length === 0) {
    return {
      strategy: testCase.auth_bootstrap.strategy,
      status: "skip",
      reason: "missing_browser_auth",
      cookies_found: 0,
      matched_required_cookies: [],
      login_url: testCase.auth_bootstrap.login_url,
      success_url: testCase.auth_bootstrap.success_url,
      elapsed_ms: Date.now() - started,
      used_existing_session: false,
    };
  }
  if (testCase.auth_bootstrap.required_cookie_names?.length && matched.length === 0) {
    return {
      strategy: testCase.auth_bootstrap.strategy,
      status: "skip",
      reason: "missing_required_auth_cookie",
      cookies_found: cookies.length,
      matched_required_cookies: [],
      login_url: testCase.auth_bootstrap.login_url,
      success_url: testCase.auth_bootstrap.success_url,
      elapsed_ms: Date.now() - started,
      used_existing_session: true,
    };
  }
  await persistCookies(authDomain, cookies);
  return {
    strategy: testCase.auth_bootstrap.strategy,
    status: "ready",
    reason: "browser_auth_ready",
    cookies_found: cookies.length,
    matched_required_cookies: matched,
    login_url: testCase.auth_bootstrap.login_url,
    success_url: testCase.auth_bootstrap.success_url,
    elapsed_ms: Date.now() - started,
    used_existing_session: true,
  };
}

async function interactiveLoginBootstrap(testCase: AuthEvalCase): Promise<BootstrapOutcome> {
  const started = Date.now();
  if (!interactiveLogin) {
    return {
      strategy: testCase.auth_bootstrap.strategy,
      status: "skip",
      reason: "interactive_login_required",
      cookies_found: 0,
      matched_required_cookies: [],
      login_url: testCase.auth_bootstrap.login_url,
      success_url: testCase.auth_bootstrap.success_url,
      elapsed_ms: Date.now() - started,
      used_existing_session: false,
    };
  }
  const loginUrl = testCase.auth_bootstrap.login_url ?? testCase.url;
  const child = await spawnCommand(["bun", "src/cli.ts", "login", "--url", loginUrl]);
  const authDomain = testCase.auth ?? new URL(testCase.url).hostname;
  const cookies = await getAuthCookies(authDomain);
  const matched = requiredCookies(cookies ?? [], testCase.auth_bootstrap.required_cookie_names);
  if (cookies && cookies.length > 0) {
    await persistCookies(authDomain, cookies);
  }
  return {
    strategy: testCase.auth_bootstrap.strategy,
    status: child.code === 0 && cookies && cookies.length > 0 ? "ready" : "skip",
    reason: child.code === 0 && cookies && cookies.length > 0 ? "interactive_login_ok" : "interactive_login_incomplete",
    cookies_found: cookies?.length ?? 0,
    matched_required_cookies: matched,
    login_url: loginUrl,
    success_url: testCase.auth_bootstrap.success_url,
    elapsed_ms: Date.now() - started,
    used_existing_session: false,
  };
}

async function bootstrapCase(testCase: AuthEvalCase): Promise<BootstrapOutcome> {
  switch (testCase.auth_bootstrap.strategy) {
    case "cookie_reuse":
      return cookieReuse(testCase);
    case "scripted_login":
      return scriptedLogin(testCase);
    case "interactive_login":
      return interactiveLoginBootstrap(testCase);
    case "agentmail_register":
      return {
        strategy: testCase.auth_bootstrap.strategy,
        status: "skip",
        reason: "agentmail_bootstrap_not_wired",
        cookies_found: 0,
        matched_required_cookies: [],
        login_url: testCase.auth_bootstrap.login_url,
        success_url: testCase.auth_bootstrap.success_url,
        elapsed_ms: 0,
        used_existing_session: false,
      };
  }
}

async function spawnCommand(
  command: string[],
  envOverrides?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const [cmd, ...args] = command;
  return await new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(cmd!, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, HARNESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectSpawn(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveSpawn({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_BASE_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function listServerPids(): number[] {
  const pids = new Set<number>();
  try {
    const pidText = readFileSync(
      join(process.env.HOME ?? "", ".unbrowse", "run", `server-${LOCAL_HOST}-${LOCAL_PORT}.json`),
      "utf-8",
    );
    const pid = JSON.parse(pidText).pid;
    if (typeof pid === "number" && Number.isFinite(pid)) pids.add(pid);
  } catch {
    // best effort
  }
  try {
    const out = Bun.spawnSync(["lsof", "-ti", `tcp:${LOCAL_PORT}`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
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

async function stopRepoServer(): Promise<void> {
  if (localServer) {
    try { await localServer.close(); } catch { /* best effort */ }
    localServer = null;
  }
  for (const pid of listServerPids()) {
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

async function ensureRepoServer(): Promise<void> {
  if (localServer) return;
  if (await isServerUp()) await stopRepoServer();
  process.env.UNBROWSE_DISABLE_RATE_LIMIT = "1";
  localServer = await startUnbrowseServer({
    host: LOCAL_HOST,
    port: LOCAL_PORT,
    pidFile: undefined,
    scheduleVerification: false,
  });
}

function artifactPathForCase(testCase: AuthEvalCase): string {
  return join(EVALS_DIR, `codex-auth-site.${testCase.id}.json`);
}

function stepArtifactPath(testCase: AuthEvalCase, phase: WorkflowStepPhase, stepId: string): string {
  return join(EVALS_DIR, `codex-auth-site.${testCase.id}.${phase}.${stepId}.json`);
}

function isTerminalEnough(result: AuthRunResult): boolean {
  return result.goal_satisfied || ["skip", "blocked"].includes(result.final_state);
}

function bestResultPerCase(results: AuthRunResult[]): Record<string, AuthRunResult> {
  const best: Record<string, AuthRunResult> = {};
  for (const result of results) {
    const current = best[result.id];
    if (!current) {
      best[result.id] = result;
      continue;
    }
    const currentScore = Number(current.goal_satisfied) * 10 + Number(isTerminalEnough(current)) * 5 + (current.final_state === "pass" ? 3 : 0);
    const nextScore = Number(result.goal_satisfied) * 10 + Number(isTerminalEnough(result)) * 5 + (result.final_state === "pass" ? 3 : 0);
    if (nextScore >= currentScore) best[result.id] = result;
  }
  return best;
}

function writeResults(results: AuthRunResult[], selectedCases: AuthEvalCase[]): void {
  const bestByCase = bestResultPerCase(results);
  const bestResults = Object.values(bestByCase);
  const counts = {
    total: bestResults.length,
    attempts: results.length,
    ready: bestResults.filter((result) => result.bootstrap.status === "ready").length,
    skipped_bootstrap: bestResults.filter((result) => result.bootstrap.status === "skip").length,
    failed_bootstrap: bestResults.filter((result) => result.bootstrap.status === "fail").length,
    pass: bestResults.filter((result) => result.final_state === "pass").length,
    fail: bestResults.filter((result) => result.final_state === "fail").length,
    skip: bestResults.filter((result) => result.final_state === "skip").length,
    blocked: bestResults.filter((result) => result.final_state === "blocked").length,
    satisfied: bestResults.filter((result) => result.goal_satisfied).length,
    unsatisfied: bestResults.filter((result) => !result.goal_satisfied).length,
  };
  writeFileSync(resultsPath, JSON.stringify({
    summary: {
      ...counts,
      suite,
      top,
      suite_rounds: suiteRounds,
      benchmark: benchmarkMode,
      interactive_login: interactiveLogin,
      max_rounds: maxRounds,
      max_candidates: maxCandidates,
      max_follow_urls: maxFollowUrls,
      corpus: corpusSummary(selectedCases),
      cases_path: casesPath,
    },
    best_results: bestResults,
    attempts: results,
  }, null, 2));
}

async function runCase(testCase: AuthEvalCase, suiteRound: number): Promise<AuthRunResult> {
  const bootstrap = await bootstrapCase(testCase);
  if (bootstrap.status !== "ready") {
    return {
      id: testCase.id,
      suite_round: suiteRound,
      suite: testCase.suite ?? "default",
      site: testCase.site,
      url: testCase.url,
      intent: testCase.intent,
      popularity: testCase.popularity,
      bootstrap,
      final_state: bootstrap.status === "fail" ? "fail" : "skip",
      goal_satisfied: !!testCase.validate?.terminal_ok?.includes(bootstrap.status === "fail" ? "fail" : "skip"),
      final_reason: bootstrap.reason,
    };
  }

  await ensureRepoServer();
  const useProfileOnlyAuth = bootstrap.reason === "scripted_login_profile_only";
  const withEffectiveAuth = <T extends { auth?: string }>(harnessCase: T): T =>
    useProfileOnlyAuth
      ? (({ auth: _auth, ...rest }) => rest as T)(harnessCase)
      : harnessCase;

  async function runHarnessStep(
    harnessCase: ReturnType<typeof toHarnessCase>,
    artifactPath: string,
    options?: { benchmark?: boolean },
  ): Promise<HarnessOutcome> {
    await ensureRepoServer();
    const tmpDir = mkdtempSync(join(tmpdir(), "unbrowse-auth-case-"));
    const tmpCasePath = join(tmpDir, `${harnessCase.id}.json`);
    writeFileSync(tmpCasePath, JSON.stringify({ cases: [harnessCase] }, null, 2));
    const command = [
      "bun",
      "evals/codex-autonomous-harness.ts",
      "--cases",
      tmpCasePath,
      "--out",
      artifactPath,
      "--max-rounds",
      String(maxRounds),
      "--max-candidates",
      String(maxCandidates),
      "--max-follow-urls",
      String(maxFollowUrls),
      ...((options?.benchmark ?? benchmarkMode) ? ["--benchmark"] : []),
    ];
    const spawned = await spawnCommand(command, { UNBROWSE_URL: LOCAL_BASE_URL });
    const rawArtifact = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
      results?: Array<{
        final_state?: string;
        goal_satisfied?: boolean;
        final_reason?: string;
        matched_fields?: string[];
        missing_fields?: string[];
        benchmark?: {
          cold?: { total_ms?: number };
          warm?: { total_ms?: number };
          delta?: { speedup_ms?: number; token_delta?: number };
        };
        rounds?: Array<{ resolve_ms?: number; candidates?: Array<{ execute_ms?: number; verdict?: string }> }>;
      }>;
    };
    const first = rawArtifact.results?.[0];
    const totalMs = Array.isArray(first?.rounds)
      ? first!.rounds!.reduce((sum, round) => {
          const executeMs = Array.isArray(round.candidates)
            ? round.candidates.reduce((candSum, candidate) => candSum + (candidate.execute_ms ?? 0), 0)
            : 0;
          return sum + (round.resolve_ms ?? 0) + executeMs;
        }, 0)
      : undefined;
    const totalErrors = Array.isArray(first?.rounds)
      ? first!.rounds!.reduce((sum, round) => sum + ((round.candidates ?? []).filter((candidate) => candidate.verdict !== "pass").length), 0)
      : undefined;
    const warmTotalMs = typeof first?.benchmark?.warm?.total_ms === "number" ? first.benchmark.warm.total_ms : undefined;
    const coldTotalMs = typeof first?.benchmark?.cold?.total_ms === "number" ? first.benchmark.cold.total_ms : undefined;
    rmSync(tmpDir, { recursive: true, force: true });
    return {
      artifact_path: artifactPath,
      exit_code: spawned.code,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      final_state: first?.final_state,
      goal_satisfied: first?.goal_satisfied,
      final_reason: first?.final_reason,
      matched_fields: first?.matched_fields,
      missing_fields: first?.missing_fields,
      rounds: Array.isArray(first?.rounds) ? first!.rounds!.length : undefined,
      total_ms: totalMs,
      performance_total_ms: warmTotalMs ?? totalMs,
      performance_basis: warmTotalMs != null ? "warm" : "raw",
      total_errors: totalErrors,
      ...(coldTotalMs != null && warmTotalMs != null
        ? {
            benchmark: {
              cold_total_ms: coldTotalMs,
              warm_total_ms: warmTotalMs,
              speedup_ms: typeof first?.benchmark?.delta?.speedup_ms === "number"
                ? first.benchmark.delta.speedup_ms
                : coldTotalMs - warmTotalMs,
              token_delta: typeof first?.benchmark?.delta?.token_delta === "number"
                ? first.benchmark.delta.token_delta
                : 0,
            },
          }
        : {}),
    };
  }

  if (!testCase.workflow) {
    const caseArtifactPath = artifactPathForCase(testCase);
    const harness = await runHarnessStep(withEffectiveAuth(toHarnessCase(testCase)), caseArtifactPath);
    return {
      id: testCase.id,
      suite_round: suiteRound,
      suite: testCase.suite ?? "default",
      site: testCase.site,
      url: testCase.url,
      intent: testCase.intent,
      popularity: testCase.popularity,
      bootstrap,
      harness,
      final_state: harness.final_state ?? (harness.exit_code === 0 ? "pass" : "fail"),
      goal_satisfied: harness.goal_satisfied ?? false,
      final_reason: harness.final_reason ?? "missing_harness_result",
    };
  }

  const stepResults: WorkflowStepOutcome[] = [];
  const workflowNeedsBenchmark =
    benchmarkMode ||
    testCase.workflow.max_total_ms != null ||
    [testCase.workflow.steps, testCase.workflow.verify ?? [], testCase.workflow.cleanup ?? []]
      .flat()
      .some((step) => step.max_total_ms != null);
  const phaseSpecs: Array<{ phase: WorkflowStepPhase; steps: AuthWorkflowStep[] }> = [
    { phase: "step", steps: testCase.workflow.steps },
    { phase: "verify", steps: testCase.workflow.verify ?? [] },
    { phase: "cleanup", steps: testCase.workflow.cleanup ?? [] },
  ];

  let blockLaterPhases = false;
  for (const phaseSpec of phaseSpecs) {
    if (blockLaterPhases && phaseSpec.phase !== "cleanup") continue;
    for (const step of phaseSpec.steps) {
      const harnessCase = withEffectiveAuth(workflowStepToHarnessCase(testCase, step));
      const harness = await runHarnessStep(
        harnessCase,
        stepArtifactPath(testCase, phaseSpec.phase, step.id),
        { benchmark: workflowNeedsBenchmark },
      );
      const stepResult: WorkflowStepOutcome = {
        id: step.id,
        ...(step.title ? { title: step.title } : {}),
        phase: phaseSpec.phase,
        required: step.required ?? true,
        ...(step.max_total_ms != null ? { step_max_total_ms: step.max_total_ms } : {}),
        artifact_path: harness.artifact_path,
        final_state: (harness.final_state ?? (harness.exit_code === 0 ? "pass" : "fail")) as WorkflowStepOutcome["final_state"],
        goal_satisfied: harness.goal_satisfied ?? false,
        final_reason: harness.final_reason ?? "missing_harness_result",
        matched_fields: harness.matched_fields ?? [],
        missing_fields: harness.missing_fields ?? [],
        total_ms: harness.total_ms ?? 0,
        performance_total_ms: harness.performance_total_ms ?? harness.total_ms ?? 0,
        performance_basis: harness.performance_basis ?? "raw",
        rounds: harness.rounds ?? 0,
        ...(harness.benchmark ? { benchmark: harness.benchmark } : {}),
      };
      stepResults.push(stepResult);
      if (stepResult.required && !stepResult.goal_satisfied && phaseSpec.phase !== "cleanup") {
        blockLaterPhases = true;
      }
    }
  }

  const workflowSummary = summarizeWorkflow(
    stepResults.map((step) => ({
      id: step.id,
      phase: step.phase,
      required: step.required,
      final_state: step.final_state,
      goal_satisfied: step.goal_satisfied,
      final_reason: step.final_reason,
      total_ms: step.total_ms,
      performance_total_ms: step.performance_total_ms,
      performance_basis: step.performance_basis,
      step_max_total_ms: step.step_max_total_ms,
    })),
    testCase.workflow,
  );
  const caseArtifactPath = artifactPathForCase(testCase);
  writeFileSync(caseArtifactPath, JSON.stringify({
    summary: workflowSummary,
    bootstrap,
    workflow: {
      step_results: stepResults,
    },
  }, null, 2));
  return {
    id: testCase.id,
    suite_round: suiteRound,
    suite: testCase.suite ?? "default",
    site: testCase.site,
    url: testCase.url,
    intent: testCase.intent,
    popularity: testCase.popularity,
    bootstrap,
    harness: {
      artifact_path: caseArtifactPath,
      exit_code: workflowSummary.goal_satisfied ? 0 : 1,
      stdout: "",
      stderr: "",
      final_state: workflowSummary.final_state,
      goal_satisfied: workflowSummary.goal_satisfied,
      final_reason: workflowSummary.final_reason,
      matched_fields: stepResults.flatMap((step) => step.matched_fields),
      missing_fields: stepResults.flatMap((step) => step.missing_fields),
      rounds: stepResults.reduce((sum, step) => sum + step.rounds, 0),
      total_ms: workflowSummary.total_ms,
      performance_total_ms: workflowSummary.performance_total_ms,
      performance_basis: workflowNeedsBenchmark ? "warm" : "raw",
      total_errors: workflowSummary.error_count,
    },
    workflow: {
      total_ms: workflowSummary.total_ms,
      performance_total_ms: workflowSummary.performance_total_ms,
      error_count: workflowSummary.error_count,
      failed_step_ids: workflowSummary.failed_step_ids,
      exceeded_step_budget_ids: workflowSummary.exceeded_step_budget_ids,
      exceeded_total_budget: workflowSummary.exceeded_total_budget,
      step_results: stepResults,
    },
    final_state: workflowSummary.final_state,
    goal_satisfied: workflowSummary.goal_satisfied,
    final_reason: workflowSummary.final_reason,
  };
}

export async function runAuthEvalCli(): Promise<void> {
  try {
    if (args.has("--help")) usage();
    await ensureRepoServer();
    const loaded = loadAuthEvalCases(casesPath);
    const selected = filterAuthEvalCases(loaded, { suite, top }).filter((testCase) => !idFilter || testCase.id === idFilter);
    if (selected.length === 0) {
      throw new Error(`no auth cases selected from ${casesPath}`);
    }
    const results: AuthRunResult[] = [];
    writeResults(results, selected);
    const bestById = new Map<string, AuthRunResult>();
    let pending = [...selected];
    for (let suiteRound = 1; suiteRound <= suiteRounds && pending.length > 0; suiteRound++) {
      let improved = false;
      for (let i = 0; i < pending.length; i++) {
        const result = await runCase(pending[i]!, suiteRound);
        results.push(result);
        const previous = bestById.get(result.id);
        const previousScore = previous
          ? Number(previous.goal_satisfied) * 10 + Number(isTerminalEnough(previous)) * 5 + (previous.final_state === "pass" ? 3 : 0)
          : -1;
        const nextScore = Number(result.goal_satisfied) * 10 + Number(isTerminalEnough(result)) * 5 + (result.final_state === "pass" ? 3 : 0);
        if (nextScore > previousScore) {
          bestById.set(result.id, result);
          improved = true;
        }
        writeResults(results, selected);
        const rank = result.popularity?.us_rank ? ` rank=${result.popularity.us_rank}` : "";
        console.log(
          `[codex-auth] round=${suiteRound} ${i + 1}/${pending.length} ${result.id}${rank} bootstrap=${result.bootstrap.status}:${result.bootstrap.reason} final=${result.final_state} satisfied=${result.goal_satisfied}`,
        );
        if (result.harness) {
          const excerpt = compactForArtifact({
            artifact: result.harness.artifact_path,
            final_state: result.harness.final_state,
            final_reason: result.harness.final_reason,
            matched_fields: result.harness.matched_fields,
          });
          console.log(`[codex-auth] artifact ${JSON.stringify(excerpt)}`);
        }
      }
      pending = selected.filter((testCase) => {
        const best = bestById.get(testCase.id);
        return !best || !isTerminalEnough(best);
      });
      if (!improved) break;
    }
    process.exit(Object.values(bestResultPerCase(results)).some((result) => !result.goal_satisfied) ? 1 : 0);
  } finally {
    if (localServer) {
      try { await localServer.close(); } catch { /* best effort */ }
    }
    localServer = null;
  }
}

if (import.meta.main) {
  await runAuthEvalCli().catch((error) => {
    console.error("[codex-auth] fatal", error);
    process.exit(1);
  });
}
