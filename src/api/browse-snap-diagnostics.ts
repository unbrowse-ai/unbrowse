// Diagnostics for /v1/browse/snap.
//
// Snap returns the Kuri a11y snapshot string. When the string is empty, the
// agent has no actionable feedback (got "", session_id, tab_id, that is it).
// The page might be:
//   1. Still hydrating (SPA frameworks like Next.js, React, Reddit's app shell
//      need a tick after navigate before the a11y tree is built)
//   2. A vendor anti-bot challenge / captcha page with no a11y structure
//   3. A blank canvas (rare; usually means Kuri broker is misconfigured)
//
// We do NOT auto-retry: that masks real failures. We surface a structured
// warning + next_step so the calling agent can decide.

export type SnapDiagnostic = {
  warning?: "empty_snapshot";
  next_step?: string;
};

export function diagnoseSnapshot(snapshot: string, contextUrl: string | null | undefined): SnapDiagnostic {
  if (typeof snapshot !== "string" || snapshot.length > 0) return {};
  const url = contextUrl ?? "the current page";
  return {
    warning: "empty_snapshot",
    next_step: `Snapshot was empty for ${url}. The page may still be hydrating (call unbrowse_snap again after 500-1000ms), or it may be a captcha/challenge page with no accessibility structure (call unbrowse_screenshot to inspect visually). If repeated retries return empty, the session may be wedged: call unbrowse_close and unbrowse_go again.`,
  };
}
