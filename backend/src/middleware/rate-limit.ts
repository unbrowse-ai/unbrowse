import type { Context, Next } from "hono";
import type { Env } from "../types.js";

interface RateLimitOptions {
  /** Max requests per window */
  limit: number;
  /** Window size in seconds */
  window: number;
  /** KV key prefix */
  prefix: string;
}

/**
 * IP-based rate limiter using KV with TTL.
 * Each IP gets a counter key that auto-expires after the window.
 */
export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const ip = c.req.header("cf-connecting-ip")
      ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? "unknown";

    const key = `rl:${opts.prefix}:${ip}`;
    const kv = c.env.STATS_KV;

    const current = await kv.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= opts.limit) {
      return c.json(
        {
          error: "Rate limit exceeded",
          retry_after: opts.window,
          limit: opts.limit,
          window: opts.window,
        },
        429
      );
    }

    // Increment counter with TTL
    await kv.put(key, String(count + 1), { expirationTtl: opts.window });

    // Set rate limit headers
    c.header("X-RateLimit-Limit", String(opts.limit));
    c.header("X-RateLimit-Remaining", String(opts.limit - count - 1));
    c.header("X-RateLimit-Reset", String(opts.window));

    await next();
  };
}
