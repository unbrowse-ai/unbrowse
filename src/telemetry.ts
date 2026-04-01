/**
 * Route trace telemetry — issue #28
 *
 * Persists anonymized routing artifacts to ~/.unbrowse/traces/ for future
 * ML training (RAG over traces, contextual bandits, KGE extraction).
 *
 * Anonymization rules (per spec):
 *   NEVER store: raw cookies, auth tokens, CSRF tokens, full request/response
 *                bodies, user-entered secrets, raw chain-of-thought, PII.
 *   DO store:    normalized binding names, hashed binding values, response
 *                schema shape, response hashes, route fingerprints,
 *                error class / failure reason taxonomy.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteTraceArtifact, TraceFailureReason } from "./types/index.js";
import { TRACE_VERSION } from "./version.js";

function getTraceDir(): string {
  return process.env.UNBROWSE_TRACES_DIR ??
    join(process.env.HOME ?? "/tmp", ".unbrowse", "traces");
}

/** Whether trace emission is enabled (opt-out via env). */
export function isTracingEnabled(): boolean {
  return process.env.UNBROWSE_DISABLE_TRACES !== "1";
}

/**
 * SHA-256 hex digest of a string value.
 * Used to hash binding values so dependency matching works without exposing
 * the actual value.
 */
export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Sensitive field name patterns — values of matching keys are stripped. */
const SENSITIVE_PATTERNS = [
  /cookie/i, /token/i, /auth/i, /key/i, /secret/i, /password/i,
  /csrf/i, /session/i, /bearer/i, /credential/i, /apikey/i,
];

function isSensitiveName(name: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(name));
}

/**
 * Return only the binding *names* that are safe to surface in a trace.
 * Values are never included; sensitive names are omitted entirely.
 */
export function safeBindingNames(bindings: Record<string, unknown>): string[] {
  return Object.keys(bindings).filter((k) => !isSensitiveName(k));
}

/**
 * Strip the query string and fragment from a URL so traces never contain
 * user-entered search terms or personal identifiers embedded in URLs.
 */
export function anonymizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.replace(/\?.*$/, "").replace(/#.*$/, "");
  }
}

/**
 * Produce a SHA-256 hex digest of the serialized result body.
 * This lets the backend detect duplicate responses without storing content.
 */
export function hashResponseBody(result: unknown): string {
  const str = typeof result === "string" ? result : JSON.stringify(result ?? "");
  return createHash("sha256").update(str).digest("hex").slice(0, 32);
}

/**
 * Classify an error message into a `TraceFailureReason` taxonomy value so
 * negative traces carry structured labels instead of free-form strings.
 */
export function classifyFailure(error: string | undefined): TraceFailureReason {
  if (!error) return "unknown";
  const e = error.toLowerCase();
  if (e.includes("auth") || e.includes("401") || e.includes("403")) return "auth_failed";
  if (e.includes("schema") || e.includes("mismatch")) return "schema_mismatch";
  if (e.includes("timeout") || e.includes("timed out")) return "timeout";
  if (e.includes("empty") || e.includes("no result")) return "empty_response";
  if (e.includes("missing") || e.includes("dependency")) return "dependency_missing";
  if (e.includes("robots") || e.includes("disallowed")) return "robots_disallowed";
  return "unknown";
}

export interface EmitTraceParams {
  trace_id: string;
  session_scope: string;
  goal: string;
  domain: string;
  started_at: string;
  skill_id?: string;
  endpoint_id?: string;
  source: RouteTraceArtifact["source"];
  status_code?: number;
  response_bytes: number;
  result?: unknown;
  schema_match?: boolean;
  candidates_considered: number;
  bindings_before: Record<string, unknown>;
  bindings_resolved: Record<string, unknown>;
  bindings_missing: string[];
  outcome: RouteTraceArtifact["outcome"];
  error?: string;
  rationale?: string;
}

/**
 * Write an anonymized `RouteTraceArtifact` to the local trace directory.
 * Returns the file path written, or null if tracing is disabled or the write fails.
 */
