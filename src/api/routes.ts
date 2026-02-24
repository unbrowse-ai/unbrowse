import type { FastifyInstance } from "fastify";
import { resolveAndExecute } from "../orchestrator/index.js";
import { getSkill } from "../marketplace/index.js";
import { executeSkill, rankEndpoints } from "../execution/index.js";
import { storeCredential } from "../vault/index.js";
import { interactiveLogin } from "../auth/index.js";
import { publishSkill } from "../marketplace/index.js";
import { recordFeedback, getApiKey } from "../client/index.js";
import { ROUTE_LIMITS } from "../ratelimit/index.js";
import type { ProjectionOptions } from "../types/index.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const BETA_API_URL = "https://beta-api.unbrowse.ai";

const TRACES_DIR = process.env.TRACES_DIR ?? join(process.cwd(), "traces");

export async function registerRoutes(app: FastifyInstance) {
  // Auth gate: block all routes except /health when no API key is configured
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;

    const key = getApiKey();
    if (!key) {
      return reply.code(401).send({
        error: "api_key_required",
        message: "No API key configured. Restart the server to auto-register, or run: bash scripts/setup.sh",
        docs_url: "https://unbrowse.ai",
      });
    }
  });

  // POST /v1/intent/resolve
  app.post("/v1/intent/resolve", { config: { rateLimit: ROUTE_LIMITS["/v1/intent/resolve"] } }, async (req, reply) => {
    const { intent, params, context, projection, confirm_unsafe, dry_run } = req.body as {
      intent: string;
      params?: Record<string, unknown>;
      context?: { url?: string; domain?: string };
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      dry_run?: boolean;
    };
    if (!intent) return reply.code(400).send({ error: "intent required" });
    try {
      const result = await resolveAndExecute(intent, params ?? {}, context, projection, { confirm_unsafe, dry_run });

      // Surface ranked endpoints so the calling agent can pick a better one
      const skill = result.skill;
      const res = result as unknown as Record<string, unknown>;
      if (skill?.endpoints && skill.endpoints.length > 1) {
        const ranked = rankEndpoints(skill.endpoints, intent, skill.domain);
        res.available_endpoints = ranked.slice(0, 5).map((r) => ({
          endpoint_id: r.endpoint.endpoint_id,
          method: r.endpoint.method,
          url: r.endpoint.url_template.length > 120 ? r.endpoint.url_template.slice(0, 120) + "..." : r.endpoint.url_template,
          score: Math.round(r.score * 10) / 10,
          has_schema: !!r.endpoint.response_schema,
          dom_extraction: !!r.endpoint.dom_extraction,
        }));
      }

      // Surface timing breakdown
      if (result.timing) {
        res.timing = result.timing;
      }

      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/skills/:skill_id/execute
  app.post("/v1/skills/:skill_id/execute", { config: { rateLimit: ROUTE_LIMITS["/v1/skills/:skill_id/execute"] } }, async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const { params, projection, confirm_unsafe, dry_run, intent } = req.body as {
      params?: Record<string, unknown>;
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      dry_run?: boolean;
      intent?: string;
    };
    const skill = await getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    try {
      const execResult = await executeSkill(skill, params ?? {}, projection, { confirm_unsafe, dry_run, intent });
      saveTrace(execResult.trace);
      return reply.send(execResult);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/skills/:skill_id/auth -- store credentials (cookies/headers) for a skill
  app.post("/v1/skills/:skill_id/auth", async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const skill = await getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });

    const body = req.body as {
      cookies?: Array<{ name: string; value: string; domain: string; path?: string }>;
      headers?: Record<string, string>;
    };
    if (!body.cookies && !body.headers) {
      return reply.code(400).send({ error: "Provide cookies or headers" });
    }

    const ref = `${skill.domain}-session`;
    await storeCredential(ref, JSON.stringify({ cookies: body.cookies ?? [], headers: body.headers ?? {} }));

    // Patch the skill manifest to reference the stored credentials
    if (!skill.auth_profile_ref) {
      await publishSkill({ ...skill, auth_profile_ref: ref });
    }

    return reply.send({ ok: true, auth_profile_ref: ref });
  });

  // POST /v1/auth/login — interactive OAuth flow
  app.post("/v1/auth/login", { config: { rateLimit: ROUTE_LIMITS["/v1/auth/login"] } }, async (req, reply) => {
    const { url, yolo } = req.body as { url: string; yolo?: boolean };
    if (!url) return reply.code(400).send({ error: "url required" });
    try {
      const result = await interactiveLogin(url, undefined, { yolo });
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/skills/:skill_id/verify — trigger verification
  app.post("/v1/skills/:skill_id/verify", async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const skill = await getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    try {
      const { verifySkill } = await import("../verification/index.js");
      const results = await verifySkill(skill);
      return reply.send({ skill_id, verification: results });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/feedback — submit execution feedback (proxies to backend)
  app.post("/v1/feedback", async (req, reply) => {
    const { skill_id, target_id, endpoint_id, rating, outcome } = req.body as {
      skill_id?: string;
      target_id?: string;
      endpoint_id?: string;
      rating?: number;
      outcome?: string;
    };
    const resolvedSkillId = skill_id ?? target_id;
    if (!resolvedSkillId || !endpoint_id || rating == null) {
      return reply.code(400).send({ error: "skill_id, endpoint_id, and rating required" });
    }
    try {
      const avg_rating = await recordFeedback(resolvedSkillId, endpoint_id, rating);
      return reply.send({ ok: true, avg_rating });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // GET /health
  app.get("/health", async (_req, reply) => reply.send({ status: "ok" }));

  // Catch-all proxy: forward unmatched /v1/* routes to beta-api.unbrowse.ai
  app.all("/v1/*", async (req, reply) => {
    const key = getApiKey();
    const upstream = `${BETA_API_URL}${req.url}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    try {
      const res = await fetch(upstream, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
      });
      const text = await res.text();
      try {
        return reply.code(res.status).send(JSON.parse(text));
      } catch {
        return reply.code(res.status).send({ error: text || `Upstream returned ${res.status}` });
      }
    } catch (err) {
      return reply.code(502).send({ error: `Proxy to beta-api failed: ${(err as Error).message}` });
    }
  });
}

function saveTrace(trace: unknown) {
  if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true });
  const t = trace as { trace_id: string };
  writeFileSync(join(TRACES_DIR, `${t.trace_id}.json`), JSON.stringify(trace, null, 2));
}
