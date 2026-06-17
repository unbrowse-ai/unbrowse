// CLI surface-error emitter — fire-and-forget report of an error the user hit
// (cli_timeout, client_update_required, ECONNREFUSED, no_route, captcha_block, …)
// to the backend's POST /v1/telemetry/issue feed (the internal dashboard's
// "secret faults"). Honours the same opt-out as session telemetry; a 3s timeout;
// NEVER throws and never blocks the CLI path. Pointer-only context — callers must
// not pass credentials/bodies.
import { getResolvedTelemetryConfig } from "./index.js";
import { PACKAGE_VERSION } from "../version.js";

export interface ReportIssueOptions {
  message?: string;
  context?: Record<string, unknown>;
  sessionId?: string;
}

export async function reportIssue(kind: string, opts: ReportIssueOptions = {}): Promise<void> {
  try {
    const cfg = getResolvedTelemetryConfig();
    if (!cfg.enabled || !kind) return;
    // Derive the issue endpoint from the configured session endpoint base.
    const endpoint = cfg.upload_endpoint
      .replace(/\/telemetry\/session\/?$/, "/telemetry/issue")
      .replace(/\/+$/, "");
    if (!/\/telemetry\/issue$/.test(endpoint)) return; // unexpected endpoint shape → skip
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surface: "cli",
          kind,
          message: opts.message,
          context: opts.context,
          session_id: opts.sessionId,
          version: PACKAGE_VERSION,
          created_at: new Date().toISOString(),
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Telemetry must never break the CLI path.
  }
}
