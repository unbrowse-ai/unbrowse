import type {
  Env,
  RoutingSessionOutcome,
  RoutingTelemetryEvent,
  RoutingTelemetrySource,
  RoutingTelemetrySummary,
} from "../types.js";
import { statsKV } from "./kv.js";

const ROUTING_EVENT_PREFIX = "routing-event:";
const BLOCKED_KEY_PATTERN =
  /(cookie|token|auth|secret|password|session_cookie|bearer|credential|apikey|response_body|request_body|transcript|email)/i;
const EMAIL_VALUE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function clampDays(days: number | undefined, fallback = 30): number {
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(365, Math.trunc(days!)));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function containsBlockedData(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    return EMAIL_VALUE_PATTERN.test(value);
  }
  if (Array.isArray(value)) return value.some((entry) => containsBlockedData(entry));
  if (typeof value !== "object") return false;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (BLOCKED_KEY_PATTERN.test(key)) return true;
    if (containsBlockedData(inner)) return true;
  }
  return false;
}

function isRoutingEvent(value: unknown): value is RoutingTelemetryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.event_id === "string" &&
    typeof event.event_type === "string" &&
    typeof event.session_id === "string" &&
    typeof event.created_at === "string" &&
    typeof event.top_level_intent === "string" &&
    Array.isArray(event.normalized_domains) &&
    typeof event.run_type === "string"
  );
}

async function loadRoutingEvents(env: Env, days: number): Promise<RoutingTelemetryEvent[]> {
  const cutoffMs = Date.now() - clampDays(days) * 86400_000;
  const entries = await statsKV(env).listWithValues(ROUTING_EVENT_PREFIX);
  return entries
    .map((entry) => {
      try {
        return JSON.parse(entry.value) as RoutingTelemetryEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is RoutingTelemetryEvent => {
      if (!event || !isRoutingEvent(event)) return false;
      const eventMs = Date.parse(event.created_at);
      return Number.isFinite(eventMs) && eventMs >= cutoffMs;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.event_id.localeCompare(b.event_id));
}

export async function recordRoutingTelemetryBatch(
  env: Env,
  events: RoutingTelemetryEvent[],
): Promise<{ stored: number; duplicates: number }> {
  let stored = 0;
  let duplicates = 0;
  for (const event of events) {
    if (!isRoutingEvent(event)) {
      throw new Error("invalid_routing_event");
    }
    if (containsBlockedData(event)) {
      throw new Error(`blocked_routing_payload:${event.event_id}`);
    }
    const key = `${ROUTING_EVENT_PREFIX}${event.event_id}`;
    const existing = await statsKV(env).get(key);
    if (existing) {
      duplicates++;
      continue;
    }
    await statsKV(env).put(key, JSON.stringify(event));
    stored++;
  }
  return { stored, duplicates };
}

export async function getRoutingTelemetrySummary(
  env: Env,
  days = 30,
): Promise<RoutingTelemetrySummary> {
  const windowDays = clampDays(days);
  const events = await loadRoutingEvents(env, windowDays);
  const sessions = new Map<
    string,
    {
      run_type: RoutingTelemetryEvent["run_type"];
      completed_outcome?: RoutingSessionOutcome;
      total_steps: number;
      total_candidates: number;
      total_api_calls: number;
    }
  >();
  const sourceCounts = new Map<RoutingTelemetrySource, number>();
  const outcomeCounts = new Map<RoutingSessionOutcome, number>();
  const completedSessions = new Set<string>();
  let totalApiCallsFromCompletion = 0;
  let candidateEvents = 0;

  for (const event of events) {
    const session = sessions.get(event.session_id) ?? {
      run_type: event.run_type,
      total_steps: 0,
      total_candidates: 0,
      total_api_calls: 0,
    };
    if (event.event_type === "routing_candidates_ranked") {
      candidateEvents++;
      session.total_candidates += event.candidate_count;
      sourceCounts.set(event.source, (sourceCounts.get(event.source) ?? 0) + 1);
    }
    if (event.event_type === "routing_step_executed") {
      session.total_steps += 1;
      session.total_api_calls += (event.success || event.status_code != null) ? 1 : 0;
      sourceCounts.set(event.source, (sourceCounts.get(event.source) ?? 0) + 1);
    }
    if (event.event_type === "routing_session_completed") {
      session.completed_outcome = event.final_outcome;
      session.total_api_calls = event.total_api_calls;
      completedSessions.add(event.session_id);
      totalApiCallsFromCompletion += event.total_api_calls;
      outcomeCounts.set(event.final_outcome, (outcomeCounts.get(event.final_outcome) ?? 0) + 1);
    }
    sessions.set(event.session_id, session);
  }

  const sessionValues = [...sessions.values()];
  const longRunningSessions = sessionValues.filter((session) => session.run_type === "long_running").length;
  const successfulSessions = sessionValues.filter((session) => session.completed_outcome === "success").length;
  const totalSteps = sessionValues.reduce((sum, session) => sum + session.total_steps, 0);
  const totalCandidates = sessionValues.reduce((sum, session) => sum + session.total_candidates, 0);
  const totalApiCalls = completedSessions.size > 0
    ? totalApiCallsFromCompletion
    : sessionValues.reduce((sum, session) => sum + session.total_api_calls, 0);

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    events: events.length,
    sessions: sessions.size,
    long_running_sessions: longRunningSessions,
    successful_sessions: successfulSessions,
    avg_steps_per_session: sessions.size > 0 ? round(totalSteps / sessions.size) : 0,
    avg_candidates_per_step: totalSteps > 0 ? round(totalCandidates / totalSteps) : 0,
    total_api_calls: totalApiCalls,
    outcomes: [...outcomeCounts.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome)),
    sources: [...sourceCounts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
  };
}
