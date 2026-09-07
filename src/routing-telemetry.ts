import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type {
  ExecutionOptions,
  ProjectionOptions,
  RoutingCandidateEvent,
  RoutingCandidateSnapshot,
  RoutingContextBuckets,
  RoutingSessionCompletedEvent,
  RoutingSessionEvent,
  RoutingSessionOutcome,
  RoutingStepEvent,
  RoutingTelemetryEvent,
  RoutingTelemetrySource,
  RoutingRunType,
  SkillManifest,
} from "./types/index.js";
import { anonymizeUrl, classifyFailure, hashResponseBody, hashValue } from "./telemetry.js";

const BLOCKED_KEY_PATTERN =
  /(cookie|token|auth|secret|password|session|bearer|credential|apikey|response_body|request_body|transcript|email)/i;

type StateBindings = Record<string, unknown>;

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function sanitizeScalar(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === "string") return hashValue(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return stableHash(value);
}

function sanitizeObject(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (BLOCKED_KEY_PATTERN.test(key)) continue;
    out[key] = sanitizeScalar(value);
  }
  return out;
}

export function hashRoutingState(bindings: StateBindings = {}): string {
  const safeEntries = Object.entries(bindings)
    .filter(([key]) => !BLOCKED_KEY_PATTERN.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, sanitizeScalar(value)]);
  return stableHash(safeEntries);
}

export function hashSchemaFingerprint(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  return stableHash(schema);
}

export function buildRoutingContextBuckets(
  intent: string,
  projection?: ProjectionOptions,
  options?: ExecutionOptions,
  hasPriorHistory = false,
): RoutingContextBuckets {
  const lower = intent.toLowerCase();
  const role = /\b(code|repo|pull request|issue|commit|package)\b/.test(lower)
    ? "developer"
    : /\b(research|paper|literature|study)\b/.test(lower)
      ? "researcher"
      : /\b(price|stock|trade|portfolio|market)\b/.test(lower)
        ? "analyst"
        : "general";
  const outputPreference = projection?.raw
    ? "raw"
    : projection?.fields?.length
      ? "structured"
      : "mixed";
  return {
    role,
    cost_sensitivity: options?.force_capture ? "low" : "medium",
    latency_sensitivity: options?.force_capture ? "low" : "high",
    output_preference: outputPreference,
    task_horizon: /\b(workflow|sequence|multi|then|after|before|across)\b/.test(lower) ? "long" : "short",
    has_prior_history: hasPriorHistory,
  };
}

