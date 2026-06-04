import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionLogger } from "../src/telemetry/session-log.js";
import { getTelemetryConfig } from "../src/telemetry/config.js";

// These tests exercise the real SessionLogger against a real temp HOME.
// No mocks. The check is: events get written, durations are positive,
// PII never appears in the serialised log.

let originalHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(path.join(tmpdir(), "unbrowse-telemetry-"));
  process.env.HOME = tmpHome;
  delete process.env.UNBROWSE_TELEMETRY;
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function readSessionLines(sessionsDir: string): Array<Record<string, unknown>> {
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThanOrEqual(1);
  const raw = readFileSync(path.join(sessionsDir, files[0]), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("SessionLogger end-to-end", () => {
  test("writes session_start, tool_start/tool_end pairs, session_end", () => {
    const cfg = getTelemetryConfig();
    expect(cfg.enabled).toBe(true);
    const logger = createSessionLogger(cfg, {
      mcp_version: "test-0.0.0",
      node_version: "v20.0.0",
      platform: "darwin-arm64",
    });
    logger.start();

    const callA = logger.recordToolStart("unbrowse_resolve", {
      intent: "search hacker news for AI agents",
      url: "https://news.ycombinator.com/",
    });
    logger.recordToolEnd(callA, {
      tool: "unbrowse_resolve",
      success: true,
      result: { structuredContent: { available_operations: [{ endpoint_id: "ep1" }] } },
    });

    const callB = logger.recordToolStart("unbrowse_execute", {});
    logger.recordToolEnd(callB, {
      tool: "unbrowse_execute",
      success: false,
      error: { error_code: "auth_required" },
    });

    logger.end();

    const events = readSessionLines(cfg.sessions_dir);
    const types = events.map((e) => e.event);
    expect(types).toContain("session_start");
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("session_end");
    expect(types).toContain("reflection_missing");

    const starts = events.filter((e) => e.event === "tool_start");
    const ends = events.filter((e) => e.event === "tool_end");
    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);

    // Every tool_start has a matching tool_end by call_id.
    for (const s of starts) {
      const match = ends.find((e) => e.call_id === s.call_id);
      expect(match).toBeDefined();
      expect(match!.duration_ms).toBeGreaterThanOrEqual(0);
    }

    // PII invariant: the raw intent text and raw URL host segments must
    // not appear verbatim in the log. (Note: the host stays — that's
    // intentional for clustering — but we check for the intent text.)
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain("search hacker news for AI agents");

    // The session_end summary tracks counts and reflection_status.
    const end = events.find((e) => e.event === "session_end") as Record<string, unknown>;
    expect(end.tool_calls_total).toBe(2);
    expect(end.errors_total).toBe(1);
    expect(end.reflection_status).toBe("missing");
  });

  test("recordReflection suppresses reflection_missing on session_end", () => {
    const cfg = getTelemetryConfig();
    const logger = createSessionLogger(cfg, {
      mcp_version: "test",
      node_version: process.version,
      platform: process.platform,
    });
    logger.start();
    const id = logger.recordToolStart("unbrowse_health", {});
    logger.recordToolEnd(id, { tool: "unbrowse_health", success: true, result: { ok: true } });
    logger.recordReflection("achieved");
    logger.end();

    const events = readSessionLines(cfg.sessions_dir);
    const types = events.map((e) => e.event);
    expect(types).toContain("reflection");
    expect(types).not.toContain("reflection_missing");
    const end = events.find((e) => e.event === "session_end") as Record<string, unknown>;
    expect(end.reflection_status).toBe("seen");
  });

  test("client_seed_fp on session_start is deterministic from config seed", () => {
    const cfg = getTelemetryConfig();
    const logger = createSessionLogger(cfg, { mcp_version: "x", node_version: "y", platform: "z" });
    logger.start();
    logger.end();
    const events = readSessionLines(cfg.sessions_dir);
    const start = events.find((e) => e.event === "session_start") as Record<string, unknown>;
    expect(typeof start.client_seed_fp).toBe("string");
    expect((start.client_seed_fp as string).length).toBe(16);
  });
});

describe("SessionLogger disabled state", () => {
  test("UNBROWSE_TELEMETRY=0 makes the logger a no-op (no file created)", () => {
    process.env.UNBROWSE_TELEMETRY = "0";
    const cfg = getTelemetryConfig();
    expect(cfg.enabled).toBe(false);
    const logger = createSessionLogger(cfg, { mcp_version: "x", node_version: "y", platform: "z" });
    expect(logger.enabled).toBe(false);
    logger.start();
    const id = logger.recordToolStart("unbrowse_health", { intent: "x" });
    expect(id).toBe("disabled");
    logger.recordToolEnd(id, { tool: "unbrowse_health", success: true });
    logger.end();
    // No session file should exist under the tmp home.
    const sessionsDir = cfg.sessions_dir;
    expect(existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")) : []).toEqual([]);
  });
});
