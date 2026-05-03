import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "path";
import net from "node:net";
import { getAuthCookies } from "../src/auth/index.js";

const TESTS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(TESTS_DIR, "..");
let baseUrl = process.env.UNBROWSE_URL ?? "http://localhost:6969";
let sharedRunDir = process.env.UNBROWSE_RUN_DIR ?? "";

let serverProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let ensureBaseServerPromise: Promise<void> | null = null;
let baseServerUrl: string | null = process.env.UNBROWSE_URL ?? null;

// Product-truth suite: always drive the CLI/orchestrator path.
// Do not replace these with raw captureSession/executeSkill plumbing tests.

async function getBaseServerUrl(): Promise<string> {
  if (baseServerUrl) {
    baseUrl = baseServerUrl;
    return baseServerUrl;
  }
  const port = await getFreePort();
  baseServerUrl = `http://127.0.0.1:${port}`;
  baseUrl = baseServerUrl;
  return baseServerUrl;
}

async function isServerUp(baseUrl?: string): Promise<boolean> {
  const effectiveBaseUrl = baseUrl ?? await getBaseServerUrl();
  try {
    const res = await fetch(`${effectiveBaseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 45_000, baseUrl?: string): Promise<void> {
  const effectiveBaseUrl = baseUrl ?? await getBaseServerUrl();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(effectiveBaseUrl)) return;
    await Bun.sleep(500);
  }
  throw new Error(`server did not become healthy at ${effectiveBaseUrl} within ${timeoutMs}ms`);
}

async function waitForServerDown(timeoutMs = 10_000, baseUrl?: string): Promise<void> {
  const effectiveBaseUrl = baseUrl ?? await getBaseServerUrl();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isServerUp(effectiveBaseUrl))) return;
    await Bun.sleep(250);
  }
  throw new Error(`server stayed healthy at ${effectiveBaseUrl} for ${timeoutMs}ms`);
}

function portForBaseUrl(targetBaseUrl: string): string {
  return String(new URL(targetBaseUrl).port || "6969");
}

async function ensureBaseServer(): Promise<void> {
  const baseUrl = await getBaseServerUrl();
  if (await isServerUp(baseUrl)) return;
  if (ensureBaseServerPromise) {
    await ensureBaseServerPromise;
    return;
  }

  ensureBaseServerPromise = (async () => {
    if (await isServerUp(baseUrl)) return;
    const parsed = new URL(baseUrl);
    const host = !parsed.hostname || parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");

    serverProc = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: host,
        PORT: portForBaseUrl(baseUrl),
        UNBROWSE_URL: baseUrl,
        UNBROWSE_RUN_DIR: sharedRunDir,
        UNBROWSE_NON_INTERACTIVE: "1",
        UNBROWSE_TOS_ACCEPTED: "1",
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    try {
      await waitForServer(45_000, baseUrl);
    } catch (error) {
      serverProc.kill();
      const stderr = await new Response(serverProc.stderr).text();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
    }
  })();

  await ensureBaseServerPromise;
}

async function runCli(args: string[], envOverrides: Record<string, string> = {}): Promise<{ code: number; body: any; stdout: string; stderr: string }> {
  await ensureBaseServer();
  const baseUrl = await getBaseServerUrl();
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--no-auto-start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: envOverrides.UNBROWSE_URL ?? baseUrl,
      UNBROWSE_RUN_DIR: envOverrides.UNBROWSE_RUN_DIR ?? sharedRunDir,
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
    body = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new Error(`cli returned non-JSON stdout\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { code, body, stdout, stderr };
}

async function runCliRaw(args: string[], envOverrides: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  await ensureBaseServer();
  const baseUrl = await getBaseServerUrl();
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args, "--no-auto-start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: envOverrides.UNBROWSE_URL ?? baseUrl,
      UNBROWSE_RUN_DIR: envOverrides.UNBROWSE_RUN_DIR ?? sharedRunDir,
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

  return { code, stdout, stderr };
}

async function runCliWithAutoStart(args: string[], envOverrides: Record<string, string> = {}): Promise<{ code: number; body: any; stdout: string; stderr: string }> {
  const baseUrl = await getBaseServerUrl();
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: envOverrides.UNBROWSE_URL ?? baseUrl,
      UNBROWSE_RUN_DIR: envOverrides.UNBROWSE_RUN_DIR ?? sharedRunDir,
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
    body = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new Error(`cli returned non-JSON stdout\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { code, body, stdout, stderr };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((err) => err ? reject(err) : resolve(port));
    });
    server.on("error", reject);
  });
}

function pidFileFor(runDir: string, port: number): string {
  return join(runDir, `server-127.0.0.1-${port}.json`);
}

function getSkillId(body: any): string | undefined {
  return body?.skill?.skill_id ?? body?.trace?.skill_id ?? body?.result?.skill_id;
}

function getResolvedEndpointId(body: any): string | undefined {
  return body?.trace?.endpoint_id;
}

function getExecutableEndpointId(body: any): string | undefined {
  const deferred = body?.result?.available_endpoints ?? body?.available_endpoints ?? [];
  const byScore = [...deferred].sort((lhs: any, rhs: any) => (rhs?.score ?? 0) - (lhs?.score ?? 0));
  const schemaBacked = byScore.find((ep: any) => ep?.schema_summary);
  const triggerMatched = byScore.find((ep: any) => typeof ep?.trigger_url === "string" && typeof ep?.url === "string");
  const noParam = byScore.find((ep: any) => typeof ep?.url === "string" && !ep.url.includes("{"));
  return schemaBacked?.endpoint_id ?? triggerMatched?.endpoint_id ?? noParam?.endpoint_id ?? byScore[0]?.endpoint_id;
}

function getAnyExecutableEndpointId(body: any): string | undefined {
  return getResolvedEndpointId(body) ?? getExecutableEndpointId(body);
}

function hasData(body: any): boolean {
  const result = body?.result ?? body?.trace?.result;
  if (Array.isArray(result)) return result.length > 0;
  if (result && typeof result === "object") {
    if (result.error || result.hint) return false;
    if (Array.isArray(result.data)) return result.data.length > 0;
    if (result.data && typeof result.data === "object") return Object.keys(result.data).length > 0;
    return Object.keys(result).length > 0;
  }
  return false;
}

afterAll(() => {
  serverProc?.kill();
  if (!process.env.UNBROWSE_RUN_DIR && sharedRunDir) {
    rmSync(sharedRunDir, { recursive: true, force: true });
  }
});

describe("CLI end-to-end", () => {
  beforeAll(async () => {
    if (!process.env.UNBROWSE_URL) {
      const port = await getFreePort();
      baseUrl = `http://127.0.0.1:${port}`;
      baseServerUrl = baseUrl;
    } else {
      baseServerUrl = baseUrl;
    }
    if (!sharedRunDir) {
      sharedRunDir = mkdtempSync(join(tmpdir(), "unbrowse-cli-e2e-"));
    }
  });

  it("health auto-starts the local server on a custom URL", async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-run-"));

    const { code, body } = await runCliWithAutoStart(["health"], {
      UNBROWSE_URL: baseUrl,
      UNBROWSE_RUN_DIR: runDir,
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
    });

    expect(code).toBe(0);
    expect(body.status).toBe("ok");
    expect(await isServerUp(baseUrl)).toBe(true);

    const pidFile = pidFileFor(runDir, port);
    const pid = JSON.parse(readFileSync(pidFile, "utf-8")) as { pid: number };
    expect(pid.pid).toBeGreaterThan(0);

    process.kill(pid.pid, "SIGTERM");
    await waitForServerDown(10_000, baseUrl);
  }, 45_000);

  it("health returns JSON from the local server", async () => {
    const { code, body } = await runCli(["health"]);
    expect(code).toBe(0);
    expect(body.status).toBe("ok");
  }, 10_000);

  it("sessions reads local trace logs instead of proxying to the backend", async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-run-"));
    const tracesDir = mkdtempSync(join(tmpdir(), "unbrowse-traces-"));
    const tracePath = join(tracesDir, `test-sessions-${Date.now()}.json`);
    try {
      writeFileSync(tracePath, JSON.stringify({
        intent: "get feed posts",
        context: { url: "https://www.linkedin.com/feed/" },
        skill_id: "skill-local",
        selected_endpoint_id: "endpoint-local",
        outcome: "autoexec_success",
      }));

      const sessions = await runCliWithAutoStart([
        "sessions",
        "--domain", "www.linkedin.com",
        "--limit", "1",
      ], {
        UNBROWSE_URL: baseUrl,
        UNBROWSE_RUN_DIR: runDir,
        TRACES_DIR: tracesDir,
        UNBROWSE_DISABLE_AUTO_UPDATE: "1",
      });

      expect(sessions.code).toBe(0);
      expect(sessions.body.error).toBeUndefined();
      expect(Array.isArray(sessions.body.sessions)).toBe(true);
      expect(sessions.body.sessions[0]?.skill_id).toBe("skill-local");
      expect(sessions.body.sessions[0]?.url).toBe("https://www.linkedin.com/feed/");
    } finally {
      const pidFile = pidFileFor(runDir, port);
      try {
        const pid = JSON.parse(readFileSync(pidFile, "utf-8")) as { pid: number };
        process.kill(pid.pid, "SIGTERM");
        await waitForServerDown(10_000, baseUrl);
      } catch {
        // best-effort cleanup
      }
      rmSync(tracePath, { force: true });
      rmSync(tracesDir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 45_000);

  it("resolve returns a runnable marketplace-backed endpoint for a public PyPI package page", async () => {
    const resolve = await runCli([
      "resolve",
      "--intent", "get package info",
      "--url", "https://pypi.org/project/openai/",
    ]);

    expect(resolve.code).toBe(0);
    expect(resolve.body.error).toBeUndefined();
    expect(getSkillId(resolve.body) || hasData(resolve.body)).toBeTruthy();
    expect(["marketplace", "live-capture"]).toContain(resolve.body.source);
    expect(getAnyExecutableEndpointId(resolve.body) || hasData(resolve.body)).toBeTruthy();
  }, 90_000);

  it("resolve + execute works through the CLI path for npm package search", async () => {
    const resolve = await runCli([
      "resolve",
      "--intent", "search packages",
      "--url", "https://www.npmjs.com/search?q=openai",
    ]);

    expect(resolve.code).toBe(0);
    expect(resolve.body.error).toBeUndefined();
    expect(resolve.body.result?.error).not.toBe("auth_required");
    expect(getSkillId(resolve.body) || hasData(resolve.body)).toBeTruthy();

    const skillId = getSkillId(resolve.body);
    const endpointId = getAnyExecutableEndpointId(resolve.body);
    if (!skillId || !endpointId) return;

    const execute = await runCli([
      "execute",
      "--skill", skillId,
      "--endpoint", endpointId,
      "--url", "https://www.npmjs.com/search?q=openai",
      "--intent", "search packages",
    ]);

    expect(execute.code).toBe(0);
    expect(execute.body.error).toBeUndefined();
    expect(execute.body.result?.error).not.toBe("auth_required");
  }, 180_000);

  it("resolve does not fall back to auth_required when browser creds exist", async () => {
    const cookies = await getAuthCookies("x.com");
    if (!cookies || cookies.length === 0) {
      console.log("SKIP: not logged into x.com in Chrome");
      return;
    }
    const searchUrl = "https://x.com/search?q=openai&src=typed_query";

    const resolve = await runCli([
      "resolve",
      "--intent", "search tweets",
      "--url", searchUrl,
    ]);

    expect(resolve.code).toBe(0);
    expect(resolve.body.error).not.toBe("auth_required");
    expect(resolve.body.result?.error).not.toBe("auth_required");
    expect(getSkillId(resolve.body) || hasData(resolve.body)).toBeTruthy();

    const endpointId = getAnyExecutableEndpointId(resolve.body);
    const skillId = getSkillId(resolve.body);
    if (!skillId || !endpointId) return;

    const execute = await runCli([
      "execute",
      "--skill", skillId,
      "--endpoint", endpointId,
    ]);

    expect(execute.code).toBe(0);
    expect(execute.body.error).not.toBe("auth_required");
    expect(execute.body.result?.error).not.toBe("auth_required");
  }, 240_000);

  it("browse session: go + eval + snap + close works end-to-end on example.com", async () => {
    // This test catches the multi-broker regression where go reports success
    // but the tab never navigates (stays on about:blank) and all CDP commands fail.
    //
    // The go command needs Kuri (browser engine) — if it can't connect, skip gracefully
    // like the other browser-dependent tests. But if go succeeds, eval/snap MUST work.
    // Try auto-start first; if Kuri/Chrome isn't available, skip gracefully.
    // In CI the cli-e2e job builds Kuri before running tests.
    // Locally, `unbrowse health` should be running for this to work.
    const go = await runCliWithAutoStart(["go", "https://example.com"]);
    if (go.body.error === "recoverable_browse_failure" || go.body.error === "connection_failed") {
      console.log(`SKIP: Kuri/Chrome not available for browse session test (${go.body.error}: ${go.body.message ?? "no detail"})`);
      return;
    }
    expect(go.code).toBe(0);
    expect(go.body.ok).toBe(true);
    expect(go.body.session_id).toBeTruthy();
    expect(go.body.tab_id).toBeTruthy();

    const sessionId = go.body.session_id;

    // eval must return real page content — not CDP error, not empty.
    // This is the key assertion: if eval fails here, the tab never navigated.
    const evalResult = await runCli(["eval", "--session", sessionId, "document.title"]);
    expect(evalResult.code).toBe(0);
    expect(evalResult.body.result).toBeTruthy();
    expect(evalResult.body.result).not.toEqual({ error: "CDP command failed" });
    expect(typeof evalResult.body.result).toBe("string");
    expect(evalResult.body.result.length).toBeGreaterThan(0);

    // snap must return a non-empty a11y tree
    const snap = await runCliRaw(["snap", "--session", sessionId]);
    expect(snap.code).toBe(0);
    // snap outputs raw text when not --pretty, check stdout directly
    expect(snap.stdout).toContain("[e0]");
    expect(snap.stdout).toContain("Example Domain");

    // close must succeed and checkpoint
    const close = await runCli(["close", "--session", sessionId]);
    expect(close.code).toBe(0);
    expect(close.body.ok).toBe(true);
  }, 90_000);

  it("resolve + execute stays on the CLI path for auth-gated LinkedIn people search when browser creds exist", async () => {
    const cookies = await getAuthCookies("linkedin.com");
    if (!cookies || cookies.length === 0) {
      console.log("SKIP: not logged into linkedin.com in Chrome");
      return;
    }

    const resolve = await runCli([
      "resolve",
      "--intent", "search people",
      "--url", "https://www.linkedin.com/search/results/people/?keywords=openai",
    ]);

    expect(resolve.code).toBe(0);
    expect(resolve.body.error).not.toBe("auth_required");
    expect(resolve.body.result?.error).not.toBe("auth_required");
    expect(getSkillId(resolve.body) || hasData(resolve.body)).toBeTruthy();

    const skillId = getSkillId(resolve.body);
    const endpointId = getAnyExecutableEndpointId(resolve.body);
    if (!skillId || !endpointId) return;

    const execute = await runCli([
      "execute",
      "--skill", skillId,
      "--endpoint", endpointId,
    ]);

    expect(execute.code).toBe(0);
    expect(execute.body.error).not.toBe("auth_required");
    expect(execute.body.result?.error).not.toBe("auth_required");
  }, 120_000);
});
