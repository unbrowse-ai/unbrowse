/**
 * OpenClaw Test Harness — Spin up a real OpenClaw agent and send messages.
 *
 * Uses `openclaw agent --agent main --json` to send real messages through the
 * actual OpenClaw runtime with all plugins loaded. No mocking — real agent,
 * real tool calls, real LLM reasoning.
 *
 * Note: `openclaw agent` spawns background tasks (token refresh, auto-discover)
 * that keep the Node process alive after the agent turn completes. We handle
 * this by redirecting output to a file and polling for the JSON result, then
 * killing the process group.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────

export interface AgentPayload {
  text: string;
  mediaUrl: string | null;
}

export interface AgentMeta {
  sessionId: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AgentResponse {
  runId: string;
  status: string;
  payloads: AgentPayload[];
  text: string;
  durationMs: number;
  meta: AgentMeta;
  raw: unknown;
}

export interface HarnessOptions {
  /** Agent id to use (default: "main"). */
  agent?: string;
  /** Timeout per message in seconds (default: 120). */
  timeoutSeconds?: number;
  /** Session ID for multi-turn conversations. Auto-generated if not set. */
  sessionId?: string;
}

// ── OpenClawHarness ───────────────────────────────────────────────────────

export class OpenClawHarness {
  readonly agent: string;
  readonly sessionId: string;
  readonly timeoutSeconds: number;
  readonly tmpDir: string;
  readonly history: { message: string; response: AgentResponse }[] = [];

  private callCount = 0;
  private pids: number[] = [];

  constructor(opts: HarnessOptions = {}) {
    this.agent = opts.agent ?? "main";
    this.timeoutSeconds = opts.timeoutSeconds ?? 120;
    this.sessionId = opts.sessionId ?? `test-${randomUUID()}`;
    this.tmpDir = join(tmpdir(), "unbrowse-test", this.sessionId);
    mkdirSync(this.tmpDir, { recursive: true });
  }

  /**
   * Send a message to the real OpenClaw agent and get the response.
   */
  async send(message: string): Promise<AgentResponse> {
    this.callCount++;
    const outFile = join(this.tmpDir, `out-${this.callCount}.json`);

    // Write message to file — avoids all shell escaping problems
    const msgFile = join(this.tmpDir, `msg-${this.callCount}.txt`);
    writeFileSync(msgFile, message, "utf-8");

    // Clean stale output
    try { unlinkSync(outFile); } catch {}

    // Launch openclaw agent with output redirected to a file.
    // We poll the file for complete JSON, then kill the process tree
    // (openclaw's background tasks prevent clean exit).
    const shellCmd = [
      `openclaw agent`,
      `--agent '${this.agent}'`,
      `--session-id '${this.sessionId}'`,
      `--json`,
      `--timeout ${this.timeoutSeconds - 5}`,
      `--message "$(cat '${msgFile}')"`,
      `> '${outFile}' 2>/dev/null < /dev/null`,
    ].join(" ");

    const proc = Bun.spawn(["sh", "-c", shellCmd], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    this.pids.push(proc.pid);

    // Poll for complete JSON
    const deadline = Date.now() + this.timeoutSeconds * 1000;
    let raw = "";
    let found = false;

    while (Date.now() < deadline) {
      await sleep(1000);
      if (!existsSync(outFile)) continue;

      try { raw = readFileSync(outFile, "utf-8"); } catch { continue; }

      // Quick check: does it look like it has a full response?
      if (raw.includes('"runId"') && raw.includes('"summary"')) {
        const jsonStr = extractJson(raw);
        if (jsonStr) { found = true; break; }
      }
    }

    // Kill the process tree
    this.killProc(proc.pid);

    // Cleanup temp files (keep outFile until parsed)
    try { unlinkSync(msgFile); } catch {}

    if (!found) {
      try { unlinkSync(outFile); } catch {}
      throw new Error(
        `openclaw agent timed out after ${this.timeoutSeconds}s.\n` +
        `Partial output (${raw.length} chars): ${raw.slice(0, 300)}`
      );
    }

    const jsonStr = extractJson(raw)!;
    try { unlinkSync(outFile); } catch {}
    return this.parseResponse(jsonStr, message);
  }

  /**
   * Write a file to the harness temp directory. Returns its absolute path.
   */
  writeTempFile(content: string, name: string): string {
    const path = join(this.tmpDir, name);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  /**
   * Write a HAR fixture to a temp file. Returns its absolute path.
   */
  writeHarFixture(harData: unknown, name = "test.har.json"): string {
    return this.writeTempFile(JSON.stringify(harData), name);
  }

  /**
   * Get the total token usage across all messages.
   */
  totalUsage(): { input: number; output: number; total: number } {
    let input = 0, output = 0, total = 0;
    for (const { response } of this.history) {
      input += response.meta.usage.input;
      output += response.meta.usage.output;
      total += response.meta.usage.total;
    }
    return { input, output, total };
  }

  /**
   * Clean up temp directory and kill any lingering processes.
   */
  dispose(): void {
    for (const pid of this.pids) {
      this.killProc(pid);
    }
    this.pids.length = 0;
    try { rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private killProc(pid: number): void {
    try {
      // Kill entire process group
      process.kill(-pid, "SIGKILL");
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }

  private parseResponse(jsonStr: string, message: string): AgentResponse {
    const parsed = JSON.parse(jsonStr);

    const payloads: AgentPayload[] = (parsed.result?.payloads ?? []).map((p: any) => ({
      text: p.text ?? "",
      mediaUrl: p.mediaUrl ?? null,
    }));

    const response: AgentResponse = {
      runId: parsed.runId ?? "",
      status: parsed.status ?? "unknown",
      payloads,
      text: payloads.map((p) => p.text).join("\n"),
      durationMs: parsed.result?.meta?.durationMs ?? 0,
      meta: parsed.result?.meta?.agentMeta ?? {
        sessionId: "",
        provider: "",
        model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      raw: parsed,
    };

    this.history.push({ message, response });
    return response;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the top-level JSON object from output that may have log lines before it.
 * Properly handles strings containing braces.
 */
function extractJson(raw: string): string | null {
  // Find the start of the JSON object
  const idx = raw.indexOf("\n{");
  const start = idx !== -1 ? idx + 1 : raw.indexOf("{");
  if (start === -1) return null;

  // Walk through the string tracking brace depth, but skip string interiors
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }

    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return raw.slice(start, i + 1);
  }

  return null; // Incomplete JSON
}

export function createTestHarness(opts: HarnessOptions = {}): OpenClawHarness {
  return new OpenClawHarness(opts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
