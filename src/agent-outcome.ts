import type { OrchestrationTiming, SkillManifest } from "./types/index.js";

export interface AgentImpact {
  source: string;
  cache_hit: boolean;
  browser_avoided: boolean;
  baseline_total_ms?: number;
  actual_total_ms?: number;
  time_saved_ms?: number;
  time_saved_pct: number;
  tokens_saved: number;
  tokens_saved_pct: number;
  baseline_cost_uc?: number;
  actual_cost_uc?: number;
  cost_saved_uc?: number;
}

export interface AgentNextAction {
  endpoint_id: string;
  operation_id: string;
  title: string;
  why: string;
  command: string;
}

const BROWSER_SOURCES = new Set(["live-capture", "first-pass", "browser-action"]);

function edgePriority(kind: string): number {
  switch (kind) {
    case "parent_child":
      return 4;
    case "pagination":
      return 3;
    case "dependency":
      return 2;
    case "hint":
      return 1;
    case "auth":
      return 0;
    default:
      return -1;
  }
}

function nextActionWhy(kind: string, bindingKey: string, title: string): string {
  switch (kind) {
    case "parent_child":
      return `Likely next detail step after this result. Exposes ${title}.`;
    case "pagination":
      return `Likely next page or continuation step. Carries ${bindingKey || "cursor"} forward.`;
    case "dependency":
      return `Unlocks the next dependent call using ${bindingKey || "known bindings"}.`;
    case "auth":
      return "Useful once authentication is in place.";
    case "hint":
      return "Common follow-up action from the current result.";
    default:
      return "Likely follow-up action.";
  }
}

function operationTitle(operation: NonNullable<SkillManifest["operation_graph"]>["operations"][number]): string {
  const semantic = [operation.action_kind, operation.resource_kind]
    .filter(Boolean)
    .join(" ")
    .replace(/_/g, " ")
    .trim();
  return operation.description_out || semantic || operation.endpoint_id;
}

export function buildAgentImpact(
  timing?: Partial<OrchestrationTiming> | null,
): AgentImpact | undefined {
  if (!timing?.source) return undefined;
  return {
    source: timing.source,
    cache_hit: timing.cache_hit === true,
    browser_avoided: !BROWSER_SOURCES.has(timing.source),
    baseline_total_ms: timing.baseline_total_ms,
    actual_total_ms: timing.actual_total_ms,
    time_saved_ms: timing.time_saved_ms,
    time_saved_pct: timing.time_saved_pct ?? 0,
    tokens_saved: timing.tokens_saved ?? 0,
    tokens_saved_pct: timing.tokens_saved_pct ?? 0,
    baseline_cost_uc: timing.baseline_cost_uc,
    actual_cost_uc: timing.actual_cost_uc,
    cost_saved_uc: timing.cost_saved_uc,
  };
}

export function buildNextActions(
  skill: SkillManifest | undefined,
  endpointId: string | undefined,
  maxActions = 3,
): AgentNextAction[] {
  if (!skill?.operation_graph || !endpointId) return [];
  const graph = skill.operation_graph;
  const current = graph.operations.find((operation) => operation.endpoint_id === endpointId);
  if (!current) return [];

  const byOperationId = new Map(graph.operations.map((operation) => [operation.operation_id, operation]));
  const scored = new Map<string, {
    operation_id: string;
    endpoint_id: string;
    title: string;
    why: string;
    score: number;
  }>();

  for (const edge of graph.edges) {
    if (edge.from_operation_id !== current.operation_id) continue;
    const target = byOperationId.get(edge.to_operation_id);
    if (!target) continue;

    const candidate = {
      operation_id: target.operation_id,
      endpoint_id: target.endpoint_id,
      title: operationTitle(target),
      why: nextActionWhy(edge.kind, edge.binding_key, operationTitle(target)),
      score: (edgePriority(edge.kind) * 10) + Math.round(edge.confidence * 10),
    };
    const existing = scored.get(target.operation_id);
    if (!existing || candidate.score > existing.score) {
      scored.set(target.operation_id, candidate);
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, maxActions)
    .map((candidate) => ({
      endpoint_id: candidate.endpoint_id,
      operation_id: candidate.operation_id,
      title: candidate.title,
      why: candidate.why,
      command: `unbrowse execute --skill ${skill.skill_id} --endpoint ${candidate.endpoint_id}`,
    }));
}

export function attachAgentOutcomeHints<T extends Record<string, unknown>>(
  payload: T,
  opts?: {
    skill?: SkillManifest;
    endpointId?: string;
    timing?: Partial<OrchestrationTiming> | null;
  },
): T & {
  impact?: AgentImpact;
  next_actions?: AgentNextAction[];
} {
  const target = payload as Record<string, unknown>;
  const impact = buildAgentImpact(opts?.timing);
  if (impact) {
    target.impact = impact;
  }

  const nextActions = buildNextActions(opts?.skill, opts?.endpointId);
  if (nextActions.length > 0) {
    target.next_actions = nextActions;
  }

  return target as T & {
    impact?: AgentImpact;
    next_actions?: AgentNextAction[];
  };
}
