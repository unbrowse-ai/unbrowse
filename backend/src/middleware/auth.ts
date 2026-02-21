import type { Context, Next } from "hono";
import type { Env } from "../types.js";

export async function bearerAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);
  if (token !== c.env.API_KEY) {
    return c.json({ error: "Invalid API key" }, 403);
  }
  await next();
}
