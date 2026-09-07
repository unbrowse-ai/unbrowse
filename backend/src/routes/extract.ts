import { Hono } from "hono";
import type { Env } from "../types.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { indexContributorAuth, requireSignedClient } from "../middleware/auth.js";
import { execTokenGate } from "../middleware/exec-token.js";
import { extractFromDOM, type ExtractionResult } from "@unbrowse/extraction-core";

export const extractRoutes = new Hono<{ Bindings: Env }>();

extractRoutes.use("/extract/refine", rateLimit({ limit: 60, window: 60, prefix: "extract" }));

// POST /v1/extract/refine -- server-side deterministic DOM extraction.
//
// Wave 2 of the pointer-not-payload server-move (principle
// 20260522T031732Z-3c67f936). The deterministic extraction know-how
// lives SERVER-SIDE; the client holds none of it. The flow:
//
//   client browser captures (client-side, client IP)
//     -> client strips credentials (extractAuthHeaders seam)
//     -> client POSTs ONLY the credential-free HTML skeleton here
//     -> server runs extractFromDOM (zero LLM cost, no per-domain
//        registry, pure deterministic structure parsing)
//     -> server returns the structured ExtractionResult
//
// The server never drives a browser and never sees raw captured traffic
// or credentials -- only an already-credential-stripped HTML string.
// Reverse-engineering the client yields no extraction alpha; the logic
// is the @unbrowse/extraction-core package consumed only here.
//
// Sibling of /v1/search/rank (the ranking half of the same server-move):
// both are deterministic server-side processors behind the exec-token
// gate, both keep a local client fallback so offline never hard-fails.
extractRoutes.post("/extract/refine", indexContributorAuth, requireSignedClient, execTokenGate(), async (c) => {
  let body: { html?: string; intent?: string; contextUrl?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const html = typeof body?.html === "string" ? body.html : "";
  const intent = typeof body?.intent === "string" ? body.intent : "";
  const contextUrl = typeof body?.contextUrl === "string" ? body.contextUrl : undefined;
  if (!html) return c.json({ error: "html required" }, 400);
  // Bound the payload so a hostile client cannot pin a Worker isolate.
  if (html.length > 5_000_000) {
    return c.json({ error: "html too large (max 5MB)" }, 413);
  }
  try {
    const result: ExtractionResult = extractFromDOM(html, intent, contextUrl);
    return c.json(result);
  } catch (err) {
    console.error("[extract] refine failed:", (err as Error).message);
    // Signal degraded so the client keeps its local extraction
    // authoritative -- server-side refinement is an optimisation, never
    // a hard dependency.
    return c.json({ error: "extraction failed", degraded: true }, 500);
  }
});
