import type { FastifyInstance } from "fastify";
import { resolveAndExecute } from "../orchestrator/index.js";
import { publishSkill, getSkill, listSkills } from "../marketplace/index.js";
import { updateEndpointScore } from "../marketplace/index.js";
import { validateSkillManifest } from "../validator/index.js";
import { executeSkill } from "../execution/index.js";
import { interactiveLogin } from "../auth/index.js";
import { recordFeedback } from "../scoring/index.js";
import { ROUTE_LIMITS } from "../ratelimit/index.js";
import type { ProjectionOptions } from "../types/index.js";
import { writeFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const TRACES_DIR = process.env.TRACES_DIR ?? join(process.cwd(), "traces");

export async function registerRoutes(app: FastifyInstance) {
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
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/skills -- publish
  app.post("/v1/skills", { config: { rateLimit: ROUTE_LIMITS["/v1/skills"] } }, async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const validation = validateSkillManifest(body);
    if (!validation.valid) {
      return reply.code(422).send({ error: "Validation failed", details: validation.hardErrors });
    }
    try {
      const skill = await publishSkill(body as Parameters<typeof publishSkill>[0]);
      return reply.code(201).send({
        skill_id: skill.skill_id,
        version: skill.version,
        warnings: validation.softWarnings,
      });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // GET /v1/skills
  app.get("/v1/skills", async (_req, reply) => {
    return reply.send({ skills: listSkills() });
  });

  // GET /v1/skills/:skill_id
  app.get("/v1/skills/:skill_id", async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const skill = getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    return reply.send(skill);
  });

  // POST /v1/skills/:skill_id/execute
  app.post("/v1/skills/:skill_id/execute", { config: { rateLimit: ROUTE_LIMITS["/v1/skills/:skill_id/execute"] } }, async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const { params, projection, confirm_unsafe, dry_run } = req.body as {
      params?: Record<string, unknown>;
      projection?: ProjectionOptions;
      confirm_unsafe?: boolean;
      dry_run?: boolean;
    };
    const skill = getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    try {
      const execResult = await executeSkill(skill, params ?? {}, projection, { confirm_unsafe, dry_run });
      saveTrace(execResult.trace);
      return reply.send(execResult);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/feedback
  app.post("/v1/feedback", { config: { rateLimit: ROUTE_LIMITS["/v1/feedback"] } }, async (req, reply) => {
    const feedback = req.body as {
      target_type: string;
      target_id: string;
      endpoint_id?: string;
      execution_trace_id?: string;
      outcome: string;
      rating?: number;
      notes?: string;
    };
    if (!feedback.target_id || !feedback.outcome) {
      return reply.code(400).send({ error: "target_id and outcome required" });
    }
    saveFeedback(feedback);

    // Wire into scoring engine if rating provided
    if (feedback.rating != null && feedback.endpoint_id) {
      const avgRating = recordFeedback(
        feedback.target_id,
        feedback.endpoint_id,
        feedback.rating,
        updateEndpointScore
      );
      return reply.send({ ok: true, avg_rating: avgRating });
    }
    return reply.send({ ok: true });
  });

  // GET /v1/feedback/:target_id
  app.get("/v1/feedback/:target_id", async (req, reply) => {
    const { target_id } = req.params as { target_id: string };
    const feedbackEntries = loadFeedback(target_id);
    return reply.send({ target_id, feedback: feedbackEntries });
  });

  // GET /health
  app.get("/health", async (_req, reply) => reply.send({ status: "ok" }));

  // GET /v1/skills/:skill_id/endpoints/:endpoint_id/schema
  app.get("/v1/skills/:skill_id/endpoints/:endpoint_id/schema", async (req, reply) => {
    const { skill_id, endpoint_id } = req.params as { skill_id: string; endpoint_id: string };
    const skill = getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpoint_id);
    if (!endpoint) return reply.code(404).send({ error: "Endpoint not found" });
    if (!endpoint.response_schema) return reply.code(404).send({ error: "No schema available" });
    return reply.send(endpoint.response_schema);
  });

  // POST /v1/auth/login — interactive OAuth flow
  app.post("/v1/auth/login", { config: { rateLimit: ROUTE_LIMITS["/v1/auth/login"] } }, async (req, reply) => {
    const { url } = req.body as { url: string };
    if (!url) return reply.code(400).send({ error: "url required" });
    try {
      const result = await interactiveLogin(url);
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // GET /v1/debug/search — test EmergentDB search from server context
  app.get("/v1/debug/search", async (req, reply) => {
    const { intent = "get trending searches" } = req.query as { intent?: string };
    try {
      const { searchIntent } = await import("../discovery/index.js");
      const results = await searchIntent(intent, 3);
      return reply.send({ ok: true, results });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // POST /v1/skills/:skill_id/verify — trigger verification
  app.post("/v1/skills/:skill_id/verify", async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const skill = getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    try {
      const { verifySkill } = await import("../verification/index.js");
      const results = await verifySkill(skill);
      return reply.send({ skill_id, verification: results });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}

function saveTrace(trace: unknown) {
  if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true });
  const t = trace as { trace_id: string };
  writeFileSync(join(TRACES_DIR, `${t.trace_id}.json`), JSON.stringify(trace, null, 2));
}

function saveFeedback(feedback: unknown) {
  if (!existsSync(TRACES_DIR)) mkdirSync(TRACES_DIR, { recursive: true });
  const id = `feedback-${Date.now()}`;
  writeFileSync(join(TRACES_DIR, `${id}.json`), JSON.stringify(feedback, null, 2));
}

function loadFeedback(targetId: string): unknown[] {
  if (!existsSync(TRACES_DIR)) return [];
  return readdirSync(TRACES_DIR)
    .filter((f) => f.startsWith("feedback-"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(TRACES_DIR, f), "utf8")) as Record<string, unknown>;
      } catch { return null; }
    })
    .filter((f): f is Record<string, unknown> => f != null && f.target_id === targetId);
}
