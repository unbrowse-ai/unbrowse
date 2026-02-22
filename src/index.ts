import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./api/routes.js";
import { registerRateLimiter } from "./ratelimit/index.js";
import { schedulePeriodicVerification } from "./verification/index.js";
import { ensureRegistered } from "./client/index.js";

// Auto-register with backend if no API key is configured
await ensureRegistered();

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await registerRateLimiter(app);
await registerRoutes(app);

const port = Number(process.env.PORT ?? 6969);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
  console.log(`unbrowse running on http://${host}:${port}`);
  schedulePeriodicVerification();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
