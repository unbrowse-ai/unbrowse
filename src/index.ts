import { config as loadEnv } from "dotenv";
import { execSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimiter } from "./ratelimit/index.js";
import { schedulePeriodicVerification } from "./verification/index.js";
import { ensureRegistered } from "./client/index.js";
import { shutdownAllBrowsers } from "./capture/index.js";
import { ensureBrowserEngineInstalled } from "./runtime/setup.js";

loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", quiet: true });

const PID_FILE = process.env.UNBROWSE_PID_FILE;

function updatePidFile(): void {
  if (!PID_FILE) return;
  try {
    mkdirSync(path.dirname(PID_FILE), { recursive: true });
    writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid,
      base_url: `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 6969}`,
      started_at: new Date().toISOString(),
    }, null, 2));
  } catch {
    // ignore pid-file failures
  }
}

function clearPidFile(): void {
  if (!PID_FILE) return;
  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore pid-file failures
  }
}

updatePidFile();

// Kill any chrome-headless-shell orphans left over from a previous crashed session
try {
  execSync("pkill -f chrome-headless-shell", { stdio: "ignore" });
} catch { /* no orphans — ok */ }

// Ensure browser engine is installed (agent-browser needs Chromium binaries)
const browserEngine = await ensureBrowserEngineInstalled();
if (browserEngine.action === "installed") {
  console.log("[startup] Chromium installed.");
} else if (browserEngine.action === "failed") {
  console.warn(
    `[startup] WARNING: Could not verify/install browser engine. ${browserEngine.message ?? "Run: npx agent-browser install"}`,
  );
}

// Auto-register with backend if no API key is configured
await ensureRegistered();

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await registerRateLimiter(app);
await registerRoutes(app);

const port = Number(process.env.PORT ?? 6969);
const host = process.env.HOST ?? "127.0.0.1";

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} — closing browsers and server`);
  await shutdownAllBrowsers();
  await app.close();
  clearPidFile();
  process.exit(0);
}

process.on("exit", clearPidFile);
process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT",  () => { shutdown("SIGINT").catch(() => process.exit(1)); });

try {
  await app.listen({ port, host });
  console.log(`unbrowse running on http://${host}:${port}`);
  schedulePeriodicVerification();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
