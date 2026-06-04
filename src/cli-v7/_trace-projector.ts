/**
 * v6 → v7 trace projector — Day-5 Swarm worker B (2026-05-28).
 *
 *  — *"let the waters bring forth abundantly the moving creature."*
 *  — the smallest seed that grows.
 *
 * Purpose: project a v6 `StoredTrace` (`src/graph/trace-store.ts`) to a v7
 * `TraceStateStep` row that survives the TRACE_STATE schema gate at the
 * boundary. The v6 shape carries four FORBIDDEN fields that the backend's
 * `validateTraceAppendBody` (`backend/src/services/trace-state.ts`) rejects
 * with 400:
 *
 *   - `endpoint_sequence: string[]`  — URL/endpoint-id list (leaks paths)
 *   - `context_url?: string`         — full URL (leaks paths + queries)
 *   - `params: Record<...>`          — caller-supplied payload (leaks secrets)
 *   - `goal_embedding?: number[]`    — Float-bytes; either oversize or a
 *                                      vector reconstruction vector for the
 *                                      original intent string (information
 *                                      leak by indirection)
 *
 * The projection contract:
 *   1. Output keys are EXACTLY the subset {step, duration_ms, status_class?,
 *      error_code?, redacted?}. Backend rejects any extra key via the
 *      FORBIDDEN_FIELDS list.
 *   2. `step` MUST match /^[a-z0-9_]+$/  (decision-trace naming convention,
 *      see CLAUDE.md "Decision-trace step naming convention").
 *   3. If a v6 trace's ONLY forensic content was the URL or params (i.e.,
 *      after projection it would carry nothing but `step:"unknown"` +
 *      duration), we emit `redacted: true` rather than synthesize a fake
 *      step name. Empty rows are pointer-shaped honesty.
 *   4. PURE — no I/O, no logging, no side effects. Shape transform only.
 *
 * Coupling: this module is ONLY imported by `src/cli-v7/eval/trace.ts` (the
 * v7 stateless eval handler — sole path post-W24.6). The v6 writer at
 * `trace-store.ts` remains in-tree for the v6 CLI surface
 * (`src/cli.ts`); v7 reads from it via `readTracesFromV7TmpAndDomains`
 * and projects rows across the boundary.
 *
 * Doctrine:  — "to the v6 trace I became a v6 trace... that I
 * might gain those across the boundary." The projector is the bridge, not
 * the destination. The destination is the wallet-signed KV row.
 */

import type { StoredTrace } from "../graph/trace-store.js";

// ─── v7 step shape ─────────────────────────────────────────────────────────

/**
 * The exact wire shape the backend `validateTraceAppendBody` accepts for
 * each `traces[i]` row. Mirrors `StoredTraceStep` in
 * `backend/src/services/trace-state.ts` line 101–106, plus the `redacted`
 * flag for the empty-forensic-content edge.
 */
export interface V7TraceStep {
  /** Decision-trace step label. /^[a-z0-9_]+$/. Max 128 chars. */
  step: string;
  /** Non-negative finite millisecond duration. */
  duration_ms: number;
  /** Canonical status class — NEVER the raw status code. */
  status_class?: "2xx" | "3xx" | "4xx" | "5xx";
  /** Canonical enum error code. <= 64 chars. */
  error_code?: string;
  /**
   * Set to `true` when the v6 row's only forensic signal was a URL/param/
   * embedding (all FORBIDDEN fields) and we kept the row as a placeholder
   * rather than drop it. Lets Day-7 / agent UX see "something happened
   * here, but the bridge had nothing to forward."
   */
  redacted?: true;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Canonicalize a v6 step string to the backend's /^[a-z0-9_]+$/ regex.
 * - lowercase
 * - non-alphanum/underscore → underscore
 * - collapse runs of underscores
 * - trim leading/trailing underscores
 * - truncate to 128 chars
 *
 * If the result is empty (rare — only if the input was all whitespace/
 * punctuation), returns "unknown" so backend validation still passes.
 */
function canonicalizeStepName(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  let s = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  s = s.replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (s.length === 0) return "unknown";
  return s.slice(0, 128);
}

/**
 * Project a v6 numeric/string status into a canonical 2xx|3xx|4xx|5xx class.
 * v6 `StoredTrace` doesn't carry a status_code field per type — but real
 * rows have been observed with `status_code` populated by the v6 writer
 * (loose `Record<string, unknown>` cast at append time). We accept either
 * shape and ignore anything we cannot canonicalize.
 */
function projectStatusClass(
  rawStatus: unknown,
): "2xx" | "3xx" | "4xx" | "5xx" | undefined {
  let n: number | undefined;
  if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
    n = rawStatus;
  } else if (typeof rawStatus === "string") {
    const m = /^([2-5])xx$/i.exec(rawStatus.trim());
    if (m) return `${m[1]}xx` as "2xx" | "3xx" | "4xx" | "5xx";
    const parsed = Number.parseInt(rawStatus, 10);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === undefined) return undefined;
  if (n >= 200 && n < 300) return "2xx";
  if (n >= 300 && n < 400) return "3xx";
  if (n >= 400 && n < 500) return "4xx";
  if (n >= 500 && n < 600) return "5xx";
  return undefined;
}

/**
 * Coerce a v6 error_code-shaped field into the canonical <=64 char string
 * the backend gate accepts. NEVER passes through free-form user strings
 * (the schema only cares about length, but we still cap aggressively to
 * keep enum hygiene).
 */
