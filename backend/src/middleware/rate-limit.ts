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

type PublicEnv = { Bindings: Env };
type AuthedEnv = { Bindings: Env; Variables: { agent_id: string } };

async function check(kv: KVNamespace, key: string, limit: number, window: number, c: Context) {
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= limit) {
    return c.json(
      { error: "Rate limit exceeded", retry_after: window, limit, window },
      429
    );
  }

  await kv.put(key, String(count + 1), { expirationTtl: window });
  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(limit - count - 1));
  c.header("X-RateLimit-Reset", String(window));
  return null;
}

function getIp(c: Context): string {
  return c.req.header("cf-connecting-ip")
    ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}

/**
 * IP-based rate limiter for public (unauthenticated) routes.
 */
export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context<PublicEnv>, next: Next) => {
    const key = `rl:${opts.prefix}:${getIp(c)}`;
    const blocked = await check(c.env.STATS_KV, key, opts.limit, opts.window, c);
    if (blocked) return blocked;
    await next();
  };
}

/**
 * Agent-keyed rate limiter for authenticated routes.
 * Uses agent_id from auth context. Admins are exempt.
 */
export function agentRateLimit(opts: RateLimitOptions) {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const agentId = c.get("agent_id");
    if (agentId === "__admin__") {
      await next();
      return;
    }
    const identity = agentId || getIp(c);
    const key = `rl:${opts.prefix}:${identity}`;
    const blocked = await check(c.env.STATS_KV, key, opts.limit, opts.window, c);
    if (blocked) return blocked;
    await next();
  };
}
