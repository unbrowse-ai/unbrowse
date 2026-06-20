import { Hono } from "hono";
import type { Env } from "../types.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { indexContributorAuth, requireSignedClient } from "../middleware/auth.js";
import { execTokenGate } from "../middleware/exec-token.js";
import type { RawRequest } from "../../../src/capture/index.js";
import { obfuscateCaptureForReveng } from "../../../src/capture/obfuscate.js";
import { extractEndpoints } from "../services/reverse-engineer/index.js";
import { extractHoles, type HoleTemplate } from "../../../src/capture/hole-template.js";
import { publishSkill } from "../services/marketplace.js";
import { enforcePublishSanitization, detectResidualSecretLeak } from "../services/publish-sanitize.js";
import { aiScrubEndpoints } from "../services/ai-scrub.js";
import { validateSkillManifest } from "../services/validator.js";
import type { EndpointDescriptor } from "../types.js";

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

/**
 * Reveng AND expose only the holes. Returns the endpoint specs plus, per request,
 * the hole template (skeleton + typed holes the client fills locally from its
 * vault/LLM). The backend holds the reveng; the client receives the SHAPE and
 * the NAMES of what to fill and nothing more — secrets never leave the client,
 * and the defensively-re-obfuscated skeleton + holes carry none either.
 */
export function revengWithHoles(capture: RawRequest[]): {
  endpoints: ReturnType<typeof extractEndpoints>;
  holes: HoleTemplate[];
} {
  const safe = obfuscateCaptureForReveng(capture);
  return { endpoints: extractEndpoints(safe), holes: safe.map(extractHoles) };
}

/**
 * PASSIVE auto-index — the route graph grows from usage, not from a deliberate
 * publish. After a capture is reverse-engineered into endpoint specs (already
 * secret-stripped by the obfuscation pass — "no secret to see"), publish them so
 * a later resolve finds them, with NO explicit /skills call. Confidence is
 * intrinsic: extractEndpoints already dropped non-API / non-positive-score
 * requests, so what arrives here IS the confident set. Defense-in-depth: re-run
 * the SAME server-authoritative publish sanitizer + AI-scrub the /skills route
 * uses before anything enters the public marketplace — a residual-leak domain is
 * SKIPPED, never published. Best-effort + fire-and-forget (never blocks the
 * response). Attribution: the capturing agent (Tier-1 indexer). Communal-domain
 * + takedown/ownership gates inside publishSkill remain the reactive remedy.
 */
export async function autoIndexFromReveng(
  env: Env,
  endpoints: EndpointDescriptor[],
  agentId: string,
): Promise<void> {
  const byDomain = new Map<string, EndpointDescriptor[]>();
  for (const ep of endpoints) {
    let host: string;
    try { host = new URL(ep.url_template).hostname.replace(/^www\./, ""); } catch { continue; }
    if (!host) continue;
    const arr = byDomain.get(host) ?? [];
    arr.push(ep);
    byDomain.set(host, arr);
  }
  for (const [domain, eps] of byDomain) {
    try {
      // Server-authoritative safety chain — IDENTICAL to /skills, never trust the
      // (already-obfuscated) input. A residual leak skips the domain entirely.
      const { endpoints: scrubbed } = enforcePublishSanitization(eps as unknown[]);
      if (detectResidualSecretLeak(scrubbed).length > 0) continue;
      const ai = await aiScrubEndpoints(scrubbed, env);
      if (ai.rejected) continue;
      const draft = {
        schema_version: "1",
        name: domain,
        intent_signature: domain,
        domain,
        description: `Routes auto-indexed from a live capture of ${domain}.`,
        owner_type: "agent" as const,
        execution_type: "http" as const,
        endpoints: ai.endpoints as unknown as EndpointDescriptor[],
        lifecycle: "active" as const,
      };
      if (!validateSkillManifest(draft).valid) continue;
      await publishSkill(env, draft, { submitter_agent_id: agentId, transport: "auto-reveng" });
    } catch (err) {
      console.warn(`[reveng] auto-index ${domain} skipped: ${(err as Error).message}`);
    }
  }
}

revengRoutes.post("/reveng", indexContributorAuth, requireSignedClient, execTokenGate(), async (c) => {
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
    const { endpoints, holes } = revengWithHoles(capture as RawRequest[]);
    // PASSIVE auto-index: grow the route graph from THIS capture (off the response
    // path, best-effort). The capturing agent is the Tier-1 indexer; the safety
    // chain + communal/takedown gates inside autoIndexFromReveng/publishSkill apply.
    const agentId = c.get("agent_id") as string | undefined;
    if (agentId && endpoints.length > 0) {
      // Start it now (best-effort); register with waitUntil so the Worker stays
      // alive until it finishes. c.executionCtx THROWS when absent (tests / some
      // runtimes) — guard the access so the route never 500s on its account.
      const indexing = autoIndexFromReveng(c.env, endpoints, agentId).catch(() => {});
      try { c.executionCtx.waitUntil(indexing); } catch { /* no ExecutionContext — runs detached */ }
    }
    return c.json({ endpoints, holes, count: endpoints.length });
  } catch (err) {
    console.error("[reveng] extract failed:", (err as Error).message);
    return c.json({ error: "reveng failed", degraded: true }, 500);
  }
});
