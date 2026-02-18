import type { FastifyInstance } from "fastify";
import { resolveAndExecute } from "../orchestrator/index.js";
import { publishSkill, getSkill, listSkills } from "../marketplace/index.js";
import { validateSkillManifest } from "../validator/index.js";
import { executeSkill } from "../execution/index.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const TRACES_DIR = process.env.TRACES_DIR ?? join(process.cwd(), "traces");

export async function registerRoutes(app: FastifyInstance) {
  // POST /v1/intent/resolve
  app.post("/v1/intent/resolve", async (req, reply) => {
    const { intent, params, context } = req.body as {
      intent: string;
      params?: Record<string, unknown>;
      context?: { url?: string; domain?: string };
    };
    if (!intent) return reply.code(400).send({ error: "intent required" });
    try {
      const result = await resolveAndExecute(intent, params ?? {}, context);
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/skills -- publish
  app.post("/v1/skills", async (req, reply) => {
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
  app.post("/v1/skills/:skill_id/execute", async (req, reply) => {
    const { skill_id } = req.params as { skill_id: string };
    const { params } = req.body as { params?: Record<string, unknown> };
    const skill = getSkill(skill_id);
    if (!skill) return reply.code(404).send({ error: "Skill not found" });
    try {
      const execResult = await executeSkill(skill, params ?? {});
      saveTrace(execResult.trace);
      return reply.send(execResult);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /v1/feedback
  app.post("/v1/feedback", async (req, reply) => {
    const feedback = req.body as {
      target_type: string;
      target_id: string;
      execution_trace_id?: string;
      outcome: string;
      rating?: number;
      notes?: string;
    };
    if (!feedback.target_id || !feedback.outcome) {
      return reply.code(400).send({ error: "target_id and outcome required" });
    }
    saveFeedback(feedback);
    return reply.send({ ok: true });
  });

  // GET /health
  app.get("/health", async (_req, reply) => reply.send({ status: "ok" }));

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
