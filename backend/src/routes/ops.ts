import { Hono } from "hono";
import type { Env, SkillManifest } from "../types.js";
import { listSkills, mergeEndpoints, publishSkill, deprecateSkill } from "../services/marketplace.js";
import { listAgents, countAgents } from "../services/agents.js";
import { reindexSkill, removeSkillFromIndex, purgeSkillVectors } from "../services/discovery.js";
import { backfillFromProfiles } from "../services/analytics.js";
import { summarizeEmergentDBError } from "../services/emergentdb.js";
import { skillsKV, statsKV } from "../services/kv.js";
import { bearerAuth } from "../middleware/auth.js";

export const opsRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

/**
 * GET /v1/ops — single endpoint for the ops dashboard.
 * Returns stats + skills + agents in one Worker invocation so the
 * qdkv index cache is shared across all three reads.
 */
opsRoutes.get("/ops", bearerAuth, async (c) => {
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
 * Reads every skill from KV, re-embeds via Nebius, inserts into both
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

// Debug: check what Nebius embedding returns (staging only)
opsRoutes.get("/ops/debug-embed", async (c) => {
  if (c.env.ENVIRONMENT !== "staging") return c.json({ error: "staging only" }, 403);
  const res = await fetch("https://api.tokenfactory.nebius.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.env.NEBIUS_API_KEY}` },
    body: JSON.stringify({ model: "Qwen/Qwen3-Embedding-8B", input: "get upcoming events", dimensions: 4096 }),
  });
  const data = await res.json() as { data?: Array<{ embedding?: number[] }>; error?: string; detail?: string };
  const dims = data.data?.[0]?.embedding?.length ?? 0;
  return c.json({ dims, error: data.error ?? data.detail ?? null, raw_keys: Object.keys(data) });
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
      results.push({ skill_id: skill.skill_id, domain: skill.domain, ok: false, error: summarizeEmergentDBError(err) });
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

/**
 * POST /v1/ops/consolidate — merge all skills for a domain into one canonical skill.
 * Finds all active skills matching the domain, merges their endpoints into the first one,
 * deprecates the rest, and re-indexes. Admin-only.
 */
opsRoutes.post("/ops/consolidate", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }

  const { domain } = await c.req.json<{ domain?: string }>();
  if (!domain) return c.json({ error: "domain required" }, 400);

  const skills = await listSkills(c.env);
  const domainSkills = skills.filter((s) => s.domain === domain && s.lifecycle === "active");

  if (domainSkills.length <= 1) {
    return c.json({ message: `${domain} already consolidated`, skills: domainSkills.length });
  }

  // Sort by endpoint count descending — use the richest skill as the canonical one
  domainSkills.sort((a, b) => b.endpoints.length - a.endpoints.length);
  const canonical = domainSkills[0];
  const deprecated: string[] = [];

  // Merge endpoints from all other skills into canonical
  let merged = canonical.endpoints;
  const intents = new Set<string>(canonical.intents ?? []);
  for (const other of domainSkills.slice(1)) {
    merged = mergeEndpoints(merged, other.endpoints);
    if (other.intent_signature && other.intent_signature !== domain) {
      intents.add(other.intent_signature);
    }
    await deprecateSkill(c.env, other.skill_id);
    deprecated.push(other.skill_id);
  }

  // Publish consolidated skill
  const consolidated = await publishSkill(c.env, {
    ...canonical,
    endpoints: merged,
    name: domain,
    intent_signature: domain,
    intents: Array.from(intents),
  });

  return c.json({
    domain,
    canonical_skill_id: consolidated.skill_id,
    endpoints: consolidated.endpoints.length,
    deprecated_skill_ids: deprecated,
    intents: Array.from(intents),
  });
});

/**
 * POST /v1/ops/purge-reindex — nuclear option: delete ALL vectors from the graph
 * index, then re-index only active skills from current DB state.
 *
 * Fixes stale vecdb entries pointing to endpoints that no longer exist on skills.
 * Processes in batches (default 3) to stay within CF Worker limits.
 * Call repeatedly with increasing offset until has_more is false.
 *
 * Admin-only.
 */
opsRoutes.post("/ops/purge-reindex", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }

  const body = await c.req.json<{ limit?: number; offset?: number; purge_only?: boolean }>().catch(() => ({} as { limit?: number; offset?: number; purge_only?: boolean }));
  const limit = body.limit ?? 3;
  const offset = body.offset ?? 0;

  const allSkills = await listSkills(c.env);
  const batch = allSkills.slice(offset, offset + limit);

  const purgeResults: Array<{ skill_id: string; domain: string; endpoints_purged: number }> = [];
  const indexResults: Array<{ skill_id: string; domain: string; ok: boolean; error?: string }> = [];

  for (const skill of batch) {
    // Step 1: purge all vectors for this skill (active or not)
    const endpointIds = skill.endpoints.map((e: { endpoint_id: string }) => e.endpoint_id);
    const { deleted } = await purgeSkillVectors(c.env, skill.skill_id, endpointIds, skill.domain);
    purgeResults.push({ skill_id: skill.skill_id, domain: skill.domain, endpoints_purged: deleted });

    // Step 2: re-index only if active and not purge_only mode
    if (!body.purge_only && skill.lifecycle === "active") {
      try {
        await reindexSkill(c.env, skill);
        indexResults.push({ skill_id: skill.skill_id, domain: skill.domain, ok: true });
      } catch (err) {
        indexResults.push({ skill_id: skill.skill_id, domain: skill.domain, ok: false, error: summarizeEmergentDBError(err) });
      }
    }
  }

  const hasMore = offset + limit < allSkills.length;
  const activeCount = allSkills.filter((s) => s.lifecycle === "active").length;

  return c.json({
    total_skills: allSkills.length,
    active_skills: activeCount,
    batch_offset: offset,
    batch_limit: limit,
    processed: batch.length,
    purged: purgeResults,
    reindexed: indexResults,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
  });
});

/**
 * POST /v1/ops/backfill-analytics — seed cohort + active-day data from existing agent profiles.
 * Safe to run multiple times. Admin-only.
 */
opsRoutes.post("/ops/backfill-analytics", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  const result = await backfillFromProfiles(c.env);
  return c.json(result);
});
