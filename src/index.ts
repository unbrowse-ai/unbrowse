import "dotenv/config";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimiter } from "./ratelimit/index.js";
import { schedulePeriodicVerification } from "./verification/index.js";
import { ensureRegistered } from "./client/index.js";
import { shutdownAllBrowsers } from "./capture/index.js";

// Kill any chrome-headless-shell orphans left over from a previous crashed session
try {
  execSync("pkill -f chrome-headless-shell", { stdio: "ignore" });
} catch { /* no orphans — ok */ }

// Ensure browser engine is installed (agent-browser needs Chromium binaries)
try {
  const { chromium } = await import("playwright-core");
  if (!existsSync(chromium.executablePath())) {
    console.log("[startup] Chromium not found, installing...");
    execSync("npx agent-browser install", { stdio: "inherit", timeout: 120_000 });
  }
} catch {
  console.warn("[startup] WARNING: Could not verify/install browser engine. Run: npx agent-browser install");
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
  process.exit(0);
}

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
