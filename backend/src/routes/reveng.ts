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
): Promise<{ published_skills: string[]; indexed_endpoints: number }> {
  const published_skills: string[] = [];
  let indexed_endpoints = 0;
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
      const skill = await publishSkill(env, draft, { submitter_agent_id: agentId, transport: "auto-reveng" });
      published_skills.push(skill.skill_id);
      indexed_endpoints += draft.endpoints.length;
    } catch (err) {
      console.warn(`[reveng] auto-index ${domain} skipped: ${(err as Error).message}`);
    }
  }
  return { published_skills, indexed_endpoints };
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

/**
 * /v1/skills/from-routes — the client flywheel's missing other half. The CLI's
 * `publishObservedRoutes` (fed by `act fetch --publish` / UNBROWSE_PUBLISH_OBSERVED_ROUTES)
 * POSTs the routes it observed during a fetch/run here; this turns them into
 * endpoint specs (the SAME obfuscate→extractEndpoints pass as /reveng) and publishes
 * the confident ones — so the route graph grows from ordinary usage WITHOUT a browser
 * capture session. Until now this endpoint did not exist (the client POSTed to a 404),
 * so observed routes were silently dropped and the index never filled from usage.
 * Same safety chain + communal/takedown gates as /reveng's auto-index.
 */
type ObservedRoute = { url?: string; final_url?: string; method?: string; status?: number; content_type?: string; body_excerpt?: string };
revengRoutes.post("/skills/from-routes", indexContributorAuth, requireSignedClient, execTokenGate(), async (c) => {
  let body: { routes?: ObservedRoute[]; target_origin?: string; intent?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
  const routes = Array.isArray(body.routes) ? body.routes : [];
  if (routes.length === 0) return c.json({ ok: true, indexed_count: 0, reason: "no routes" });
  if (routes.length > 5000) return c.json({ error: "too many routes (max 5000)" }, 413);
  const rawRequests: RawRequest[] = routes
    .filter((r) => typeof r.url === "string" || typeof r.final_url === "string")
    .map((r): RawRequest => ({
      url: (r.final_url || r.url) as string,
      method: (r.method || "GET").toUpperCase(),
      request_headers: {},
      response_status: typeof r.status === "number" ? r.status : 200,
      response_headers: r.content_type ? { "content-type": r.content_type } : {},
      response_body: r.body_excerpt,
      timestamp: new Date().toISOString(),
    }));
  try {
    const endpoints = revengObfuscatedCapture(rawRequests); // obfuscate (strip secrets) + extractEndpoints
    if (endpoints.length === 0) {
      return c.json({ ok: true, indexed_count: 0, total_endpoints: 0, reason: "no api-like endpoints in routes" });
    }
    const agentId = (c.get("agent_id") as string | undefined) ?? "__anon__";
    const result = await autoIndexFromReveng(c.env, endpoints, agentId);
    return c.json({
      ok: true,
      skill_id: result.published_skills[0],
      published_skills: result.published_skills,
      indexed_count: result.indexed_endpoints,
      total_endpoints: endpoints.length,
      publish_status: result.published_skills.length > 0 ? "published" : "skipped",
    });
  } catch (err) {
    console.error("[skills/from-routes] failed:", (err as Error).message);
    return c.json({ error: "from_routes failed", degraded: true }, 500);
  }
});
