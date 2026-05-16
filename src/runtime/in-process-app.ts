// In-process Unbrowse API app for the stateless stdio MCP (Phase 0d).
//
// The stdio MCP does NOT spawn or talk to a :6969 HTTP daemon. It builds
// the same Fastify route surface in-process (no app.listen, no port, no
// pidfile, no idle-reaper) and dispatches via app.inject(). Kuri (the
// separate CDP broker) remains the only live-stateful component; browse
// sessions are rehydrated from disk so a fresh stdio process recovers
// state without a resident daemon.
//
// logger MUST stay false: the MCP speaks JSON-RPC over stdout, and a
// Fastify stdout logger would corrupt that stream.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerRateLimiter } from "../ratelimit/index.js";
import { registerRoutes, rehydrateBrowseSessions } from "../api/routes.js";
import { startBackgroundRegistration } from "../client/index.js";

let appPromise: Promise<FastifyInstance> | null = null;

async function buildApp(): Promise<FastifyInstance> {
  // Non-interactive: skip ToS prompts (mirrors server.ts bootstrap).
  if (process.env.UNBROWSE_NON_INTERACTIVE === "1" || !process.stdin.isTTY) {
    process.env.UNBROWSE_SKIP_TOS_CHECK = "1";
  }
  void startBackgroundRegistration();

  // Advertise Unbrowse's Chrome debug port via standard env conventions so
  // child processes attach to our Chrome. Idempotent: only set when unset.
  const cdpPort = Number(process.env.UNBROWSE_CDP_PORT ?? 9222);
  if (!process.env.CHROME_DEBUG_URL) {
    process.env.CHROME_DEBUG_URL = `http://127.0.0.1:${cdpPort}`;
  }
  if (!process.env.PUPPETEER_BROWSER_WS_ENDPOINT) {
    process.env.PUPPETEER_BROWSER_WS_ENDPOINT = `ws://127.0.0.1:${cdpPort}`;
  }
  if (!process.env.PLAYWRIGHT_CHROMIUM_REMOTE_DEBUGGING_URL) {
    process.env.PLAYWRIGHT_CHROMIUM_REMOTE_DEBUGGING_URL = `http://127.0.0.1:${cdpPort}`;
  }

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await registerRateLimiter(app);
  await registerRoutes(app);

  // Rehydrate browse sessions from ~/.unbrowse/sessions.jsonl so a fresh
  // stdio process recovers session phase from disk (Kuri liveness is the
  // truth; dead tabs are caught lazily by isBrowseSessionLive).
  try {
    const result = rehydrateBrowseSessions();
    if (result.restored > 0) {
      process.stderr.write(
        `[in-process-app] rehydrated ${result.restored} browse session(s) from disk\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[in-process-app] rehydrate failed: ${String(err)}\n`);
  }

  await app.ready();
  return app;
}

// Lazy singleton: built once per stdio process on first tool call, then
// reused. No HTTP, no port, no daemon.
export function getInProcessApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = buildApp().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}
