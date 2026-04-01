/**
 * DAG execution planner — advisory only.
 *
 * Provides topological ordering, prerequisite analysis, and session-level
 * feedback tracking for the operation graph.  Nothing here auto-executes;
 * callers use the plan to boost/penalize ranked endpoints and to suggest
 * next steps to the agent.
 */

import type {
  SkillManifest,
  SkillOperationGraph,
  SkillOperationNode,
  SkillOperationEdge,
} from "../types/index.js";
import { ensureSkillOperationGraph } from "./index.js";
import { deriveAuthDependencies } from "../auth/runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionStep {
  operation_id: string;
  endpoint_id: string;
  method: string;
  produces_bindings: string[];
  requires_confirmation: boolean;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  /** True when all prerequisite bindings for the target are already known. */
  chain_ready: boolean;
  /** Operations that were unreachable and therefore excluded. */
  unreachable: string[];
}

export interface DagAdvisoryPlan {
  /** All prerequisite bindings are satisfied by known bindings. */
  chain_ready: boolean;
  /** Operations that become runnable after the target completes. */
  predicted_next: string[];
  /** Ordered prerequisite operations leading to the target. */
  prerequisite_order: string[];
  /** Operations in the graph that are not needed for the target. */
  skippable: string[];
  /** Auth dependencies detected from endpoint semantics. */
  auth_dependencies: import("../auth/runtime.js").AuthDependency[];
}

// ---------------------------------------------------------------------------
// Mutable-method detection
// ---------------------------------------------------------------------------

const MUTABLE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function isMutable(method: string): boolean {
  return MUTABLE_METHODS.has(method.toUpperCase());
}

// ---------------------------------------------------------------------------
// 1. buildExecutionPlan
// ---------------------------------------------------------------------------

/**
 * Topological sort from entry points to `targetOperationId`, producing
 * ordered steps.  Each step carries the bindings it will produce that
 * downstream steps need.  Unreachable nodes are excluded.  Mutable
 * operations (POST/PUT/DELETE/PATCH) are flagged `requires_confirmation`.
 */
export function buildExecutionPlan(
  graph: SkillOperationGraph,
  targetOperationId: string,
  knownBindings: Set<string>,
): ExecutionPlan {
  const opMap = new Map<string, SkillOperationNode>();
  for (const op of graph.operations) {
    opMap.set(op.operation_id, op);
  }

  // Build adjacency lists from the edge list.
  // predecessors: operation_id -> set of operation_ids that must run first
  const predecessors = new Map<string, Set<string>>();
  for (const op of graph.operations) {
    predecessors.set(op.operation_id, new Set());
  }
  for (const edge of graph.edges) {
    if (edge.kind !== "dependency" && edge.kind !== "parent_child" && edge.kind !== "auth") continue;
    const deps = predecessors.get(edge.to_operation_id);
    if (deps) deps.add(edge.from_operation_id);
  }

  // Walk backwards from target to find all ancestors (required ops).
  const needed = new Set<string>();
  const queue: string[] = [targetOperationId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (needed.has(current)) continue;
    needed.add(current);
    const deps = predecessors.get(current);
    if (deps) {
      for (const dep of deps) {
        queue.push(dep);
      }
    }
  }

  // Filter to only check if we can skip a needed node because its
  // required bindings are already known.
  const satisfied = new Set<string>(knownBindings);

  // Kahn's algorithm over the needed subgraph.
  const inDegree = new Map<string, number>();
  for (const id of needed) {
    inDegree.set(id, 0);
  }
  for (const edge of graph.edges) {
    if (edge.kind !== "dependency" && edge.kind !== "parent_child" && edge.kind !== "auth") continue;
    if (!needed.has(edge.from_operation_id) || !needed.has(edge.to_operation_id)) continue;
    inDegree.set(edge.to_operation_id, (inDegree.get(edge.to_operation_id) ?? 0) + 1);
  }

  const ready: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) ready.push(id);
  }

  const steps: ExecutionStep[] = [];
  const visited = new Set<string>();

  while (ready.length > 0) {
    // Sort for determinism: prefer lower operation_id.
    ready.sort();
    const current = ready.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const op = opMap.get(current);
    if (!op) continue;

    const producesBindings = op.provides.map((b) => b.key);
    steps.push({
      operation_id: op.operation_id,
      endpoint_id: op.endpoint_id,
      method: op.method,
      produces_bindings: producesBindings,
      requires_confirmation: isMutable(op.method),
    });

    // Mark produced bindings as satisfied.
    for (const key of producesBindings) {
      satisfied.add(key);
    }

    // Decrement in-degree for successors.
    for (const edge of graph.edges) {
      if (edge.kind !== "dependency" && edge.kind !== "parent_child" && edge.kind !== "auth") continue;
      if (edge.from_operation_id !== current) continue;
      if (!needed.has(edge.to_operation_id)) continue;
      const deg = (inDegree.get(edge.to_operation_id) ?? 1) - 1;
      inDegree.set(edge.to_operation_id, deg);
      if (deg === 0) ready.push(edge.to_operation_id);
    }
  }

  // Determine chain_ready: check whether the target's required bindings are
  // all either in the original known set or produced by steps before it.
  const targetOp = opMap.get(targetOperationId);
  const chainReady = targetOp
    ? targetOp.requires.every(
        (b) => !b.required || satisfied.has(b.key) || knownBindings.has(b.key),
      )
    : false;

  // Unreachable = operations in the graph that are not in the needed set.
  const unreachable = graph.operations
    .filter((op) => !needed.has(op.operation_id))
    .map((op) => op.operation_id);

  return { steps, chain_ready: chainReady, unreachable };
}

