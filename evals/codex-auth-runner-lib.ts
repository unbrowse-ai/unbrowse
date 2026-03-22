import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHarnessValidation, type HarnessCase } from "./codex-harness-lib.js";

export type AuthBootstrapStrategy =
  | "none"
  | "cookie_reuse"
  | "scripted_login"
  | "interactive_login"
  | "agentmail_register";

export type AuthBootstrapStep =
  | { action: "fill"; selector: string; value: string }
  | { action: "click"; selector: string }
  | { action: "wait_for_url"; pattern: string }
  | { action: "wait_for_selector"; selector: string }
  | { action: "sleep"; ms: number };

export type AuthBootstrapConfig = {
  strategy: AuthBootstrapStrategy;
  login_url?: string;
  success_url?: string;
  required_cookie_names?: string[];
  username?: string;
  password?: string;
  email?: string;
  name?: string;
  steps?: AuthBootstrapStep[];
  notes?: string;
};

export type AuthPopularity = {
  source: string;
  source_url?: string;
  us_rank?: number;
  global_rank?: number;
  category?: string;
  retrieved_at?: string;
};

export type AuthEvalCase = HarnessCase & {
  suite?: string;
  site?: string;
  popularity?: AuthPopularity;
  auth_bootstrap: AuthBootstrapConfig;
  workflow?: AuthWorkflowConfig;
};

export type AuthWorkflowStep = {
  id: string;
  title?: string;
  intent: string;
  url: string;
  params?: Record<string, unknown>;
  expected_fields: string[];
  validate?: HarnessCase["validate"];
  required?: boolean;
  max_total_ms?: number;
};

export type AuthWorkflowConfig = {
  steps: AuthWorkflowStep[];
  verify?: AuthWorkflowStep[];
  cleanup?: AuthWorkflowStep[];
  max_total_ms?: number;
  max_failures?: number;
};

export type WorkflowStepPhase = "step" | "verify" | "cleanup";

export type WorkflowStepTerminal = {
  id: string;
  phase: WorkflowStepPhase;
  required: boolean;
  final_state: "pass" | "fail" | "skip" | "blocked";
  goal_satisfied: boolean;
  final_reason: string;
  total_ms: number;
  performance_total_ms?: number;
  performance_basis?: "raw" | "warm";
  step_max_total_ms?: number;
};

