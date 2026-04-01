/**
 * DAG learning loop (Issue #102).
 *
 * Fire-and-forget helpers that reinforce or penalise operation-graph edges
 * based on observed auto-exec outcomes. All writes are debounced per skill to
 * avoid flooding the local skill cache.
 *
 * Session actions and negatives are also forwarded to the backend graph API
 * (fire-and-forget, never blocking) so cross-session intelligence can be
 * aggregated.
 */

import { nanoid } from "nanoid";
import { cachePublishedSkill, getApiKey } from "../client/index.js";
import { recordSession, recordNegative } from "../client/graph-client.js";
import { buildSkillOperationGraph } from "../graph/index.js";
import type { SkillManifest, SkillOperationEdge, SkillOperationNode } from "../types/index.js";

/** Stable session ID — one per process lifetime. */
const SESSION_ID = nanoid();

/** Expose session ID for test verification only. */
export function _getSessionIdForTesting(): string {
  return SESSION_ID;
}

// ---------------------------------------------------------------------------
// Rate-limit / debounce state
// ---------------------------------------------------------------------------

/** Minimum ms between graph writes for the same skill. */
export let DAG_WRITE_DEBOUNCE_MS = 5_000;

/** Maximum number of pending timers at once (global back-pressure). */
export const MAX_PENDING_WRITES = 50;

const lastWriteAt = new Map<string, number>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();


/** For tests only: reset all debounce/rate-limit state and optionally override the delay. */
export function _resetForTesting(debounceMs = 5_000): void {
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
  lastWriteAt.clear();
  DAG_WRITE_DEBOUNCE_MS = debounceMs;
}
/** Retrieve the API key for backend edge publishing. Reuses graph-client auth. */
function _getApiKeyForPublish(): string {
  try {
    return getApiKey();
  } catch {
    return "";
  }
}


function scheduleWrite(skillId: string, fn: () => void): void {
  if (pendingTimers.size >= MAX_PENDING_WRITES) return; // back-pressure: drop silently

  const existing = pendingTimers.get(skillId);
  if (existing) clearTimeout(existing);

  const last = lastWriteAt.get(skillId) ?? 0;
  const now = Date.now();
  const delay = Math.max(0, DAG_WRITE_DEBOUNCE_MS - (now - last));

  const timer = setTimeout(() => {
    pendingTimers.delete(skillId);
    lastWriteAt.set(skillId, Date.now());
    try {
      fn();
    } catch {
      /* non-critical — best effort */
    }
  }, delay);

  pendingTimers.set(skillId, timer);
}

// ---------------------------------------------------------------------------
// Confidence adjustment helpers
// ---------------------------------------------------------------------------

const BOOST_STEP = 0.05;
const PENALTY_STEP = 0.08;
const CONFIDENCE_MIN = 0.1;
const CONFIDENCE_MAX = 1.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function adjustEdgeConfidences(
  edges: SkillOperationEdge[],
  operationId: string,
  delta: number,
): SkillOperationEdge[] {
  return edges.map((edge) => {
    if (edge.to_operation_id === operationId || edge.from_operation_id === operationId) {
      return {
        ...edge,
        confidence: clamp(edge.confidence + delta, CONFIDENCE_MIN, CONFIDENCE_MAX),
      };
    }
    return edge;
  });
}

