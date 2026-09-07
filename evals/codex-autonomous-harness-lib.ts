import type { SkillManifest } from "../src/types/index.js";

export type AutonomousFailureClass =
  | "blocked"
  | "auth"
  | "intent"
  | "fields"
  | "dag"
  | "transport"
  | "exploration";

export type AutonomousFailure = {
  class: AutonomousFailureClass;
  terminal: boolean;
  reason: string;
};

export type DagEvaluation = {
  available: boolean;
  reachable: boolean;
  target_operation_id?: string;
  selected_path: string[];
  reason: string;
};

export type BenchmarkRunSummary = {
  label: "cold" | "warm";
  final_state: "pass" | "fail" | "skip" | "blocked";
  goal_satisfied: boolean;
  final_reason: string;
  total_rounds: number;
  total_resolve_ms: number;
  total_execute_ms: number;
  total_ms: number;
  first_source?: string;
  final_source?: string;
  total_tokens_used: number;
  total_tokens_saved: number;
  avg_tokens_saved_pct: number;
};

export type BenchmarkDelta = {
  speedup_ms: number;
  speedup_ratio?: number;
  token_delta: number;
  token_reduction_pct?: number;
};

export type RepairDecision =
  | { action: "retry_force_capture"; reason: string }
  | { action: "follow_url"; reason: string; next_url: string }
  | { action: "stop"; reason: string; terminal_state: "fail" | "skip" | "blocked" };

function flattenText(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => flattenText(item, depth + 1)).join(" ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 20)
      .map(([key, entry]) => `${key} ${flattenText(entry, depth + 1)}`)
      .join(" ");
  }
  return "";
}

function adjacencyFor(skill: SkillManifest, targetOperationId: string): string[] {
  return skill.operation_graph?.edges
    .filter((edge) => edge.from_operation_id === targetOperationId)
    .sort((lhs, rhs) => {
      const kindDelta = Number(lhs.kind === "dependency") - Number(rhs.kind === "dependency");
      if (kindDelta !== 0) return -kindDelta;
      return rhs.confidence - lhs.confidence;
    })
    .map((edge) => edge.to_operation_id) ?? [];
}

function resolveTargetOperationId(
  skill: SkillManifest,
  targetOperationId?: string,
  targetEndpointId?: string,
  candidateEndpointIds: string[] = [],
): string | undefined {
  if (targetOperationId) return targetOperationId;
  if (targetEndpointId) {
    return skill.operation_graph?.operations.find((operation) => operation.endpoint_id === targetEndpointId)?.operation_id;
  }
  for (const endpointId of candidateEndpointIds) {
    const operationId = skill.operation_graph?.operations.find((operation) => operation.endpoint_id === endpointId)?.operation_id;
    if (operationId) return operationId;
  }
  return undefined;
}

export function classifyAutonomousFailure(reason: string, excerpt?: unknown): AutonomousFailure {
  const reasonText = reason.toLowerCase();
  const excerptText = flattenText(excerpt).toLowerCase();
  const haystack = `${reasonText} ${excerptText}`;

  if (/cloudflare|cf challenge|challenge-platform|challenge-running|cf-browser-verification|just a moment|captcha|access denied|forbidden|blocked shell/.test(haystack)) {
    return { class: "blocked", terminal: true, reason: /captcha/.test(haystack) ? "captcha_blocked" : "cloudflare_blocked" };
  }
  if (/missing_.*_auth|auth_missing|missing_browser_auth|missing_required_auth_cookie|interactive_login_required|unauthorized|login required|stale credentials|re-authenticate/.test(reasonText)) {
    return { class: "auth", terminal: true, reason: "auth_missing" };
  }
  if (/wrong_entity_type|intent_mismatch/.test(haystack)) {
    return { class: "intent", terminal: false, reason: "intent_mismatch" };
  }
  if (/missing_fields:/.test(haystack)) {
    return { class: "fields", terminal: false, reason };
  }
  if (/dag_unreachable|missing_operation_graph/.test(haystack)) {
    return { class: "dag", terminal: false, reason };
  }
  if (/freeform_no_next_action|step_budget_exhausted|no_next_action/.test(haystack)) {
    return { class: "exploration", terminal: false, reason };
  }
  return { class: "transport", terminal: false, reason };
}

