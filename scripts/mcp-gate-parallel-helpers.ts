// Pure helpers extracted from mcp-gate-parallel-collect.ts so they can be
// imported without triggering the collector's top-level await + process.exit
// side effects. No I/O, no side effects. Mirrors the split that already
// exists for mcp-gate-parallel-classify.ts (classifyReason / pickSkillId).

/**
 * F4 — UNBROWSE_GATE_FORCE_GO env parser.
 *
 * Accepts "1", "true", "yes" (case-insensitive, trimmed). Any other value
 * (including unset, empty, "0", "false", "no", "maybe") returns false.
 * When true, the collector ALWAYS runs the /v1/browse/go + snap + eval +
 * close block regardless of the pre-resolve cache shortlist — used to
 * force the cookie-injection / live-capture path on probes whose
 * marketplace skill is already cached.
 */
export function parseForceGoEnv(value: string | undefined | null): boolean {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

export interface CaptureMetaInputs {
  cb: any;            // close.body
  eps: any[];         // post-resolve available_endpoints
  sb: any;            // snap.body
  evalRes: any;       // { body: ... } from /v1/browse/eval
  skillId: string | null;
  isoSelfCheck: {
    snap_current_url: string | null;
    intended_host: string;
    snap_host: string;
    host_match: boolean | null;
  };
  /** Response object from /v1/browse/go, or null if go was not called. */
  go: { status?: number; body?: any } | null;
}

/**
 * F5 — assemble the capture.meta.json payload.
 *
 * Surfaces `cookies_injected` (a passthrough of the existing
 * /v1/browse/go response field set by src/api/routes.ts only when
 * cookiesInjected > 0). When go was not called (cache short-circuit
 * with FORCE_GO=0), cookies_injected is null. When go was called and
 * the field is absent (cookiesInjected was 0), it is null. When go
 * was called and the field is present, it surfaces as-is.
 */
export function buildCaptureMeta(args: CaptureMetaInputs): Record<string, unknown> {
  const { cb, eps, sb, evalRes, skillId, isoSelfCheck, go } = args;
  const blockSignals: string[] = [];
  if (sb?.warning) blockSignals.push(String(sb.warning));
  if (evalRes?.body?.error) blockSignals.push(String(evalRes.body.error));
  return {
    total_endpoints_captured: cb?.endpoint_count ?? 0,
    n_operations: eps.length,
    captured_title: sb?.page_title || (typeof sb?.root_aria === "string" ? sb.root_aria.slice(0, 120) : ""),
    browser_block_signals: blockSignals,
    filter_rejections: null,
    capture_path: null,
    request_count: cb?.request_count ?? 0,
    indexed: cb?.indexed ?? false,
    mode: cb?.mode ?? "none",
    skill_id: skillId,
    iso_self_check: isoSelfCheck,
    capture_diagnostic: cb?.capture_diagnostic ?? null,
    // F5: passthrough of /v1/browse/go.cookies_injected. Null when go was
    // not called (cache short-circuit) or when the response did not carry
    // the field (cookiesInjected === 0 in src/api/routes.ts).
    cookies_injected: go?.body?.cookies_injected ?? null,
  };
}

/**
 * W0: per-probe timeout wrapper.
 *
 * Wraps a probe-running promise in a Promise.race against a timeout. When
 * the timeout fires (default 90s, configurable via
 * UNBROWSE_GATE_PROBE_TIMEOUT_MS), the wrapper rejects with a
 * TimeoutError-shaped object so the caller can record a
 * `crashed_during_collect: true` marker and move on. Reason it ships:
 * scripts/mcp-gate-parallel-collect.ts hung 3+ runs at random points on
 * auth-cookies / hostile lanes (browse-strict phase=run elapsed=470s+),
 * killing the whole collector. With per-probe timeouts the worker pool
 * keeps moving, the run completes with crashed_during_collect markers
 * on the stuck probes, and the in-thread judge sees the evidence.
 *
 * Pure: no I/O, no side effects. The CALLER decides what to do on timeout.
 * Tested in tests/collector-probe-timeout.test.ts (real-runtime, no mocks):
 * a sleep promise > timeout rejects with TIMEOUT marker; a fast promise
 * resolves with its real value.
 */
export class ProbeTimeoutError extends Error {
  constructor(public readonly probe_id: string, public readonly ms: number) {
    super(`probe ${probe_id} exceeded ${ms}ms timeout`);
    this.name = "ProbeTimeoutError";
  }
}

export function withProbeTimeout<T>(
  probe_id: string,
  ms: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(probe_id, ms)), ms);
  });
  return Promise.race([
    task().finally(() => { if (timer) clearTimeout(timer); }),
    timeout,
  ]);
}

/**
 * Parse the UNBROWSE_GATE_PROBE_TIMEOUT_MS env. Default 90000 (90s).
 * Floor at 5000 (5s) so callers can't accidentally pass a value too small
 * to let any real probe complete. Returns the default for any non-numeric
 * input.
 */
export function parseProbeTimeoutMs(value: string | undefined | null): number {
  const raw = Number(String(value ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return 90_000;
  return Math.max(5_000, raw);
}
