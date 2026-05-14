import { Hono } from "hono";
import type { Env } from "../types.js";
import { kvBackend } from "../services/kv.js";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "unbrowse-api",
    environment: c.env.ENVIRONMENT ?? "unknown",
    storage_backend: kvBackend(c.env),
    timestamp: new Date().toISOString(),
  });
});