export function emitRouteTrace(params: EmitTraceParams): string | null {
  if (!isTracingEnabled()) return null;

  const now = new Date().toISOString();
  const artifact: RouteTraceArtifact = {
    trace_id: params.trace_id,
    session_scope: params.session_scope,
    goal: params.goal,
    domain: params.domain,
    started_at: params.started_at,
    completed_at: now,
    latency_ms: Date.now() - new Date(params.started_at).getTime(),
    skill_id: params.skill_id,
    endpoint_id: params.endpoint_id,
    source: params.source,
    status_code: params.status_code,
    response_bytes: params.response_bytes,
    response_hash: params.result != null ? hashResponseBody(params.result) : undefined,
    schema_match: params.schema_match,
    candidates_considered: params.candidates_considered,
    bindings_before: safeBindingNames(params.bindings_before),
    bindings_resolved: safeBindingNames(params.bindings_resolved),
    bindings_missing: params.bindings_missing.filter((k) => !isSensitiveName(k)),
    outcome: params.outcome,
    failure_reason: params.outcome !== "success"
      ? classifyFailure(params.error)
      : undefined,
    rationale: params.rationale,
    trace_version: TRACE_VERSION,
  };

  try {
    const traceDir = getTraceDir();
    if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });
    const stamp = params.started_at.replace(/[:.]/g, "-");
    const file = join(traceDir, `${stamp}-${params.outcome}-${params.trace_id}.json`);
    writeFileSync(file, JSON.stringify(artifact, null, 2), "utf-8");
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error accumulator — auto-file GitHub issues on repeated failures
// ---------------------------------------------------------------------------

interface AccumulatedError {
  count: number;
  firstSeen: string;
  lastSeen: string;
  error: string;
  intent: string;
  url?: string;
  domain: string;
  skillId?: string;
  endpointId?: string;
}

const errorAccumulator = new Map<string, AccumulatedError>();
const AUTO_FILE_THRESHOLD = 3;
const autoFiledKeys = new Set<string>();

export interface FailureContext {
  skillId?: string;
  endpointId?: string;
  domain: string;
  intent: string;
  url?: string;
  error: string;
}

/**
 * Record a failure. After AUTO_FILE_THRESHOLD consecutive failures for the
 * same skill+endpoint, auto-file a GitHub issue via the backend.
 */
export function recordFailure(ctx: FailureContext): void {
  const key = `${ctx.skillId ?? "unknown"}:${ctx.endpointId ?? "unknown"}`;
  const existing = errorAccumulator.get(key);
  const now = new Date().toISOString();

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
    existing.error = ctx.error;
  } else {
    errorAccumulator.set(key, {
      count: 1,
      firstSeen: now,
      lastSeen: now,
      error: ctx.error,
      intent: ctx.intent,
      url: ctx.url,
      domain: ctx.domain,
      skillId: ctx.skillId,
      endpointId: ctx.endpointId,
    });
  }

  const entry = errorAccumulator.get(key)!;
  if (entry.count >= AUTO_FILE_THRESHOLD && !autoFiledKeys.has(key)) {
    autoFiledKeys.add(key);
    // Fire-and-forget auto-file
    import("./client/index.js")
      .then((client) =>
        client.autoFileIssue({
          skill_id: ctx.skillId ?? "unknown",
          endpoint_id: ctx.endpointId ?? "unknown",
          domain: ctx.domain,
          intent: ctx.intent,
          url: ctx.url,
          error: ctx.error,
          failure_count: entry.count,
          first_seen: entry.firstSeen,
          last_seen: entry.lastSeen,
          kuri_version: process.env.KURI_VERSION ?? "unknown",
        }),
      )
      .catch((err) =>
        console.warn(`[telemetry] auto-file failed: ${(err as Error).message}`),
      );
  }
}

export function getAccumulatedErrors(): Map<string, AccumulatedError> {
  return new Map(errorAccumulator);
}

export function resetErrorAccumulatorForTests(): void {
  errorAccumulator.clear();
  autoFiledKeys.clear();
}
