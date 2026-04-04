/**
 * Graph-based prefetch for the resolve path.
 *
 * After resolving an endpoint, traverse parent_child edges to find related
 * GET endpoints and prefetch them so the agent gets list + detail in one call.
 */
import type { SkillManifest, SkillOperationGraph, SkillOperationNode, SkillOperationEdge } from "../types/index.js";
import { getOperationPrefetchTargets } from "../graph/index.js";
import { executeSkill } from "../execution/index.js";

export const PREFETCH_MAX = 3;
export const PREFETCH_TIMEOUT_MS = 2000;

export interface PrefetchTarget {
  operation: SkillOperationNode;
  edge: SkillOperationEdge;
  reason: string;
}

export interface PrefetchResult {
  operation_id: string;
  endpoint_id: string;
  method: string;
  action_kind: string;
  resource_kind: string;
  description_out?: string;
  data: unknown;
  success: boolean;
  duration_ms: number;
}

/**
 * Find operations worth prefetching given a resolved operation.
 * Traverses outgoing parent_child edges. Only returns GET endpoints
 * whose bindings are satisfiable.
 */
export function getPrefetchTargets(
  graph: SkillOperationGraph,
  resolvedOperationId: string,
  knownBindings: Record<string, unknown>,
): PrefetchTarget[] {
  return getOperationPrefetchTargets(graph, resolvedOperationId, knownBindings, PREFETCH_MAX);
}

/**
 * Execute prefetch targets in parallel with timeout. Failures are non-fatal.
 */
export async function executePrefetch(
  skill: SkillManifest,
  targets: PrefetchTarget[],
  baseParams: Record<string, unknown>,
): Promise<PrefetchResult[]> {
  if (targets.length === 0) return [];

  const results = await Promise.allSettled(
    targets.map(async (target): Promise<PrefetchResult> => {
      const t0 = Date.now();
      try {
        const execResult = await Promise.race([
          executeSkill(skill, { ...baseParams, endpoint_id: target.operation.endpoint_id }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("prefetch_timeout")), PREFETCH_TIMEOUT_MS)),
        ]);
        return {
          operation_id: target.operation.operation_id,
          endpoint_id: target.operation.endpoint_id,
          method: target.operation.method,
          action_kind: target.operation.action_kind,
          resource_kind: target.operation.resource_kind,
          description_out: target.operation.description_out,
          data: execResult.result,
          success: execResult.trace.success ?? false,
          duration_ms: Date.now() - t0,
        };
      } catch {
        return {
          operation_id: target.operation.operation_id,
          endpoint_id: target.operation.endpoint_id,
          method: target.operation.method,
          action_kind: target.operation.action_kind,
          resource_kind: target.operation.resource_kind,
          description_out: target.operation.description_out,
          data: null,
          success: false,
          duration_ms: Date.now() - t0,
        };
      }
    }),
  );

  return results.map(r => r.status === "fulfilled" ? r.value : {
    operation_id: "unknown", endpoint_id: "unknown", method: "GET",
    action_kind: "unknown", resource_kind: "unknown",
    data: null, success: false, duration_ms: 0,
  });
}