// ---------------------------------------------------------------------------
// 2. fetchDagAdvisoryPlan
// ---------------------------------------------------------------------------

/**
 * Uses the local graph to build an advisory execution plan.
 *
 * @param skill      The skill manifest (used to build/get the graph).
 * @param targetEndpointId  The endpoint we want to execute.
 * @param knownBindingKeys  Binding keys already available from context/params.
 */
export function fetchDagAdvisoryPlan(
  skill: SkillManifest,
  targetEndpointId: string,
  knownBindingKeys: string[],
): DagAdvisoryPlan {
  const graph = ensureSkillOperationGraph(skill);
  const knownSet = new Set(knownBindingKeys);

  // Derive auth dependencies from the target endpoint's semantics.
  const authDeps = deriveAuthDependencies(skill, targetEndpointId);

  // Find the target operation by endpoint_id.
  const targetOp = graph.operations.find(
    (op) => op.endpoint_id === targetEndpointId,
  );
  if (!targetOp) {
    return {
      chain_ready: true,
      predicted_next: [],
      prerequisite_order: [],
      skippable: [],
      auth_dependencies: authDeps,
    };
  }

  const plan = buildExecutionPlan(graph, targetOp.operation_id, knownSet);

  // prerequisite_order: steps before the target (excluding target itself).
  const prerequisiteOrder = plan.steps
    .filter((s) => s.operation_id !== targetOp.operation_id)
    .map((s) => s.endpoint_id);

  // predicted_next: operations that list the target's provides as a
  // required binding and are not in the plan themselves.
  const planOpIds = new Set(plan.steps.map((s) => s.operation_id));
  const targetProvides = new Set(targetOp.provides.map((b) => b.key));
  const predictedNext: string[] = [];
  for (const op of graph.operations) {
    if (planOpIds.has(op.operation_id)) continue;
    const needsTargetOutput = op.requires.some(
      (b) => b.required && targetProvides.has(b.key),
    );
    if (needsTargetOutput) predictedNext.push(op.endpoint_id);
  }

  // skippable: unreachable operations (not needed for this target).
  const skippable = plan.unreachable.map((opId) => {
    const op = graph.operations.find((o) => o.operation_id === opId);
    return op?.endpoint_id ?? opId;
  });

  return {
    chain_ready: plan.chain_ready,
    predicted_next: predictedNext,
    prerequisite_order: prerequisiteOrder,
    skippable,
    auth_dependencies: authDeps,
  };
}

// ---------------------------------------------------------------------------
// 3. applyDagAdvisoryBoosts
// ---------------------------------------------------------------------------

/**
 * Boost/penalize ranked endpoints based on the DAG advisory plan.
 *
 * - Endpoints on the critical path (`prerequisite_order`) get a boost.
 * - Endpoints in `skippable` get a penalty.
 * - Endpoints in `predicted_next` get a small boost (good follow-ups).
 *
 * Returns a new array, sorted by adjusted score descending.
 */
export function applyDagAdvisoryBoosts<
  T extends { endpoint_id: string; score: number },
