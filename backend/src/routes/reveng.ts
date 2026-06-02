import { Hono } from "hono";
import type { Env } from "../types.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { bearerAuth, requireSignedClient } from "../middleware/auth.js";
import { execTokenGate } from "../middleware/exec-token.js";
import type { RawRequest } from "../../../src/capture/index.js";
import { obfuscateCaptureForReveng } from "../../../src/capture/obfuscate.js";
import { extractEndpoints } from "../../../src/reverse-engineer/index.js";

export const revengRoutes = new Hono<{ Bindings: Env }>();

revengRoutes.use("/reveng", rateLimit({ limit: 60, window: 60, prefix: "reveng" }));

/**
 * Reverse-engineer an OBFUSCATED capture into endpoint specs, SERVER-SIDE.
 *
 * The reveng know-how lives on the backend; the client holds none of it. The
 * flow mirrors the pointer-not-payload server-move (sibling of
 * /v1/extract/refine):
 *
 *   client browser captures traffic (client-side, client IP)
 *     -> client OBFUSCATES the capture (src/capture/obfuscate): every secret
 *        VALUE + PII stripped, only the route STRUCTURE (template, method,
 *        header/param names, response schema) + per-secret wallet-binding tags
 *        remain. The real secrets never leave the client's local vault.
 *     -> client POSTs ONLY the obfuscated capture here
 *     -> server runs extractEndpoints over the structure (no secret to see)
 *     -> server returns the derived endpoint specs
 *
 * Defence in depth: the server re-runs the obfuscation pass over the input
 * before extracting. The obfuscation is idempotent on an already-clean capture
 * (the secrets are already gone), so a well-behaved client loses nothing — but
 * a misbehaving or buggy client that posts raw traffic has its secrets stripped
 * SERVER-SIDE before any reveng touches them. The route never returns, logs, or
 * persists a secret value.
 *
 * The downstream "harness" modes the spec feeds — "grab data with my keys"
 * (execute an endpoint) and "search for data" — consume these specs; this route
 * is the spec-production half.
 */
export function revengObfuscatedCapture(capture: RawRequest[]) {
  // Defensive re-obfuscation: idempotent on clean input, secret-stripping on raw.
  const safe = obfuscateCaptureForReveng(capture);
  return extractEndpoints(safe);
}

revengRoutes.post("/reveng", bearerAuth, requireSignedClient, execTokenGate(), async (c) => {
  let body: { capture?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const capture = body?.capture;
  if (!Array.isArray(capture)) {
    return c.json({ error: "capture (RawRequest[]) required" }, 400);
  }
  // Bound the payload so a hostile client cannot pin a Worker isolate.
  if (capture.length > 5000) {
    return c.json({ error: "capture too large (max 5000 requests)" }, 413);
  }
  try {
    const endpoints = revengObfuscatedCapture(capture as RawRequest[]);
    return c.json({ endpoints, count: endpoints.length });
  } catch (err) {
    console.error("[reveng] extract failed:", (err as Error).message);
    return c.json({ error: "reveng failed", degraded: true }, 500);
  }
});
