import { execSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimiter } from "./ratelimit/index.js";
import { schedulePeriodicVerification } from "./verification/index.js";
import { startBackgroundRegistration } from "./client/index.js";
import { shutdownAllBrowsers } from "./capture/index.js";
import * as kuri from "./kuri/client.js";
import { schedulePeriodicStaleCleanup } from "./stale-cleanup-runner.js";
import { CODE_HASH, PACKAGE_VERSION } from "./version.js";

type StartServerOptions = {
  host?: string;
  port?: number;
  logger?: boolean;
  pidFile?: string;
  scheduleVerification?: boolean;
  /** Override the reaper's exit behavior. Default: process.exit(0). Tests pass a tracking callback. */
  onIdleExit?: () => void;
};

export type RunningUnbrowseServer = {
  app: FastifyInstance;
  host: string;
  port: number;
  close: (options?: { shutdownBrowsers?: boolean }) => Promise<void>;
};

function updatePidFile(pidFile?: string, host = "127.0.0.1", port = 6969): void {
  if (!pidFile) return;
  try {
    mkdirSync(path.dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, JSON.stringify({
      pid: process.pid,
      base_url: `http://${host}:${port}`,
      started_at: new Date().toISOString(),
      version: PACKAGE_VERSION,
      code_hash: CODE_HASH,
    }, null, 2));
  } catch {
    // ignore pid-file failures
  }
}

function clearPidFile(pidFile?: string): void {
  if (!pidFile) return;
  try {
    unlinkSync(pidFile);
  } catch {
    // ignore pid-file failures
  }
}

