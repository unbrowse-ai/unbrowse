import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("no address"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForListening(
  proc: ReturnType<typeof spawn>,
  port: number,
  timeoutMs = 15_000,
): Promise<{ exited: boolean; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let exited = false;
  proc.stdout?.on("data", (b) => { stdout += b.toString(); });
  proc.stderr?.on("data", (b) => { stderr += b.toString(); });
  proc.on("exit", () => { exited = true; });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) return { exited, stdout, stderr };
    // Probe TCP listener
    try {
      const ok = await new Promise<boolean>((res) => {
        const sock = new (require("node:net").Socket)();
        sock.setTimeout(500);
        sock.once("connect", () => { sock.destroy(); res(true); });
        sock.once("error", () => { sock.destroy(); res(false); });
        sock.once("timeout", () => { sock.destroy(); res(false); });
        sock.connect(port, "127.0.0.1");
      });
      if (ok) return { exited, stdout, stderr };
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return { exited, stdout, stderr };
}

async function waitForExit(
  proc: ReturnType<typeof spawn>,
  timeoutMs = 8_000,
): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode;
  return await new Promise((res) => {
    const t = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      res(null);
    }, timeoutMs);
    proc.once("exit", (code) => {
      clearTimeout(t);
      res(code);
    });
  });
}

async function runServeAndKill(
  signal: "SIGTERM" | "SIGINT",
): Promise<{ exitCode: number | null; listened: boolean; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "unbrowse-serve-"));
  const port = await pickEphemeralPort();
  const pidFile = join(home, "unbrowse.pid");
  const proc = spawn("bun", [CLI, "breath", "serve"], {
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      HOST: "127.0.0.1",
      UNBROWSE_PID_FILE: pidFile,
      UNBROWSE_SERVE_IDLE_MS: "0",
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_SKIP_TOS_CHECK: "1",
      // Keep the test fast: avoid network registration noise from logs.
      NODE_NO_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const { exited, stderr } = await waitForListening(proc, port, 15_000);
    const listened = !exited;
    if (!listened) {
      return { exitCode: proc.exitCode, listened, stderr };
    }
    proc.kill(signal);
    const exitCode = await waitForExit(proc, 8_000);
    return { exitCode, listened, stderr };
  } finally {
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    if (existsSync(pidFile)) {
      try { rmSync(pidFile, { force: true }); } catch {}
    }
  }
}

describe("cli serve verb", () => {
  test("starts a foreground server and exits cleanly on SIGTERM", async () => {
    const { exitCode, listened } = await runServeAndKill("SIGTERM");
    expect(listened).toBe(true);
    // 143 = 128 + SIGTERM(15); 0 = clean shutdown handler path; null = killed
    expect([0, 143]).toContain(exitCode);
  }, 25_000);

  test("starts a foreground server and exits cleanly on SIGINT", async () => {
    const { exitCode, listened } = await runServeAndKill("SIGINT");
    expect(listened).toBe(true);
    // 130 = 128 + SIGINT(2); 0 = clean shutdown handler path
    expect([0, 130]).toContain(exitCode);
  }, 25_000);
});
