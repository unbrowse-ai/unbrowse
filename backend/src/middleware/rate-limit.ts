import type { Context, Next } from "hono";
import type { Env } from "../types.js";

interface RateLimitOptions {
  limit: number;
  window: number; // seconds
  prefix: string;
}

type PublicEnv = { Bindings: Env };
type AuthedEnv = { Bindings: Env; Variables: { agent_id: string } };

// Module-level in-memory store — zero network overhead, resets per isolate restart
const _rl = new Map<string, { count: number; expires: number }>();

function check(key: string, limit: number, window: number, c: Context) {
  const now = Date.now();
  const entry = _rl.get(key);
  const count = (entry && entry.expires > now) ? entry.count : 0;

  if (count >= limit) {
    return c.json(
      { error: "Rate limit exceeded", retry_after: window, limit, window },
      429
    );
  }

  _rl.set(key, { count: count + 1, expires: now + window * 1_000 });
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

export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context<PublicEnv>, next: Next) => {
    const blocked = check(`rl:${opts.prefix}:${getIp(c)}`, opts.limit, opts.window, c);
    if (blocked) return blocked;
    await next();
  };
}

export function agentRateLimit(opts: RateLimitOptions) {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const agentId = c.get("agent_id");
    if (agentId === "__admin__") { await next(); return; }
    const identity = agentId || getIp(c);
    const blocked = check(`rl:${opts.prefix}:${identity}`, opts.limit, opts.window, c);
    if (blocked) return blocked;
    await next();
  };
}