>(
  ranked: T[],
  dagPlan: DagAdvisoryPlan,
): T[] {
  const prerequisiteSet = new Set(dagPlan.prerequisite_order);
  const skippableSet = new Set(dagPlan.skippable);
  const predictedNextSet = new Set(dagPlan.predicted_next);

  // Check session negatives: don't boost endpoints that have failed.
  const negativeEndpoints = new Set<string>();
  for (const [, negatives] of sessionNegatives) {
    for (const epId of negatives) {
      negativeEndpoints.add(epId);
    }
  }

  const boosted = ranked.map((item) => {
    let adjustment = 0;

    // Don't boost endpoints that have failed in this session.
    if (negativeEndpoints.has(item.endpoint_id)) {
      return { ...item, score: item.score - 0.1 };
    }

    if (prerequisiteSet.has(item.endpoint_id)) {
      adjustment += 0.15; // Critical path boost
    }
    if (predictedNextSet.has(item.endpoint_id)) {
      adjustment += 0.05; // Follow-up boost
    }
    if (skippableSet.has(item.endpoint_id)) {
      adjustment -= 0.1; // Not needed penalty
    }

    return { ...item, score: item.score + adjustment };
  });

  return boosted.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// 4. recordDagNegative
// ---------------------------------------------------------------------------

/** Session-level store of failed endpoints, keyed by skill_id. */
const sessionNegatives = new Map<string, Set<string>>();

/**
 * Record that this endpoint failed for this session.  Prevents the planner
 * from re-boosting it in `applyDagAdvisoryBoosts`.
 */
export function recordDagNegative(
  skill: { skill_id: string },
  endpointId: string,
): void {
  const existing = sessionNegatives.get(skill.skill_id);
  if (existing) {
    existing.add(endpointId);
  } else {
    sessionNegatives.set(skill.skill_id, new Set([endpointId]));
  }
}

/**
 * Check whether an endpoint has been recorded as failed for a skill.
 * Exposed for testing.
 */
export function isDagNegative(
  skill: { skill_id: string },
  endpointId: string,
): boolean {
  return sessionNegatives.get(skill.skill_id)?.has(endpointId) ?? false;
}

/**
 * Clear all session negatives.  Exposed for testing.
 */
export function clearDagSessionState(): void {
  sessionNegatives.clear();
  sessionTraces.clear();
}

// ---------------------------------------------------------------------------
// 5. recordDagSessionAction
// ---------------------------------------------------------------------------

/** Session-level store of execution traces, keyed by skill_id. */
const sessionTraces = new Map<
  string,
  Array<{ endpoint_id: string; success: boolean; timestamp: number }>
>();

/**
 * Record that this endpoint was executed in this session.  Accumulates an
 * ordered trace of operations per skill.
 */
export function recordDagSessionAction(
  skill: { skill_id: string },
  endpointId: string,
  success: boolean,
): void {
  const existing = sessionTraces.get(skill.skill_id);
  const entry = { endpoint_id: endpointId, success, timestamp: Date.now() };
  if (existing) {
    existing.push(entry);
  } else {
    sessionTraces.set(skill.skill_id, [entry]);
  }
}

/**
 * Retrieve the session trace for a skill.  Exposed for testing.
 */
export function getDagSessionTrace(
  skill: { skill_id: string },
): Array<{ endpoint_id: string; success: boolean; timestamp: number }> {
  return sessionTraces.get(skill.skill_id) ?? [];
}

// ---------------------------------------------------------------------------
// 6. upsertDagEdgesFromOperationGraph
// ---------------------------------------------------------------------------

/**
 * Merge new edges from a freshly-built graph into the skill manifest's
 * persisted operation_graph. If the skill has no graph yet, assign the
 * provided one directly. Existing edges are preserved (dedup by edge_id),
 * and the generated_at timestamp is updated.
 */
export function upsertDagEdgesFromOperationGraph(
  skill: SkillManifest,
  graph: SkillOperationGraph,
): void {
  if (!skill.operation_graph) { skill.operation_graph = graph; return; }
  const existingEdgeIds = new Set(skill.operation_graph.edges.map(e => e.edge_id));
  for (const edge of graph.edges) {
    if (!existingEdgeIds.has(edge.edge_id)) {
      skill.operation_graph.edges.push(edge);
    }
  }
  skill.operation_graph.generated_at = graph.generated_at;
}
