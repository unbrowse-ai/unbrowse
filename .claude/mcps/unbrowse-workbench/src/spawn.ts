// Child-process bookkeeping. Wraps a spawned MCP upstream with a
// line-buffered stdout reader and a stderr buffer the parent can drain
// on demand.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LineReader } from "./framing.ts";

export interface ChildHandle {
  proc: ChildProcessWithoutNullStreams;
  send(line: string): void;
  onMessage(callback: (line: string) => void): void;
  drainStderr(): string;
  kill(): void;
  readonly label: string;
}

export function spawnChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): ChildHandle {
  // shell:false; the caller pre-splits command + args. We accept a
  // shell-style string upstream (UNBROWSE_BIN_*) and the proxy.ts
  // splits it before calling us. Deferred: full POSIX-shell quoting.
  const proc = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  let stderrBuf = "";
  proc.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
    // Cap to avoid unbounded growth across long sessions.
    if (stderrBuf.length > 64 * 1024) {
      stderrBuf = stderrBuf.slice(-32 * 1024);
    }
  });

  const callbacks: Array<(line: string) => void> = [];
  const reader = new LineReader((line) => {
    for (const cb of callbacks) cb(line);
  });
  proc.stdout.on("data", (chunk: string) => reader.push(chunk));
  proc.stdout.on("end", () => reader.flush());

  proc.on("exit", (code, signal) => {
    process.stderr.write(
      `[workbench] child ${label} exited code=${code} signal=${signal}\n`,
    );
  });

  return {
    proc,
    label,
    send(line: string) {
      if (!proc.stdin.writable) return;
      proc.stdin.write(line);
    },
    onMessage(callback) {
      callbacks.push(callback);
    },
    drainStderr() {
      const out = stderrBuf;
      stderrBuf = "";
      return out;
    },
    kill() {
      try {
        proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
    },
  };
}

// Parse a shell-style command string into [command, ...args]. Naive
// whitespace split; sufficient for the env-var forms we accept
// ("bun run /abs/path/mcp.ts", "/abs/path/unbrowse mcp"). Deferred:
// quoted args with embedded spaces.
export function parseCommand(raw: string): { command: string; args: string[] } {
  const parts = raw.trim().split(/\s+/).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error("empty command string");
  }
  return { command: parts[0]!, args: parts.slice(1) };
}