function operationIdForEndpoint(skill: SkillManifest, endpointId: string): string | undefined {
  return skill.operation_graph?.operations.find((op) => op.endpoint_id === endpointId)
    ?.operation_id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a successful or failed execution attempt for a given endpoint.
 * Adjusts edge confidences attached to the endpoint's operation node and
 * persists the updated graph to the local skill cache (debounced).
 */
export function recordDagSessionAction(
  skill: SkillManifest,
  endpointId: string,
  succeeded: boolean,
): void {
  if (!skill.operation_graph) return;

  const opId = operationIdForEndpoint(skill, endpointId);
  if (!opId) return;

  const delta = succeeded ? BOOST_STEP : -PENALTY_STEP;

  scheduleWrite(skill.skill_id, () => {
    const updated: SkillManifest = {
      ...skill,
      operation_graph: {
        ...skill.operation_graph!,
        edges: adjustEdgeConfidences(skill.operation_graph!.edges, opId, delta),
        generated_at: new Date().toISOString(),
      },
    };
    cachePublishedSkill(updated);
  });

  // Fire-and-forget to backend — never block, never throw
  if (skill.domain) {
    recordSession(
      skill.domain,
      SESSION_ID,
      endpointId,
      skill.intent_signature ?? "",
      succeeded ? "success" : "failure",
    ).catch(() => {});
  }
}

/**
 * Record an explicit negative signal for an endpoint (e.g. judge rejected the
 * result). Applies a larger confidence penalty than a plain failure.
 */
export function recordDagNegative(skill: SkillManifest, endpointId: string): void {
  if (!skill.operation_graph) return;

  const opId = operationIdForEndpoint(skill, endpointId);
  if (!opId) return;

  scheduleWrite(skill.skill_id, () => {
    const updated: SkillManifest = {
      ...skill,
      operation_graph: {
        ...skill.operation_graph!,
        edges: adjustEdgeConfidences(skill.operation_graph!.edges, opId, -(PENALTY_STEP * 2)),
        generated_at: new Date().toISOString(),
      },
    };
    cachePublishedSkill(updated);
  });

  // Fire-and-forget to backend — never block, never throw
  if (skill.domain) {
    recordNegative(
      skill.domain,
      skill.intent_signature ?? "",
      endpointId,
    ).catch(() => {});
  }
}

/**
 * Rebuild the operation graph from the skill's current endpoints and persist
 * it to the local cache. Call this after live-capture adds or updates endpoints
 * so that future chunk queries reflect the latest topology.
 */
export function upsertDagEdgesFromOperationGraph(skill: SkillManifest): void {
  scheduleWrite(skill.skill_id, () => {
    const freshGraph = buildSkillOperationGraph(skill.endpoints);
    // Preserve learned edge confidences if the edge already exists.
    const existing = skill.operation_graph;
    const mergedEdges = freshGraph.edges.map((edge) => {
      const prior = existing?.edges.find((e) => e.edge_id === edge.edge_id);
      return prior ? { ...edge, confidence: prior.confidence } : edge;
    });
    const updated: SkillManifest = {
      ...skill,
      operation_graph: {
        ...freshGraph,
        edges: mergedEdges,
      },
    };
    cachePublishedSkill(updated);

    // Fire-and-forget: publish edges to the backend for each operation node
    publishEdgesToBackend(skill.domain, freshGraph);
  });
}

/**
 * Fire-and-forget: POST each operation node's edges to the backend API.
 * Failures are silently ignored — this must never block skill publish.
 */
export function publishEdgesToBackend(
  domain: string,
  graph: { operations: SkillOperationNode[]; edges: SkillOperationEdge[] },
): void {
  const backendUrl = process.env.UNBROWSE_BACKEND_URL || "https://beta-api.unbrowse.ai";

  const apiKey = _getApiKeyForPublish();

  for (const op of graph.operations) {
    const node = {
      endpoint_id: op.endpoint_id,
      requires: op.requires.map((b) => b.key),
      provides: op.provides.map((b) => b.key),
      action_kind: op.action_kind,
      resource_kind: op.resource_kind,
    };

    const edges = graph.edges
      .filter((e) => e.from_operation_id === op.operation_id)
      .map((e) => ({ to: e.to_operation_id, binding: e.binding_key }));

    fetch(`${backendUrl}/v1/graph/edges`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ domain, node, edges }),
    }).catch(() => {
      /* fire-and-forget — never block skill publish */
    });
  }
}
