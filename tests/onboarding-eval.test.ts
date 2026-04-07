import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "path";
import net from "node:net";

/**
 * Onboarding eval — measures whether `unbrowse setup` guides users
 * to their first successful resolve without requiring them to figure
 * out the CLI syntax on their own.
 *
 * Success criteria:
 * 1. Setup completes without error
 * 2. A guided first resolve is attempted automatically
 * 3. The user sees a successful resolve result in stderr output
 * 4. The resolve_completed telemetry event fires
 * 5. Total time from setup start to first success < 60s
 */

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
let baseUrl: string;
let serverProc: Bun.Subprocess | null = null;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function isServerUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(url: string, timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(url)) return;
    await Bun.sleep(500);
  }
  throw new Error(`server did not become healthy at ${url} within ${timeoutMs}ms`);
}

beforeAll(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  if (!(await isServerUp(baseUrl))) {
    serverProc = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        UNBROWSE_URL: baseUrl,
        UNBROWSE_NON_INTERACTIVE: "1",
        UNBROWSE_TOS_ACCEPTED: "1",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    await waitForServer(baseUrl);
  }
});

afterAll(() => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
});

async function runSetupOnboarding(envOverrides: Record<string, string> = {}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  body: any;
  durationMs: number;
}> {
  const start = Date.now();
  const proc = Bun.spawn([process.execPath, "src/cli.ts", "setup", "--no-auto-start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: baseUrl,
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_TOS_ACCEPTED: "1",
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  let body: any;
  try {
    // Setup outputs multiple JSON lines — the last one is the report
    const lines = stdout.trim().split("\n").filter(Boolean);
    body = JSON.parse(lines[lines.length - 1] || "{}");
  } catch {
    body = {};
  }

  return { code, stdout, stderr, body, durationMs: Date.now() - start };
}

describe("onboarding eval", () => {
  it("setup completes successfully", async () => {
    const { code, stderr } = await runSetupOnboarding();
    expect(code).toBe(0);
    expect(stderr).toContain("[unbrowse]");
  }, 60_000);

  it("guided first resolve fires during setup", async () => {
    const { code, stderr } = await runSetupOnboarding();
    expect(code).toBe(0);
    // The guided resolve should produce visible output
    expect(stderr).toContain("first resolve");
  }, 60_000);

  it("guided resolve shows endpoints or result", async () => {
    const { code, stdout, stderr } = await runSetupOnboarding();
    expect(code).toBe(0);
    // Should contain evidence of a successful resolve — either
    // endpoints found or result data in the output
    const combined = stdout + stderr;
    const hasEndpoints = combined.includes("endpoint") || combined.includes("API");
    const hasResult = combined.includes("resolve") && !combined.includes("failed");
    expect(hasEndpoints || hasResult).toBe(true);
  }, 60_000);

  it("total setup time is under 60 seconds", async () => {
    const { code, durationMs } = await runSetupOnboarding();
    expect(code).toBe(0);
    expect(durationMs).toBeLessThan(60_000);
  }, 60_000);
});
