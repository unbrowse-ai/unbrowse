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
import { recordSession, recordNegative, syncEdgeConfidence, type EdgeOutcomeSignal } from "../client/graph-client.js";
import { buildSkillOperationGraph } from "../graph/index.js";
import type { OperationBinding, SkillManifest, SkillOperationEdge, SkillOperationNode } from "../types/index.js";
import { DEFAULT_BACKEND_URL } from "../version.js";

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

// E1 fix — feedback-driven reliability decay. Endpoints that fail repeatedly
// must drift below MIN_PUBLISH_RELIABILITY (0.2) so the existing
// `low_reliability` admission gate buries them. Without this, a skill
// captured once with `reliability_score: 0.9` keeps that score forever even
// if every subsequent execute fails. Verification runs offline; this is the
// online signal.
const ENDPOINT_RELIABILITY_BOOST = 0.05;
const ENDPOINT_RELIABILITY_PENALTY = 0.10;
const ENDPOINT_RELIABILITY_MIN = 0;
const ENDPOINT_RELIABILITY_MAX = 1;

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

/**
 * Report sanitized edge outcomes to the server-authoritative confidence
 * store (the DAG moat). The cross-user online learning lives server-side;
 * this only sends which graph edges a real execution traversed and whether
 * it worked. No payloads, no auth context, no secrets.
 *
 * Fire-and-forget: a throw means the backend is unreachable, in which case
 * the local cache write (degraded, no learning) is the fallback. Never
 * blocks or breaks an execution.
 *
 * `weight` lets a judge-rejected result count as a stronger negative than a
 * plain failure (mirrors the old local 2x-penalty intent) WITHOUT shipping
 * the learning math to the client.
 */
function reportEdgeOutcomeToServer(
  skill: SkillManifest,
  operationId: string,
  succeeded: boolean,
  weight = 1,
): void {
  if (!skill.domain || !skill.operation_graph) return;
  const outcomes: EdgeOutcomeSignal[] = skill.operation_graph.edges
    .filter(
      (edge) => edge.to_operation_id === operationId || edge.from_operation_id === operationId,
    )
    .map((edge) => ({ edge_id: edge.edge_id, succeeded, weight }));
  if (outcomes.length === 0) return;
  syncEdgeConfidence(skill.domain, outcomes).catch(() => {
    /* backend unreachable; local cache fallback already applied */
  });
}

// ---------------------------------------------------------------------------
// Binding freshness — Layer B (pure, deterministic, no clock, no I/O)
// ---------------------------------------------------------------------------
// See `.claude/jesus-loop.default.architecture.md` and AC4 of the plan.
// All four exports below are pure functions used by Layer C (capture
// population) and Layer D (execute refetch chain walker). They take an
// explicit `now: number` instead of reading the clock so the chain walker
// can freeze time at walk entry and so tests can pass synthetic values.

/**
 * Returns true when the binding's cached value should be considered
 * stale and refetched before reuse. Pure: no clock, no I/O — caller
 * supplies `now`.
 *
 * Stale when EITHER:
 *  - `single_use === true && usage?.consumed === true`, OR
 *  - `ttl_ms !== undefined && observed_at !== undefined &&
 *     Date.parse(observed_at) + ttl_ms < now`.
 *
 * Otherwise fresh. Missing freshness metadata = fresh forever
 * (preserves pre-feature behaviour).
 *
 * Unparseable `observed_at` is treated as fresh (no throw). The capture
 * layer is responsible for emitting valid ISO timestamps; surfacing the
 * gap as "stale" here would cause spurious refetches on bindings whose
 * producer endpoint is no longer reachable.
 */
export function isBindingStale(
  binding: OperationBinding,
  now: number,
  usage?: { consumed?: boolean },
): boolean {
  // Single-use consumed → stale regardless of ttl.
  if (binding.single_use === true && usage?.consumed === true) return true;

  // TTL-based staleness requires both `ttl_ms` AND `observed_at`.
  if (typeof binding.ttl_ms === "number" && typeof binding.observed_at === "string") {
    const observedMs = Date.parse(binding.observed_at);
    if (!Number.isNaN(observedMs)) {
      // Strictly less-than per spec — boundary equality is fresh.
      if (observedMs + binding.ttl_ms < now) return true;
    }
  }

  return false;
}

