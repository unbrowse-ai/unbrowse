import { Hono } from "hono";
import type { Env, SkillManifest } from "../types.js";
import { listSkills } from "../services/marketplace.js";
import { listAgents, countAgents } from "../services/agents.js";
import { reindexSkill, removeSkillFromIndex } from "../services/discovery.js";
import { skillsKV, statsKV } from "../services/kv.js";
import { bearerAuth } from "../middleware/auth.js";

export const opsRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

/**
 * GET /v1/ops — single endpoint for the ops dashboard.
 * Returns stats + skills + agents in one Worker invocation so the
 * qdkv index cache is shared across all three reads.
 */
opsRoutes.get("/ops", async (c) => {
  const [skillEntries, statEntries, skills, agents] = await Promise.all([
    skillsKV(c.env).listWithValues("skill:"),
    statsKV(c.env).listWithValues("stats:"),
    listSkills(c.env),
    listAgents(c.env, 50),
  ]);

  let endpointCount = 0;
  const domainSet = new Set<string>();
  let totalExecutions = 0;

  for (const { value } of skillEntries) {
    try {
      const s = JSON.parse(value) as { endpoints?: unknown[]; domain?: string };
      endpointCount += s.endpoints?.length ?? 0;
      if (s.domain) domainSet.add(s.domain);
    } catch { /* skip */ }
  }
  for (const { value } of statEntries) {
    try {
      totalExecutions += (JSON.parse(value) as { total_executions?: number }).total_executions ?? 0;
    } catch { /* skip */ }
  }

  const agentCount = await countAgents(c.env);

  c.header("Cache-Control", "public, max-age=30");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({
    stats: {
      skills: skillEntries.length,
      endpoints: endpointCount,
      domains: domainSet.size,
      executions: totalExecutions,
      agents: agentCount,
    },
    skills,
    agents,
  });
});

/**
 * POST /v1/ops/reindex — re-index all active skills into vector store.
 * Reads every skill from KV, re-embeds via Gemini, inserts into both
 * global and domain vector namespaces. Admin-only.
 *
 * CF Workers have a 30s CPU limit, so we process skills sequentially
 * to stay within subrequest budgets. For large registries, consider
 * batching with a cursor param.
 */
/**
 * POST /v1/ops/migrate-index — reset stale split indexes so the legacy
 * _idx is re-read and properly migrated with inline values.
 * One-time use after the split-index migration. Admin-only.
 */
opsRoutes.post("/ops/migrate-index", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }

  // Reset both namespaces
  await Promise.all([
    skillsKV(c.env).resetSplitIndex(),
    statsKV(c.env).resetSplitIndex(),
  ]);

  return c.json({ ok: true, message: "Split indexes deleted. Next read will re-migrate from legacy _idx." });
});

opsRoutes.post("/ops/reindex", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }

  const body = await c.req.json<{ purge_skill_ids?: string[]; limit?: number; offset?: number }>().catch(() => ({} as { purge_skill_ids?: string[]; limit?: number; offset?: number }));

  const limit = body.limit ?? 3;
  const offset = body.offset ?? 0;

  const skills = await listSkills(c.env);
  const active = skills.filter((s) => s.lifecycle === "active" && s.intent_signature);
  const activeIds = new Set(active.map((s) => s.skill_id));

  // Purge stale vectors for skill IDs not in active KV set
  const purged: string[] = [];
  if (body.purge_skill_ids) {
    for (const staleId of body.purge_skill_ids) {
      if (activeIds.has(staleId)) continue; // don't purge active skills
      try {
        await removeSkillFromIndex(c.env, staleId, "unknown");
        purged.push(staleId);
      } catch { /* best effort */ }
    }
  }

  const batch = active.slice(offset, offset + limit);
  const results: Array<{ skill_id: string; domain: string; ok: boolean; error?: string }> = [];

  // Process sequentially to stay within CF Worker limits
  for (const skill of batch) {
    try {
      await reindexSkill(c.env, skill);
      results.push({ skill_id: skill.skill_id, domain: skill.domain, ok: true });
    } catch (err) {
      results.push({ skill_id: skill.skill_id, domain: skill.domain, ok: false, error: (err as Error).message });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const hasMore = offset + limit < active.length;

  return c.json({
    total_active: active.length,
    batch_offset: offset,
    batch_limit: limit,
    processed: batch.length,
    succeeded,
    failed,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
    skipped: skills.length - active.length,
    purged,
    results,
  });
});

