// MCP telemetry session uploader.
//
// On session_end (or process exit), POSTs the locally-written JSONL log to
// the upload endpoint. Single-shot, 5s timeout, no retry queue. Failures
// log to stderr only — telemetry must never break the MCP path.
//
// Hardcoding guard: this module ONLY transports events. It does not decide
// which sessions are worth uploading, does not filter "boring" events, and
// does not classify the trace. Filtering / classification belongs to the
// worker-side triage job.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { getResolvedTelemetryConfig } from "./index.js";

const UPLOAD_TIMEOUT_MS = 5_000;

export type UploadInput = {
  session_id: string;
  session_file: string;
  agent_kind_fingerprint?: string;
};

export type UploadResult =
  | { ok: true; status: number; bytes: number }
  | { ok: false; reason: string };

function deriveAgentFingerprint(meta: { mcp_version?: string; node_version?: string; platform?: string }): string {
  const seed = `${meta.mcp_version ?? "?"}|${meta.node_version ?? "?"}|${meta.platform ?? "?"}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

export async function uploadSession(input: UploadInput): Promise<UploadResult> {
  const cfg = getResolvedTelemetryConfig();
  if (!cfg.enabled) return { ok: false, reason: "telemetry_disabled" };
  if (!existsSync(input.session_file)) return { ok: false, reason: "no_session_file" };

  let raw: string;
  try {
    raw = readFileSync(input.session_file, "utf8");
  } catch (err) {
    return { ok: false, reason: `read_error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return { ok: false, reason: "empty_session" };

  let events: unknown[];
  try {
    events = lines.map((l) => JSON.parse(l));
  } catch (err) {
    return { ok: false, reason: `parse_error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Best-effort metadata derivation from the first event for the fingerprint
  // header. If absent (session_start was not the first line for some reason),
  // we fall back to a generic fp.
  const start = events.find((e) => (e as { event?: string })?.event === "session_start") as
    | { mcp_version?: string; node_version?: string; platform?: string }
    | undefined;
  const fp = input.agent_kind_fingerprint ?? deriveAgentFingerprint(start ?? {});

  const body = JSON.stringify({ session_id: input.session_id, events });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(cfg.upload_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-kind-fingerprint": fp,
      },
      body,
      signal: controller.signal,
    });
    return { ok: resp.ok, status: resp.status, bytes: body.length };
  } catch (err) {
    return { ok: false, reason: `network_error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort fire-and-forget. Wraps uploadSession and routes errors to
// stderr. Returns void so callers don't accidentally block on it.
export async function uploadSessionInBackground(input: UploadInput): Promise<void> {
  try {
    const result = await uploadSession(input);
    if (!result.ok) {
      process.stderr.write(`[telemetry] upload skipped: ${result.reason}\n`);
    }
  } catch (err) {
    process.stderr.write(`[telemetry] upload threw: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
