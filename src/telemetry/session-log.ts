// SessionLogger — append-only JSONL trace of MCP tool calls for one session.
//
// Lifecycle:
//   - Created at MCP boot.
//   - `start()` writes `session_start` + opens the file handle.
//   - `recordToolStart(tool, args)` returns a call_id, writes `tool_start`.
//   - `recordToolEnd(call_id, success, ...)` writes `tool_end`.
//   - `recordReflection(intent_status, notes_hash)` writes `reflection`.
//   - `end()` writes `session_end` (and `reflection_missing` if no
//     reflection event was recorded) then closes the file.
//
// Disabled state: when telemetry is disabled, NoopSessionLogger is used
// instead — every method is a no-op. Callers don't branch.
//
// Hardcoding guard: this module emits events; it does not classify them.
// No "if duration > N emit slow" — durations are written verbatim and
// classification lives in the triage worker.

import { appendFileSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ensureSessionsDir, type ResolvedTelemetryConfig } from "./config.js";
import { sanitizeArgs, summarizeResponse, extractErrorCode, shaHex } from "./sanitize.js";

export type SessionLogger = {
  enabled: boolean;
  session_id: string;
  start(): void;
  recordToolStart(tool: string, args: unknown): string;
  recordToolEnd(call_id: string, opts: { tool: string; success: boolean; result?: unknown; error?: unknown; decision_trace?: unknown }): void;
  recordReflection(intent_status: "achieved" | "failed" | "partial", notes_hash?: string): void;
  end(): void;
  flushUpload(): Promise<void>;
  sessionFilePath(): string | undefined;
};

class RealSessionLogger implements SessionLogger {
  readonly enabled = true;
  readonly session_id: string;
  private filePath: string | undefined;
  private fd: number | undefined;
  private startedAtMs = 0;
  private toolCallsTotal = 0;
  private errorsTotal = 0;
  private reflectionSeen = false;
  private inFlight = new Map<string, { tool: string; t0: number }>();

  constructor(private readonly cfg: ResolvedTelemetryConfig, private readonly meta: SessionMeta) {
    this.session_id = randomUUID();
  }

  start(): void {
    if (this.fd !== undefined) return;
    const dir = ensureSessionsDir();
    this.filePath = path.join(dir, `${this.session_id}.jsonl`);
    this.fd = openSync(this.filePath, "a");
    this.startedAtMs = Date.now();
    const event = {
      ts: new Date(this.startedAtMs).toISOString(),
      session_id: this.session_id,
      event: "session_start",
      mcp_version: this.meta.mcp_version,
      node_version: this.meta.node_version,
      platform: this.meta.platform,
      agent_kind: "mcp",
      client_seed_fp: shaHex(this.cfg.session_id_seed, 16),
    };
    this.writeLine(event);
  }

  recordToolStart(tool: string, args: unknown): string {
    const call_id = randomUUID();
    const t0 = Date.now();
    this.inFlight.set(call_id, { tool, t0 });
    this.toolCallsTotal += 1;
    this.writeLine({
      ts: new Date(t0).toISOString(),
      session_id: this.session_id,
      event: "tool_start",
      call_id,
      tool,
      args_fingerprint: sanitizeArgs(args),
    });
    return call_id;
  }

  recordToolEnd(
    call_id: string,
    opts: { tool: string; success: boolean; result?: unknown; error?: unknown; decision_trace?: unknown },
  ): void {
    const inflight = this.inFlight.get(call_id);
    const t1 = Date.now();
    const duration_ms = inflight ? t1 - inflight.t0 : 0;
    this.inFlight.delete(call_id);
    if (!opts.success) this.errorsTotal += 1;
    const event: Record<string, unknown> = {
      ts: new Date(t1).toISOString(),
      session_id: this.session_id,
      event: "tool_end",
      call_id,
      tool: opts.tool,
      duration_ms,
      success: opts.success,
    };
    if (opts.success) {
      event.response_summary = summarizeResponse(opts.result);
    } else {
      const code = extractErrorCode(opts.error ?? opts.result);
      if (code) event.error_code = code;
    }
    if (opts.decision_trace !== undefined) {
      event.decision_trace = opts.decision_trace;
    }
    this.writeLine(event);
  }

  recordReflection(intent_status: "achieved" | "failed" | "partial", notes_hash?: string): void {
    this.reflectionSeen = true;
    const event: Record<string, unknown> = {
      ts: new Date().toISOString(),
      session_id: this.session_id,
      event: "reflection",
      intent_status,
    };
    if (notes_hash) event.notes_hash = notes_hash;
    this.writeLine(event);
  }

  end(): void {
    if (this.fd === undefined) return;
    const tEnd = Date.now();
    if (!this.reflectionSeen && this.toolCallsTotal > 0) {
      this.writeLine({
        ts: new Date(tEnd).toISOString(),
        session_id: this.session_id,
        event: "reflection_missing",
        auto: true,
      });
    }
    this.writeLine({
      ts: new Date(tEnd).toISOString(),
      session_id: this.session_id,
      event: "session_end",
      duration_ms_total: tEnd - this.startedAtMs,
      tool_calls_total: this.toolCallsTotal,
      errors_total: this.errorsTotal,
      reflection_status: this.reflectionSeen ? "seen" : "missing",
    });
    try {
      closeSync(this.fd);
    } catch {
      // closeSync can throw if the fd is already gone (e.g. forked process).
      // We swallow because the session is ending anyway.
    }
    this.fd = undefined;
  }

  // Returns a Promise that resolves once any background upload has settled
  // (or immediately if telemetry is disabled). Callers should await this
  // before exiting if they want the trace to reach the worker; otherwise
  // skip and accept the upload may drop on process exit.
  async flushUpload(): Promise<void> {
    if (this.filePath === undefined) return;
    const { uploadSessionInBackground } = await import("./upload.js");
    await uploadSessionInBackground({
      session_id: this.session_id,
      session_file: this.filePath,
    });
  }

  sessionFilePath(): string | undefined {
    return this.filePath;
  }

  private writeLine(event: Record<string, unknown>): void {
    if (this.fd === undefined) return;
    const line = JSON.stringify(event) + "\n";
    try {
      writeSync(this.fd, line);
    } catch {
      // Disk full / fd closed during shutdown. Swallow: telemetry must
      // never break the MCP request path.
    }
  }
}

class NoopSessionLogger implements SessionLogger {
  readonly enabled = false;
  readonly session_id = "disabled";
  start(): void {}
  recordToolStart(): string {
    return "disabled";
  }
  recordToolEnd(): void {}
  end(): void {}
  async flushUpload(): Promise<void> {}
  end(): void {}
  sessionFilePath(): undefined {
    return undefined;
  }
}

export type SessionMeta = {
  mcp_version: string;
  node_version: string;
  platform: string;
};

export function createSessionLogger(cfg: ResolvedTelemetryConfig, meta: SessionMeta): SessionLogger {
  if (!cfg.enabled) return new NoopSessionLogger();
  return new RealSessionLogger(cfg, meta);
}

// Convenience: hash arbitrary notes so the agent doesn't have to wire its
// own hasher when calling unbrowse_reflect.
export function hashNotes(notes: string): string {
  return createHash("sha256").update(notes).digest("hex").slice(0, 16);
}

// Helper for telemetry status reporting — surfaces presence of a session
// file without re-opening it.
export function sessionFileExists(filePath: string): boolean {
  return existsSync(filePath);
}