/**
 * Parse `Set-Cookie`-style header value for Max-Age=N or Expires=...
 * and return ttl in ms, or undefined when neither is present or both
 * are unparseable. Treat `Max-Age=0` as expired (ttl_ms=0). When BOTH
 * are present, Max-Age wins per RFC 6265.
 *
 * @param now epoch ms — used only to convert Expires into a relative
 *   ttl; never read from Date.now() inside the function.
 */
export function parseMaxAge(setCookieValue: string, now: number): number | undefined {
  if (typeof setCookieValue !== "string" || setCookieValue.length === 0) return undefined;

  // RFC 6265: attributes are case-insensitive; ; separated. We don't need a
  // full cookie parser — just scan for the two attributes.
  const maxAgeMatch = setCookieValue.match(/(?:^|;)\s*max-age\s*=\s*(-?\d+)\s*(?:;|$)/i);
  if (maxAgeMatch) {
    const seconds = Number(maxAgeMatch[1]);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    // Matched the attribute but value wasn't a number — fall through to Expires.
  } else {
    // Detect `Max-Age=NaN`-style values (non-numeric). If the attribute is
    // present but unparseable as an integer, treat the whole header as
    // unparseable rather than silently falling back to Expires — the spec
    // test "Max-Age=NaN returns undefined" demands this.
    const malformedMaxAge = setCookieValue.match(/(?:^|;)\s*max-age\s*=\s*([^;]*)/i);
    if (malformedMaxAge) {
      const raw = (malformedMaxAge[1] ?? "").trim();
      if (raw.length > 0 && !/^-?\d+$/.test(raw)) {
        return undefined;
      }
    }
  }

  const expiresMatch = setCookieValue.match(/(?:^|;)\s*expires\s*=\s*([^;]+)/i);
  if (expiresMatch) {
    const expiresMs = Date.parse((expiresMatch[1] ?? "").trim());
    if (!Number.isNaN(expiresMs)) {
      return Math.max(0, expiresMs - now);
    }
  }

  return undefined;
}

/**
 * Parse OAuth-style `expires_in` field from a response body shape
 * (looks for top-level `expires_in: number` in seconds). Returns ms.
 * Returns undefined when not present, not a number, or negative.
 *
 * Note: spec accepts `0` as a valid value (returns 0). The gate is
 * "non-negative finite number", not "positive".
 */
export function parseExpiresIn(body: unknown): number | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).expires_in;
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return value * 1000;
}

/**
 * Heuristic: does the binding key NAME suggest a csrf-shaped token
 * that should default to ttl_ms = 600_000 (10 min) when no observed
 * signal exists? Matches /csrf|xsrf/i OR (/token/i AND NOT
 * /auth|access|refresh/i). Conservative — only the name shape, never
 * the domain.
 */
export function isCsrfShapedKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  if (/csrf|xsrf/i.test(key)) return true;
  if (/token/i.test(key) && !/auth|access|refresh/i.test(key)) return true;
  return false;
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
      // E1 fix: decay/boost endpoint reliability so stale endpoints drift
      // below MIN_PUBLISH_RELIABILITY and stop being admitted by the
      // marketplace publish gate.
      endpoints: skill.endpoints.map((endpoint) => {
        if (endpoint.endpoint_id !== endpointId) return endpoint;
        const cur = typeof endpoint.reliability_score === "number" ? endpoint.reliability_score : 0.5;
        const nextScore = succeeded
          ? clamp(cur + ENDPOINT_RELIABILITY_BOOST, ENDPOINT_RELIABILITY_MIN, ENDPOINT_RELIABILITY_MAX)
          : clamp(cur - ENDPOINT_RELIABILITY_PENALTY, ENDPOINT_RELIABILITY_MIN, ENDPOINT_RELIABILITY_MAX);
        return {
          ...endpoint,
          reliability_score: nextScore,
          ...(succeeded
            ? { last_succeeded_at: new Date().toISOString() }
            : { last_failed_at: new Date().toISOString() }),
        };
      }),
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

  // Server-authoritative: report the sanitized edge outcome UP so the
  // cross-user confidence is learned server-side. The local cache write
  // above is the degraded fallback used only when the backend is
  // unreachable; the server projection overlays it at resolve.
  reportEdgeOutcomeToServer(skill, opId, succeeded);
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

  // Server-authoritative: an explicit negative is a stronger signal than a
  // plain failure: report it UP with weight 2 (mirrors the old local
  // `PENALTY_STEP * 2` intent) without shipping the learning math here.
  reportEdgeOutcomeToServer(skill, opId, false, 2);
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
  const backendUrl = process.env.UNBROWSE_BACKEND_URL || DEFAULT_BACKEND_URL;

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