export function evaluateDagReadiness(args: {
  skill?: SkillManifest;
  target_operation_id?: string;
  target_endpoint_id?: string;
  candidate_endpoint_ids?: string[];
}): DagEvaluation {
  const skill = args.skill;
  if (!skill?.operation_graph?.operations?.length) {
    return {
      available: false,
      reachable: false,
      selected_path: [],
      reason: "missing_operation_graph",
    };
  }

  const targetOperationId = resolveTargetOperationId(
    skill,
    args.target_operation_id,
    args.target_endpoint_id,
    args.candidate_endpoint_ids ?? [],
  );
  if (!targetOperationId) {
    return {
      available: true,
      reachable: false,
      selected_path: [],
      reason: "missing_target_operation",
    };
  }

  const entries = skill.operation_graph.entry_operation_ids.length > 0
    ? skill.operation_graph.entry_operation_ids
    : skill.operation_graph.operations
      .filter((operation) => operation.requires.every((binding) => !binding.required))
      .map((operation) => operation.operation_id);

  const queue = entries.map((entry) => [entry]);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === targetOperationId) {
      return {
        available: true,
        reachable: true,
        target_operation_id: targetOperationId,
        selected_path: path,
        reason: "dag_path_found",
      };
    }
    for (const next of adjacencyFor(skill, current)) {
      if (!visited.has(next)) queue.push([...path, next]);
    }
  }

  return {
    available: true,
    reachable: false,
    target_operation_id: targetOperationId,
    selected_path: [],
    reason: "dag_unreachable",
  };
}

export function decideRepair(args: {
  round: number;
  max_rounds: number;
  already_force_captured: boolean;
  follow_url?: string | null;
  follow_budget_remaining: number;
  failure: AutonomousFailure;
}): RepairDecision {
  if (args.failure.class === "blocked" && args.failure.terminal) {
    return { action: "stop", reason: args.failure.reason, terminal_state: "blocked" };
  }
  if (args.failure.class === "auth" && args.failure.terminal) {
    return { action: "stop", reason: args.failure.reason, terminal_state: "skip" };
  }
  if (!args.already_force_captured && args.round + 1 < args.max_rounds) {
    return { action: "retry_force_capture", reason: "escalate_force_capture" };
  }
  if (args.follow_url && args.follow_budget_remaining > 0 && args.round + 1 < args.max_rounds) {
    return { action: "follow_url", reason: "follow_trigger_url", next_url: args.follow_url };
  }
  return { action: "stop", reason: args.failure.reason, terminal_state: "fail" };
}

export function summarizeBenchmarkRuns(
  cold: BenchmarkRunSummary,
  warm: BenchmarkRunSummary,
): BenchmarkDelta {
  const speedupMs = cold.total_ms - warm.total_ms;
  const speedupRatio =
    cold.total_ms > 0 && warm.total_ms > 0
      ? Number((cold.total_ms / warm.total_ms).toFixed(2))
      : undefined;
  const tokenDelta = cold.total_tokens_used - warm.total_tokens_used;
  const tokenReductionPct =
    cold.total_tokens_used > 0
      ? Math.round((tokenDelta / cold.total_tokens_used) * 100)
      : undefined;

  return {
    speedup_ms: speedupMs,
    ...(speedupRatio != null ? { speedup_ratio: speedupRatio } : {}),
    token_delta: tokenDelta,
    ...(tokenReductionPct != null ? { token_reduction_pct: tokenReductionPct } : {}),
  };
}
