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

// Ensure browser engine is installed (agent-browser needs Chromium binaries via playwright)
try {
  const { chromium } = await import("playwright-core");
  if (!existsSync(chromium.executablePath())) {
    console.log("[startup] Chromium not found, installing...");
    // agent-browser install shells out to `npx playwright install` internally,
    // so call playwright directly to support bun-only environments
    const cmds = [
      "bunx playwright install chromium",
      "npx playwright install chromium",
    ];
    let installed = false;
    for (const cmd of cmds) {
      try {
        execSync(cmd, { stdio: "inherit", timeout: 120_000 });
        installed = true;
        break;
      } catch { /* try next */ }
    }
    if (!installed) throw new Error("All install methods failed");
  }
} catch (e) {
  console.warn(`[startup] WARNING: Could not install browser engine: ${e}`);
  console.warn("[startup] Run manually: bunx playwright install chromium");
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
