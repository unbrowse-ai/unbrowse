import { execSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimiter } from "./ratelimit/index.js";
import { schedulePeriodicVerification } from "./verification/index.js";
import { ensureRegistered } from "./client/index.js";
import { shutdownAllBrowsers } from "./capture/index.js";
import * as kuri from "./kuri/client.js";

type StartServerOptions = {
  host?: string;
  port?: number;
  logger?: boolean;
  pidFile?: string;
  scheduleVerification?: boolean;
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

  await ensureRegistered();

  const app = Fastify({ logger: options.logger ?? true });
  await app.register(cors, { origin: true });
  await registerRateLimiter(app);
  await registerRoutes(app);
  await app.listen({ port, host });
  if (options.scheduleVerification ?? true) {
    schedulePeriodicVerification();
  }

  return {
    app,
    host,
    port,
    async close(options?: { shutdownBrowsers?: boolean }): Promise<void> {
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