export type WorkflowSummary = {
  final_state: "pass" | "fail";
  goal_satisfied: boolean;
  final_reason: string;
  total_ms: number;
  performance_total_ms: number;
  error_count: number;
  failed_step_ids: string[];
  exceeded_step_budget_ids: string[];
  exceeded_total_budget: boolean;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseBootstrapStep(value: unknown): AuthBootstrapStep | null {
  const record = asObject(value);
  if (!record) return null;
  const action = typeof record.action === "string" ? record.action : "";
  if (action === "fill" && typeof record.selector === "string" && typeof record.value === "string") {
    return { action, selector: record.selector, value: record.value };
  }
  if (action === "click" && typeof record.selector === "string") {
    return { action, selector: record.selector };
  }
  if (action === "wait_for_url" && typeof record.pattern === "string") {
    return { action, pattern: record.pattern };
  }
  if (action === "wait_for_selector" && typeof record.selector === "string") {
    return { action, selector: record.selector };
  }
  if (action === "sleep" && typeof record.ms === "number" && Number.isFinite(record.ms)) {
    return { action, ms: Math.max(0, Math.trunc(record.ms)) };
  }
  return null;
}

function parseBootstrap(value: unknown): AuthBootstrapConfig | null {
  const record = asObject(value);
  if (!record) return null;
  const strategy = typeof record.strategy === "string" ? record.strategy : "";
  if (!["none", "cookie_reuse", "scripted_login", "interactive_login", "agentmail_register"].includes(strategy)) {
    return null;
  }
  return {
    strategy: strategy as AuthBootstrapStrategy,
    ...(typeof record.login_url === "string" ? { login_url: record.login_url } : {}),
    ...(typeof record.success_url === "string" ? { success_url: record.success_url } : {}),
    ...(Array.isArray(record.required_cookie_names)
      ? {
          required_cookie_names: record.required_cookie_names.filter(
            (item): item is string => typeof item === "string" && item.trim().length > 0,
          ),
        }
      : {}),
    ...(typeof record.username === "string" ? { username: record.username } : {}),
    ...(typeof record.password === "string" ? { password: record.password } : {}),
    ...(typeof record.email === "string" ? { email: record.email } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(Array.isArray(record.steps)
      ? { steps: record.steps.map(parseBootstrapStep).filter((step): step is AuthBootstrapStep => !!step) }
      : {}),
    ...(typeof record.notes === "string" ? { notes: record.notes } : {}),
  };
}

function parseValidate(value: unknown): HarnessCase["validate"] | undefined {
  return parseHarnessValidation(value);
}

function parseWorkflowStep(value: unknown, index: number): AuthWorkflowStep | null {
  const record = asObject(value);
  if (!record) return null;
  const intent = typeof record.intent === "string" ? record.intent.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const expected_fields = Array.isArray(record.expected_fields)
    ? record.expected_fields.filter((field): field is string => typeof field === "string" && field.trim().length > 0)
    : [];
  if (!intent || !url || expected_fields.length === 0) return null;
  return {
    id: (typeof record.id === "string" && record.id.trim()) || `step-${index + 1}`,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    intent,
    url,
    ...(asObject(record.params) ? { params: record.params as Record<string, unknown> } : {}),
    expected_fields,
    ...(parseValidate(record.validate) ? { validate: parseValidate(record.validate) } : {}),
    ...(typeof record.required === "boolean" ? { required: record.required } : {}),
    ...(typeof record.max_total_ms === "number" && Number.isFinite(record.max_total_ms)
      ? { max_total_ms: Math.max(1, Math.trunc(record.max_total_ms)) }
      : {}),
  };
}

function parseWorkflow(value: unknown): AuthWorkflowConfig | undefined {
  const record = asObject(value);
  if (!record) return undefined;
  const steps = Array.isArray(record.steps)
    ? record.steps.map((step, index) => parseWorkflowStep(step, index)).filter((step): step is AuthWorkflowStep => !!step)
    : [];
  const verify = Array.isArray(record.verify)
    ? record.verify.map((step, index) => parseWorkflowStep(step, index)).filter((step): step is AuthWorkflowStep => !!step)
    : [];
  const cleanup = Array.isArray(record.cleanup)
    ? record.cleanup.map((step, index) => parseWorkflowStep(step, index)).filter((step): step is AuthWorkflowStep => !!step)
    : [];
  if (steps.length === 0 && verify.length === 0 && cleanup.length === 0) return undefined;
  return {
    ...(steps.length > 0 ? { steps } : { steps: [] }),
    ...(verify.length > 0 ? { verify } : {}),
    ...(cleanup.length > 0 ? { cleanup } : {}),
    ...(typeof record.max_total_ms === "number" && Number.isFinite(record.max_total_ms)
      ? { max_total_ms: Math.max(1, Math.trunc(record.max_total_ms)) }
      : {}),
    ...(typeof record.max_failures === "number" && Number.isFinite(record.max_failures)
      ? { max_failures: Math.max(0, Math.trunc(record.max_failures)) }
      : {}),
  };
}

export function parseAuthEvalCases(raw: unknown): AuthEvalCase[] {
  const entries =
    Array.isArray(raw)
      ? raw
      : asObject(raw) && Array.isArray((raw as { cases?: unknown[] }).cases)
        ? (raw as { cases: unknown[] }).cases
        : [];

  return entries.flatMap((entry, index) => {
    const record = asObject(entry);
    if (!record) return [];
    const bootstrap = parseBootstrap(record.auth_bootstrap);
    const intent = typeof record.intent === "string" ? record.intent.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!bootstrap || !intent || !url) return [];
    const expected_fields = Array.isArray(record.expected_fields)
      ? record.expected_fields.filter((field): field is string => typeof field === "string" && field.trim().length > 0)
      : [];
    if (expected_fields.length === 0) return [];
    const auth = asObject(record.auth);
    const validate = parseValidate(record.validate);
    const popularity = asObject(record.popularity);
    const workflow = parseWorkflow(record.workflow);
    return [{
      id:
        (typeof record.id === "string" && record.id.trim()) ||
        `auth-case-${index + 1}`,
      intent,
      url,
      auth: auth && typeof auth.domain === "string" ? auth.domain : undefined,
      ...(auth && typeof auth.domain === "string"
        ? {
            auth_context: {
              domain: auth.domain,
              ...(typeof auth.persona === "string" ? { persona: auth.persona } : {}),
              ...(typeof auth.role === "string" ? { role: auth.role } : {}),
              ...(typeof auth.session === "string" ? { session: auth.session } : {}),
            },
          }
        : {}),
      ...(asObject(record.params) ? { params: record.params as Record<string, unknown> } : {}),
      expected_fields,
      ...(validate ? { validate } : {}),
      ...(typeof record.site === "string" ? { site: record.site } : {}),
      ...(typeof record.suite === "string" ? { suite: record.suite } : {}),
      ...(popularity
        ? {
            popularity: {
              ...(typeof popularity.source === "string" ? { source: popularity.source } : {}),
              ...(typeof popularity.source_url === "string" ? { source_url: popularity.source_url } : {}),
              ...(typeof popularity.us_rank === "number" && Number.isFinite(popularity.us_rank)
                ? { us_rank: Math.max(1, Math.trunc(popularity.us_rank)) }
                : {}),
              ...(typeof popularity.global_rank === "number" && Number.isFinite(popularity.global_rank)
                ? { global_rank: Math.max(1, Math.trunc(popularity.global_rank)) }
                : {}),
              ...(typeof popularity.category === "string" ? { category: popularity.category } : {}),
              ...(typeof popularity.retrieved_at === "string" ? { retrieved_at: popularity.retrieved_at } : {}),
            },
          }
        : {}),
      auth_bootstrap: bootstrap,
      ...(workflow ? { workflow } : {}),
    }];
  });
}

export function loadAuthEvalCases(path: string): AuthEvalCase[] {
  return parseAuthEvalCases(JSON.parse(readFileSync(resolve(path), "utf-8")));
}

export function filterAuthEvalCases(
  cases: AuthEvalCase[],
  options?: { suite?: string; top?: number },
): AuthEvalCase[] {
  let next = cases;
  if (options?.suite && options.suite !== "all") {
    next = next.filter((testCase) => (testCase.suite ?? "default") === options.suite);
  }
  next = [...next].sort((lhs, rhs) => {
    const leftRank = lhs.popularity?.us_rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rhs.popularity?.us_rank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return lhs.id.localeCompare(rhs.id);
  });
  if (options?.top && options.top > 0) {
    next = next.slice(0, options.top);
  }
  return next;
}

export function toHarnessCase(testCase: AuthEvalCase): HarnessCase {
  return {
    id: testCase.id,
    intent: testCase.intent,
    url: testCase.url,
    ...(testCase.auth ? { auth: testCase.auth } : {}),
    ...(testCase.auth_context ? { auth_context: testCase.auth_context } : {}),
    ...(testCase.params ? { params: testCase.params } : {}),
    expected_fields: testCase.expected_fields,
    ...(testCase.validate ? { validate: testCase.validate } : {}),
  };
}

export function workflowStepToHarnessCase(testCase: AuthEvalCase, step: AuthWorkflowStep): HarnessCase {
  return {
    id: `${testCase.id}:${step.id}`,
    intent: step.intent,
    url: step.url,
    ...(testCase.auth ? { auth: testCase.auth } : {}),
    ...(testCase.auth_context ? { auth_context: testCase.auth_context } : {}),
    ...(step.params ? { params: step.params } : {}),
    expected_fields: step.expected_fields,
    ...(step.validate ? { validate: step.validate } : {}),
  };
}

export function summarizeWorkflow(
  steps: WorkflowStepTerminal[],
  workflow?: AuthWorkflowConfig,
): WorkflowSummary {
  const totalMs = steps.reduce((sum, step) => sum + step.total_ms, 0);
  const performanceTotalMs = steps.reduce((sum, step) => sum + (step.performance_total_ms ?? step.total_ms), 0);
  const failedSteps = steps.filter((step) => step.required && !step.goal_satisfied);
  const exceededStepBudgetIds = steps
    .filter((step) => step.step_max_total_ms != null && (step.performance_total_ms ?? step.total_ms) > step.step_max_total_ms)
    .map((step) => step.id);
  const exceededTotalBudget = workflow?.max_total_ms != null ? performanceTotalMs > workflow.max_total_ms : false;
  const errorCount = steps.filter((step) => step.final_state !== "pass").length +
    exceededStepBudgetIds.length +
    Number(exceededTotalBudget);
  const maxFailures = workflow?.max_failures ?? 0;
  const goalSatisfied =
    failedSteps.length === 0 &&
    exceededStepBudgetIds.length === 0 &&
    !exceededTotalBudget &&
    errorCount <= maxFailures;

  let finalReason = "workflow_pass";
  if (failedSteps[0]) finalReason = `${failedSteps[0].phase}:${failedSteps[0].id}:${failedSteps[0].final_reason}`;
  else if (exceededStepBudgetIds[0]) finalReason = `step_budget_exceeded:${exceededStepBudgetIds[0]}`;
  else if (exceededTotalBudget) finalReason = `workflow_budget_exceeded:${performanceTotalMs}/${workflow?.max_total_ms}`;
  else if (errorCount > maxFailures) finalReason = `workflow_errors:${errorCount}/${maxFailures}`;

  return {
    final_state: goalSatisfied ? "pass" : "fail",
    goal_satisfied: goalSatisfied,
    final_reason: finalReason,
    total_ms: totalMs,
    performance_total_ms: performanceTotalMs,
    error_count: errorCount,
    failed_step_ids: failedSteps.map((step) => step.id),
    exceeded_step_budget_ids: exceededStepBudgetIds,
    exceeded_total_budget: exceededTotalBudget,
  };
}

export function corpusSummary(cases: AuthEvalCase[]): {
  total: number;
  suites: Record<string, number>;
  strategies: Record<string, number>;
} {
  const suites: Record<string, number> = {};
  const strategies: Record<string, number> = {};
  for (const testCase of cases) {
    suites[testCase.suite ?? "default"] = (suites[testCase.suite ?? "default"] ?? 0) + 1;
    strategies[testCase.auth_bootstrap.strategy] = (strategies[testCase.auth_bootstrap.strategy] ?? 0) + 1;
  }
  return { total: cases.length, suites, strategies };
}
