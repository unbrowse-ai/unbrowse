import type { FastifyInstance } from "fastify";

export async function registerRateLimiter(_app: FastifyInstance): Promise<void> {
  // Disabled: single-user local runtime, no rate limit needed.
}

/** Per-route rate limit configs. Apply via route options in Fastify. */
export const ROUTE_LIMITS = {
  "/v1/intent/resolve": { max: 20, timeWindow: "1 minute" },
  "/v1/skills/:skill_id/execute": { max: 30, timeWindow: "1 minute" },
  "/v1/skills": { max: 5, timeWindow: "1 minute" }, // POST only
  "/v1/auth/login": { max: 3, timeWindow: "5 minutes" },
  "/v1/feedback": { max: 60, timeWindow: "1 minute" },
} as const;

export function routeRateLimit(path: keyof typeof ROUTE_LIMITS) {
  const cfg = ROUTE_LIMITS[path];
  return { config: { rateLimit: { max: cfg.max, timeWindow: cfg.timeWindow } } };
}