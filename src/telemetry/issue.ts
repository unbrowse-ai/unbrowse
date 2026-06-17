// CLI surface-error emitter — fire-and-forget report of an error the user hit
// (cli_timeout, client_update_required, ECONNREFUSED, no_route, captcha_block, …)
// to the backend's POST /v1/telemetry/issue feed (the internal dashboard's
// "secret faults"). Honours the same opt-out as session telemetry; a 3s timeout;
// NEVER throws and never blocks the CLI path. Pointer-only context — callers must
// not pass credentials/bodies.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { getResolvedTelemetryConfig } from "./index.js";
import { PACKAGE_VERSION } from "../version.js";

/** Stable, pseudonymous per-install id (sha256 of host+home, truncated) — for
 *  active-install counting only. No PII; not reversible to a machine. */
function stableInstallId(): string {
  try {
    return createHash("sha256").update(`${hostname()}|${homedir()}`).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

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

/**
 * One usage ping per CLI invocation — the "is anyone using it?" signal that the
 * retired session store no longer captures. Fire-and-forget, opt-out-respecting,
 * 3s timeout, never throws. Sends only {verb, version, install_id} (pseudonymous).
 */
export async function reportUsage(verb: string): Promise<void> {
  try {
    const cfg = getResolvedTelemetryConfig();
    if (!cfg.enabled || !verb) return;
    const endpoint = cfg.upload_endpoint
      .replace(/\/telemetry\/session\/?$/, "/telemetry/usage")
      .replace(/\/+$/, "");
    if (!/\/telemetry\/usage$/.test(endpoint)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          verb,
          version: PACKAGE_VERSION,
          install_id: stableInstallId(),
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
