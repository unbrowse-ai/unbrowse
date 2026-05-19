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
import { traceAsync } from "../logger.js";

let appPromise: Promise<FastifyInstance> | null = null;

// First-build watchdog. buildApp is normally sub-2s; only a dead/absent
// shared kuri backend (N concurrent stdio sessions racing one Chrome/:9222
// that was killed) makes a build step hang with no timeout. Generous
// default so a slow-but-fine cold build never trips; env-tunable.
const APP_BUILD_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.UNBROWSE_APP_BUILD_TIMEOUT_MS ?? "30000", 10);
  return Number.isFinite(n) && n > 0 ? n : 30000;
})();

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
  await traceAsync("inproc", undefined, "build-ratelimit", () => registerRateLimiter(app));
  await traceAsync("inproc", undefined, "build-register-routes", () => registerRoutes(app));

  // Rehydrate browse sessions from ~/.unbrowse/sessions.jsonl so a fresh
  // stdio process recovers session phase from disk (Kuri liveness is the
  // truth; dead tabs are caught lazily by isBrowseSessionLive).
  try {
    const result = await traceAsync("inproc", undefined, "build-rehydrate", async () => rehydrateBrowseSessions());
    if (result.restored > 0) {
      process.stderr.write(
        `[in-process-app] rehydrated ${result.restored} browse session(s) from disk\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[in-process-app] rehydrate failed: ${String(err)}\n`);
  }

  await traceAsync("inproc", undefined, "build-app-ready", async () => { await app.ready(); });
  return app;
}

// Lazy singleton: built once per stdio process on first tool call, then
// reused. No HTTP, no port, no daemon.
export function getInProcessApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    // First build only is traced (cached path is instant — tracing every
    // tool call would be noise). A dangling get-app-first-build BEGIN with
    // no END names a build-time hang as the reason a tools/call never
    // reaches its route (e.g. dead kuri backend, no timeout).
    const built = traceAsync("inproc", undefined, "get-app-first-build", () => buildApp());
    // Watchdog: a dead shared kuri backend makes a build step hang
    // forever, so every tools/call that triggers the first build hangs
    // and the agent sees a permanently stuck tool, never an error. Race
    // the build against APP_BUILD_TIMEOUT_MS and fail fast with an
    // actionable next_step instead (CLAUDE.md Agent-UX: never an
    // infinite hang, never a one-word error). On timeout appPromise is
    // reset so a later call retries a fresh build once the backend
    // recovers; the orphaned hung build holds no port/listener (no
    // app.listen) and is GC'd when its kuri call finally settles.
    appPromise = (async (): Promise<FastifyInstance> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          built,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(
                `in-process app build exceeded ${APP_BUILD_TIMEOUT_MS}ms — the shared kuri/browser `
                + `backend is likely dead (common when multiple agent sessions share one Chrome/:9222 `
                + `and it was killed). Recover: pkill -9 -f 'unbrowse|kuri', then reconnect the MCP `
                + `(/mcp). Tune with UNBROWSE_APP_BUILD_TIMEOUT_MS.`,
              ));
            }, APP_BUILD_TIMEOUT_MS);
            (timer as unknown as { unref?: () => void }).unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}
