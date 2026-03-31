/**
 * Dependency prefetch helpers for capture/rack step (Feature #120).
 *
 * During discovery, if an existing skill has an operation_graph, we can
 * prefetch related GET endpoints whose bindings are needed by already-captured
 * endpoints.  This avoids round-trips later when the agent tries to chain calls.
 */
import type { RawRequest } from "./index.js";
import type { SkillOperationGraph } from "../types/index.js";

/** Maximum number of related operations to prefetch per capture session. */
export const PREFETCH_MAX = 3;

/**
 * Return operations from `graph` that are:
 *  1. GET only (safe to prefetch without side-effects)
 *  2. Not already captured (path not in capturedRequests)
 *  3. Provide bindings consumed by a captured endpoint (according to graph edges)
 */
export function getRelatedOps(
  graph: SkillOperationGraph,
  capturedRequests: RawRequest[],
): typeof graph.operations {
  const capturedPaths = new Set(
    capturedRequests.map((r) => {
      try { return new URL(r.url).pathname; } catch { return r.url; }
    }),
  );

  return graph.operations.filter((op) => {
    if (op.method !== "GET") return false;
    try {
      if (capturedPaths.has(new URL(op.url_template).pathname)) return false;
    } catch { return false; }
    return op.provides.some((binding) =>
      graph.edges.some(
        (edge) =>
          edge.binding_key === binding.key &&
          capturedRequests.some((r) => r.url.includes(edge.to_operation_id)),
      ),
    );
  });
}