export async function startUnbrowseServer(options: StartServerOptions = {}): Promise<RunningUnbrowseServer> {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT ?? 6969);
  const pidFile = options.pidFile ?? process.env.UNBROWSE_PID_FILE;

  updatePidFile(pidFile, host, port);

  try {
    execSync("pkill -f chrome-headless-shell", { stdio: "ignore" });
  } catch {
    // no orphans
  }

  // Kuri starts on demand when browse/capture commands need it.
  // No eager start — avoids launching Chrome on every server restart.
  // Registration is allowed to finish in the background so /health is not
  // blocked by remote Worker latency during server bootstrap.
  // In non-interactive mode (server/HARNESS), skip ToS prompts entirely.
  if (process.env.UNBROWSE_NON_INTERACTIVE === "1" || !process.stdin.isTTY) {
    process.env.UNBROWSE_SKIP_TOS_CHECK = "1";
  }
  void startBackgroundRegistration();

  // Advertise Unbrowse's Chrome debug port via standard env conventions so
  // child processes (chrome-devtools MCP, Playwright via PUPPETEER_BROWSER_WS_ENDPOINT,
  // any agent that respects CHROME_DEBUG_URL) attach to our Chrome instead of
  // launching their own. This is the "single browser for the agent ecosystem"
  // play — Unbrowse becomes the upstream Chrome and captures every tab any
  // tool opens.
  //
  // Today Kuri's Zig binary spawns Chrome on 9222 (its hardcoded default).
  // Follow-up: rebuild Kuri to spawn on a dedicated port (e.g. 42069) so we
  // don't share the port with the user's personal Chrome by accident, then
  // bump UNBROWSE_CDP_PORT default here.
  // Idempotent: only set when not already configured by the user.
  const UNBROWSE_CDP_PORT = Number(process.env.UNBROWSE_CDP_PORT ?? 9222);
  if (!process.env.CHROME_DEBUG_URL) {
    process.env.CHROME_DEBUG_URL = `http://127.0.0.1:${UNBROWSE_CDP_PORT}`;
  }
  if (!process.env.PUPPETEER_BROWSER_WS_ENDPOINT) {
    process.env.PUPPETEER_BROWSER_WS_ENDPOINT = `ws://127.0.0.1:${UNBROWSE_CDP_PORT}`;
  }
  if (!process.env.PLAYWRIGHT_CHROMIUM_REMOTE_DEBUGGING_URL) {
    process.env.PLAYWRIGHT_CHROMIUM_REMOTE_DEBUGGING_URL = `http://127.0.0.1:${UNBROWSE_CDP_PORT}`;
  }

  const app = Fastify({ logger: options.logger ?? true });
  await app.register(cors, { origin: true });
  await registerRateLimiter(app);

  // Idle reaper: bump lastActivityTs on every request so the interval below
  // knows when the daemon is genuinely quiet.
  let lastActivityTs = Date.now();
  app.addHook("onRequest", (_req, _reply, done) => {
    lastActivityTs = Date.now();
    done();
  });

  await registerRoutes(app);

  // Rehydrate browse sessions from ~/.unbrowse/sessions.jsonl so active
  // sessions survive mcp-serve restarts (reaper, crash, OOM). Must happen
  // after registerRoutes so the in-memory Map is initialized. Dead tabs
  // are caught lazily by isBrowseSessionLive — we don't probe Kuri here.
  try {
    const { rehydrateBrowseSessions } = await import("./api/routes.js");
    const result = rehydrateBrowseSessions();
    if (result.restored > 0) {
      app.log.info({ restored: result.restored }, "[session-store] rehydrated browse sessions from disk");
    }
  } catch (err) {
    app.log.warn({ err }, "[session-store] rehydrate failed");
  }
  await app.listen({ port, host });
  if (options.scheduleVerification ?? true) {
    schedulePeriodicVerification();
    schedulePeriodicStaleCleanup();
  }

  // Idle reaper — self-exit when no HTTP activity AND no browse sessions
  // for UNBROWSE_SERVE_IDLE_MS. Stops the zombie-process accumulation where
  // every Ctrl-C'd Claude session leaves a detached daemon behind.
  // Set UNBROWSE_SERVE_IDLE_MS=0 to disable (long-running dev servers).
  const idleMs = Number(process.env.UNBROWSE_SERVE_IDLE_MS ?? 60_000);
  const idleCheckMs = Number(process.env.UNBROWSE_SERVE_IDLE_CHECK_MS ?? 10_000);
  let reaperTimer: NodeJS.Timeout | undefined;
  if (idleMs > 0) {
    const { getBrowseSessionCount } = await import("./api/routes.js");
    reaperTimer = setInterval(() => {
      const idleFor = Date.now() - lastActivityTs;
      if (idleFor < idleMs) return;
      const sessions = getBrowseSessionCount();
      if (sessions > 0) return;
      app.log.info({ idleFor, idleMs }, "[reaper] idle, exiting");
      const onExit = options.onIdleExit ?? (() => process.exit(0));
      void (async () => {
        try {
          if (reaperTimer) clearInterval(reaperTimer);
          reaperTimer = undefined;
          await shutdownAllBrowsers();
          await app.close();
          clearPidFile(pidFile);
        } catch (err) {
          app.log.error({ err }, "[reaper] shutdown error");
        } finally {
          onExit();
        }
      })();
    }, idleCheckMs);
    reaperTimer.unref?.();
  }

  return {
    app,
    host,
    port,
    async close(options?: { shutdownBrowsers?: boolean }): Promise<void> {
      if (reaperTimer) clearInterval(reaperTimer);
      if (options?.shutdownBrowsers ?? true) {
        await shutdownAllBrowsers();
      }
      await app.close();
      clearPidFile(pidFile);
    },
  };
}

export function installServerExitCleanup(pidFile?: string): void {
  process.on("exit", () => clearPidFile(pidFile));
}

// CLI entry point: `bun src/server.ts`
if (import.meta.main) {
  const host = process.argv[2] ?? "127.0.0.1";
  const rawPort = parseInt(process.argv[3]);
  const port = isNaN(rawPort) ? undefined : rawPort; // let startUnbrowseServer use env fallback
  const server = await startUnbrowseServer({ host, port, logger: true });
  console.log(`[server] listening on http://${server.host}:${server.port}`);
  console.log(`[server] version ${PACKAGE_VERSION}`);
  console.log("[server] new: /v1/trace/:id, /v1/skills/:id/validate (self-improvement harness)");
  installServerExitCleanup();
}