function normalizeDomain(value?: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function routingSourceFromOrchestratorSource(
  source: "marketplace" | "live-capture" | "dom-fallback" | "route-cache" | "browser-action" | "first-pass",
): RoutingTelemetrySource {
  if (source === "dom-fallback") return "live-capture";
  if (source === "first-pass") return "browser-action";
  return source;
}

function routeFingerprint(endpoint: Pick<SkillManifest["endpoints"][number], "method" | "url_template">): string {
  return stableHash(`${endpoint.method}:${anonymizeUrl(endpoint.url_template)}`);
}

function operationIdForEndpoint(skill: SkillManifest | undefined, endpointId?: string): string | undefined {
  if (!skill?.operation_graph || !endpointId) return undefined;
  return skill.operation_graph.operations.find((operation) => operation.endpoint_id === endpointId)?.operation_id;
}

type CollectorOptions = {
  sessionId: string;
  startedAt: string;
  intent: string;
  traceVersion?: string;
  anonymizedAgentId?: string;
  runType: RoutingRunType;
  contextBuckets: RoutingContextBuckets;
  normalizedDomains?: string[];
};

type CandidateRankArgs = {
  stepIndex?: number;
  source: RoutingTelemetrySource;
  stateHashBefore: string;
  candidateCount: number;
  reachableOperationCount?: number;
  availableBindingCount?: number;
  missingBindingCount?: number;
  selectedEndpointId?: string;
  selectedOperationId?: string;
  candidates: RoutingCandidateSnapshot[];
};

type StepArgs = {
  stepIndex?: number;
  source: RoutingTelemetrySource;
  stateHashBefore: string;
  stateHashAfter: string;
  selectedSkillId?: string;
  selectedEndpointId?: string;
  selectedOperationId?: string;
  reachableOperationCount?: number;
  availableBindingCount?: number;
  missingBindingCount?: number;
  candidateCount: number;
  executionLatencyMs?: number;
  statusCode?: number;
  success?: boolean;
  failureReason?: string;
  schemaFingerprint?: string;
  responseHash?: string;
  crossDomainTransition?: boolean;
  retryCount?: number;
  userOverride?: boolean;
  didStepUnlockNextStep?: boolean;
  requiredRecovery?: boolean;
};

export function buildRoutingCandidateSnapshots(
  skill: SkillManifest,
  ranked: Array<{ endpoint: SkillManifest["endpoints"][number]; score: number }>,
  options?: {
    reachableEndpointIds?: Set<string>;
    selectedEndpointId?: string;
    rejectionReasons?: Record<string, string | undefined>;
  },
): RoutingCandidateSnapshot[] {
  return ranked.map((candidate, index) => ({
    candidate_id: nanoid(),
    rank: index + 1,
    skill_id: skill.skill_id,
    endpoint_id: candidate.endpoint.endpoint_id,
    operation_id: operationIdForEndpoint(skill, candidate.endpoint.endpoint_id),
    route_fingerprint: routeFingerprint(candidate.endpoint),
    score: Math.round(candidate.score * 1000) / 1000,
    chosen: candidate.endpoint.endpoint_id === options?.selectedEndpointId,
    reachable: options?.reachableEndpointIds
      ? options.reachableEndpointIds.has(candidate.endpoint.endpoint_id)
      : true,
    rejection_reason: options?.rejectionReasons?.[candidate.endpoint.endpoint_id],
    feature_snapshot: {
      method: candidate.endpoint.method,
      has_response_schema: !!candidate.endpoint.response_schema,
      dom_extraction: !!candidate.endpoint.dom_extraction,
      verification_status: candidate.endpoint.verification_status,
      reliability_score: candidate.endpoint.reliability_score,
      unsafe_action_score: candidate.endpoint.idempotency === "unsafe" ? 1 : 0,
    },
  }));
}

export function createRoutingTelemetryCollector(options: CollectorOptions) {
  const events: RoutingTelemetryEvent[] = [];
  const normalizedDomains = new Set(options.normalizedDomains?.filter(Boolean) ?? []);
  let stepIndex = 0;
  let completed = false;

  const sessionStarted: RoutingSessionEvent = {
    event_id: nanoid(),
    event_type: "routing_session_started",
    session_id: options.sessionId,
    created_at: options.startedAt,
    trace_version: options.traceVersion,
    anonymized_agent_id: options.anonymizedAgentId,
    top_level_intent: options.intent,
    normalized_domains: [...normalizedDomains],
    run_type: options.runType,
    context_buckets: options.contextBuckets,
  };
  events.push(sessionStarted);

  function syncDomains() {
    sessionStarted.normalized_domains = [...normalizedDomains];
  }

  function nextStep(explicit?: number): number {
    if (explicit && explicit > stepIndex) stepIndex = explicit;
    else if (!explicit) stepIndex += 1;
    return explicit ?? stepIndex;
  }

  return {
    sessionId: options.sessionId,
    addDomain(value?: string) {
      const domain = normalizeDomain(value);
      if (!domain) return;
      normalizedDomains.add(domain);
      syncDomains();
    },
    recordCandidates(args: CandidateRankArgs): number {
      const index = nextStep(args.stepIndex);
      const event: RoutingCandidateEvent = {
        event_id: nanoid(),
        event_type: "routing_candidates_ranked",
        session_id: options.sessionId,
        created_at: new Date().toISOString(),
        trace_version: options.traceVersion,
        anonymized_agent_id: options.anonymizedAgentId,
        top_level_intent: options.intent,
        normalized_domains: [...normalizedDomains],
        run_type: options.runType,
        step_id: `${options.sessionId}:${index}`,
        step_index: index,
        source: args.source,
        state_hash_before: args.stateHashBefore,
        candidate_count: args.candidateCount,
        reachable_operation_count: args.reachableOperationCount,
        available_binding_count: args.availableBindingCount,
        missing_binding_count: args.missingBindingCount,
        selected_endpoint_id: args.selectedEndpointId,
        selected_operation_id: args.selectedOperationId,
        candidates: args.candidates,
      };
      events.push(event);
      return index;
    },
    recordStep(args: StepArgs): number {
      const index = nextStep(args.stepIndex);
      const event: RoutingStepEvent = {
        event_id: nanoid(),
        event_type: "routing_step_executed",
        session_id: options.sessionId,
        created_at: new Date().toISOString(),
        trace_version: options.traceVersion,
        anonymized_agent_id: options.anonymizedAgentId,
        top_level_intent: options.intent,
        normalized_domains: [...normalizedDomains],
        run_type: options.runType,
        step_id: `${options.sessionId}:${index}`,
        step_index: index,
        source: args.source,
        state_hash_before: args.stateHashBefore,
        state_hash_after: args.stateHashAfter,
        selected_skill_id: args.selectedSkillId,
        selected_endpoint_id: args.selectedEndpointId,
        selected_operation_id: args.selectedOperationId,
        reachable_operation_count: args.reachableOperationCount,
        available_binding_count: args.availableBindingCount,
        missing_binding_count: args.missingBindingCount,
        candidate_count: args.candidateCount,
        execution_latency_ms: args.executionLatencyMs,
        status_code: args.statusCode,
        success: args.success,
        failure_reason: args.failureReason,
        schema_fingerprint: args.schemaFingerprint,
        response_hash: args.responseHash,
        cross_domain_transition: args.crossDomainTransition ?? false,
        retry_count: args.retryCount ?? 0,
        user_override: args.userOverride ?? false,
        did_step_unlock_next_step: args.didStepUnlockNextStep ?? false,
        required_recovery: args.requiredRecovery ?? false,
      };
      events.push(event);
      return index;
    },
    complete(args: {
      outcome: RoutingSessionOutcome;
      completedAt: string;
      totalApiCalls: number;
      retryCount: number;
      userOverride: boolean;
      requiredRecovery: boolean;
    }) {
      if (completed) return;
      completed = true;
      const rankedEvents = events.filter((event) => event.event_type === "routing_candidates_ranked");
      const stepEvents = events.filter((event) => event.event_type === "routing_step_executed");
      const completedEvent: RoutingSessionCompletedEvent = {
        event_id: nanoid(),
        event_type: "routing_session_completed",
        session_id: options.sessionId,
        created_at: args.completedAt,
        completed_at: args.completedAt,
        trace_version: options.traceVersion,
        anonymized_agent_id: options.anonymizedAgentId,
        top_level_intent: options.intent,
        normalized_domains: [...normalizedDomains],
        run_type: options.runType,
        final_outcome: args.outcome,
        final_success: args.outcome === "success",
        total_steps: stepEvents.length,
        total_candidates_ranked: rankedEvents.reduce((sum, event) => sum + event.candidate_count, 0),
        total_api_calls: args.totalApiCalls,
        retry_count: args.retryCount,
        user_override: args.userOverride,
        required_recovery: args.requiredRecovery,
      };
      events.push(completedEvent);
    },
    toBatch(): RoutingTelemetryEvent[] {
      return events.map((event) => ({
        ...event,
        normalized_domains: [...normalizedDomains],
      }));
    },
  };
}

/**
 * U-9 privacy fix: the verbatim user-intent string ("find my email password
 * reset link") must NEVER leave the machine, even when routing telemetry is
 * enabled. We replace it with an irreversible SHA-256 hash plus a coarse shape
 * signature (character length + word count) so the backend can still
 * de-duplicate / cluster sessions without ever seeing the literal text the
 * user typed. `UNBROWSE_LOCAL_ONLY=1` suppresses the egress entirely upstream
 * (recordRoutingTelemetry / postTelemetry); this is the defence in depth for
 * the default-on case.
 */
export function redactIntent(intent: string): string {
  const trimmed = (intent ?? "").trim();
  if (!trimmed) return "intent:empty";
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return `intent:sha256-${digest}:len${trimmed.length}:w${words}`;
}

export function sanitizeRoutingEventBatch(events: RoutingTelemetryEvent[]): RoutingTelemetryEvent[] {
  return events.map((event) => {
    // U-9: redact the verbatim intent on EVERY event type (the field lives on
    // the base event, so it leaked through ranked/step/completed events too).
    const base = { ...event, top_level_intent: redactIntent(event.top_level_intent) };
    if (base.event_type === "routing_candidates_ranked") {
      return {
        ...base,
        candidates: base.candidates.map((candidate) => ({
          ...candidate,
          rejection_reason: candidate.rejection_reason?.slice(0, 120),
          feature_snapshot: sanitizeObject(candidate.feature_snapshot) as RoutingCandidateSnapshot["feature_snapshot"],
        })),
      };
    }
    if (base.event_type === "routing_step_executed") {
      return {
        ...base,
        failure_reason: base.failure_reason ? classifyFailure(base.failure_reason) : undefined,
      };
    }
    return base;
  });
}

export function deriveRoutingStepArtifacts(args: {
  result: unknown;
  skill?: SkillManifest;
  selectedEndpointId?: string;
  source: "marketplace" | "live-capture" | "dom-fallback" | "route-cache" | "browser-action" | "first-pass";
  bindingsBefore?: StateBindings;
  bindingsAfter?: StateBindings;
}): {
  source: RoutingTelemetrySource;
  stateHashBefore: string;
  stateHashAfter: string;
  responseHash?: string;
  schemaFingerprint?: string;
  selectedOperationId?: string;
} {
  return {
    source: routingSourceFromOrchestratorSource(args.source),
    stateHashBefore: hashRoutingState(args.bindingsBefore),
    stateHashAfter: hashRoutingState(args.bindingsAfter ?? args.bindingsBefore),
    responseHash: args.result != null ? hashResponseBody(args.result) : undefined,
    schemaFingerprint: hashSchemaFingerprint(
      args.skill?.endpoints.find((endpoint) => endpoint.endpoint_id === args.selectedEndpointId)?.response_schema,
    ),
    selectedOperationId: operationIdForEndpoint(args.skill, args.selectedEndpointId),
  };
}
