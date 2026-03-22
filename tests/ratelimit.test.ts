import { afterEach, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { registerRateLimiter, routeRateLimit } from "../src/ratelimit/index.js";

const originalDisable = process.env.UNBROWSE_DISABLE_RATE_LIMIT;

afterEach(() => {
  if (originalDisable === undefined) delete process.env.UNBROWSE_DISABLE_RATE_LIMIT;
  else process.env.UNBROWSE_DISABLE_RATE_LIMIT = originalDisable;
});

async function buildApp(disableRateLimit: boolean) {
  if (disableRateLimit) process.env.UNBROWSE_DISABLE_RATE_LIMIT = "1";
  else delete process.env.UNBROWSE_DISABLE_RATE_LIMIT;

  const app = Fastify();
  await registerRateLimiter(app);
  app.get("/resolve", routeRateLimit("/v1/intent/resolve"), async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("rate limiter", () => {
  it("enforces route limits by default", async () => {
    const app = await buildApp(false);
    try {
      for (let i = 0; i < 20; i++) {
        const res = await app.inject({ method: "GET", url: "/resolve" });
        expect(res.statusCode).toBe(200);
      }
      const blocked = await app.inject({ method: "GET", url: "/resolve" });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("skips rate limiting when UNBROWSE_DISABLE_RATE_LIMIT=1", async () => {
    const app = await buildApp(true);
    try {
      for (let i = 0; i < 25; i++) {
        const res = await app.inject({ method: "GET", url: "/resolve" });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
