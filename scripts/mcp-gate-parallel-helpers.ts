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