function projectErrorCode(rawErr: unknown): string | undefined {
  if (typeof rawErr !== "string") return undefined;
  const trimmed = rawErr.trim();
  if (trimmed.length === 0) return undefined;
  // Canonicalize to lowercase + underscore + dot for namespacing.
  const cleaned = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_.]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, 64);
}

/**
 * Did the projection lose its only forensic signal? True iff the v6 row
 * had no `step`-shaped field AND no status AND no error_code (i.e., the
 * only useful content was URL/params/embedding, all of which we MUST drop).
 */
function isRedacted(
  v6: StoredTrace,
  projectedStep: string,
  status: ReturnType<typeof projectStatusClass>,
  err: ReturnType<typeof projectErrorCode>,
): boolean {
  // If the canonicalized step is meaningful (not the "unknown" placeholder)
  // AND not a generic "trace" stub, we have forensic content.
  const hasMeaningfulStep =
    projectedStep !== "unknown" && projectedStep !== "trace";
  if (hasMeaningfulStep) return false;
  if (status !== undefined) return false;
  if (err !== undefined) return false;
  // v6 success flag is recoverable signal — false means error pathway.
  // We surface this through error_code/status_class above; if neither
  // could be derived, the row is redacted.
  void v6;
  return true;
}

// ─── The projector ─────────────────────────────────────────────────────────

/**
 * Project a v6 `StoredTrace` to a v7 `V7TraceStep`. Pure function — no I/O,
 * no logging, no side effects.
 *
 * Drops UNCONDITIONALLY:
 *   - endpoint_sequence (URL/path leakage)
 *   - context_url (URL/path/query leakage)
 *   - params (caller payload — secrets/tokens land here)
 *   - goal_embedding (vector reconstruction of intent string)
 *   - intent (free-form user text — sometimes carries secrets in
 *     "auth into <site> with token <X>" shaped intents)
 *   - trace_id (replaced by sha256(sig)[:32] cacheKey at the wire layer)
 *   - selected_endpoint_id (endpoint id is path-shaped → URL leakage)
 *   - timestamp (server `received_at` is the canonical clock)
 *   - domain (already a top-level body field; per-row would duplicate)
 *   - success (projected into status_class via inferStatusFromSuccess)
 *
 * Preserves:
 *   - duration_ms (canonical, non-negative finite number)
 *   - status_class (derived from v6 fields if present)
 *   - error_code (canonicalized)
 *   - step (canonicalized from v6 step-shaped fields if present, else
 *     "trace" as the generic placeholder, or "unknown" if even that
 *     can't be derived)
 */
export function traceV6ToV7Step(v6Trace: StoredTrace): V7TraceStep {
  // The v6 type doesn't formally carry `step` / `status_code` / `error_code`
  // — but the writer's `appendFileSync` accepts JSON objects with extra
  // keys. Real bench traces often carry these. Read-as-Record-of-unknown,
  // canonicalize-or-drop.
  const v6Loose = v6Trace as unknown as Record<string, unknown>;

  // Try `step` first, then fall back to other v6 step-shaped fields.
  // `decision_trace` step name lives at v6.step in newer rows, at
  // v6.last_decision_step in older bench corpus rows.
  const rawStep =
    (typeof v6Loose["step"] === "string" ? (v6Loose["step"] as string) : undefined) ??
    (typeof v6Loose["last_decision_step"] === "string"
      ? (v6Loose["last_decision_step"] as string)
      : undefined) ??
    "trace";
  const step = canonicalizeStepName(rawStep);

  // duration_ms: non-negative finite. Default 0 if missing/malformed.
  let duration_ms = 0;
  if (typeof v6Trace.duration_ms === "number" && Number.isFinite(v6Trace.duration_ms)) {
    duration_ms = Math.max(0, v6Trace.duration_ms);
  }

  // status_class — from v6.status_code if present, else derived from success.
  let status_class = projectStatusClass(v6Loose["status_code"]);
  if (status_class === undefined && typeof v6Trace.success === "boolean") {
    status_class = v6Trace.success ? "2xx" : "5xx";
  }

  // error_code — from v6.error_code if present.
  const error_code = projectErrorCode(v6Loose["error_code"]);

  const out: V7TraceStep = { step, duration_ms };
  if (status_class !== undefined) out.status_class = status_class;
  if (error_code !== undefined) out.error_code = error_code;

  // Final pass — empty forensic content → mark redacted.
  if (isRedacted(v6Trace, step, status_class, error_code)) {
    out.redacted = true;
  }

  return out;
}

/**
 * Bulk projection — projects an array of v6 traces into v7 steps preserving
 * order. The route enforces traces.length <= 1024; callers should slice
 * to that ceiling BEFORE calling if they have more rows.
 */
export function traceV6ToV7Steps(v6Traces: readonly StoredTrace[]): V7TraceStep[] {
  return v6Traces.map(traceV6ToV7Step);
}

// ─── Diagnostics-only (test injection) ─────────────────────────────────────

/**
 * Test-only handle. Internal helpers exposed for the round-trip + canary
 * tests in `tests/v7-stateless-trace-projector.test.ts`. NOT public API.
 */
export const __internal = {
  canonicalizeStepName,
  projectStatusClass,
  projectErrorCode,
  isRedacted,
};
