import { Hono } from "hono";
import type { Env, SkillManifest } from "../types.js";
import { listSkills, mergeEndpoints, publishSkill, deprecateSkill, removeDomainFromMarketplace } from "../services/marketplace.js";
import { listAgents, countAgents } from "../services/agents.js";
import { reindexSkill, removeSkillFromIndex, purgeSkillVectors } from "../services/discovery.js";
import { backfillFromProfiles } from "../services/analytics.js";
import { summarizeEmergentDBError } from "../services/emergentdb.js";
import { skillsKV, statsKV, EdbKV } from "../services/kv.js";
import { bearerAuth } from "../middleware/auth.js";
import { deleteHttpCache } from "../services/http-cache.js";

export const opsRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

/**
 * GET /v1/ops — single endpoint for the ops dashboard.
 * Returns stats + skills + agents in one Worker invocation so the
 * qdkv index cache is shared across all three reads.
 */
opsRoutes.get("/ops", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
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

  // dry_run accepts ?dry_run=1 (query) or { dry_run: true } (body). Returns
  // the projected batch + total count without touching the vector store, so
  // operators can preview a sweep before paying the EmergentDB cost.
  const queryDryRun = c.req.query("dry_run");
  const body = await c.req.json<{
    purge_skill_ids?: string[];
    limit?: number;
    offset?: number;
    dry_run?: boolean;
  }>().catch(() => ({} as {
    purge_skill_ids?: string[];
    limit?: number;
    offset?: number;
    dry_run?: boolean;
  }));

  const dryRun = body.dry_run === true || queryDryRun === "1" || queryDryRun === "true";

  const limit = body.limit ?? 3;
  const offset = body.offset ?? 0;

  const skills = await listSkills(c.env);
  const active = skills.filter((s) => s.lifecycle === "active" && s.intent_signature);
  const activeIds = new Set(active.map((s) => s.skill_id));

  // Purge stale vectors for skill IDs not in active KV set
  const purged: string[] = [];
  if (body.purge_skill_ids && !dryRun) {
    for (const staleId of body.purge_skill_ids) {
      if (activeIds.has(staleId)) continue; // don't purge active skills
      try {
        await removeSkillFromIndex(c.env, staleId, "unknown");
        purged.push(staleId);
      } catch { /* best effort */ }
    }
  }

  const batch = active.slice(offset, offset + limit);

  if (dryRun) {
    // No writes — emit the projection only.
    return c.json({
      dry_run: true,
      total_active: active.length,
      batch_offset: offset,
      batch_limit: limit,
      projected: batch.map((s) => ({ skill_id: s.skill_id, domain: s.domain })),
      skipped: skills.length - active.length,
      has_more: offset + limit < active.length,
      next_offset: offset + limit < active.length ? offset + limit : null,
    });
  }

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
 * POST /v1/ops/remove-domain — hide all marketplace records for a domain.
 * Disables matching skills, removes domain/intent aliases, purges vectors, and
 * clears public aggregate caches. Admin-only.
 */
opsRoutes.post("/ops/remove-domain", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }

  const body: { domain?: string; dry_run?: boolean } = await c.req.json<{ domain?: string; dry_run?: boolean }>().catch(() => ({}));
  const domain = body.domain?.trim().toLowerCase();
  if (!domain) return c.json({ error: "domain required" }, 400);

  try {
    const result = await removeDomainFromMarketplace(c.env, domain, { dryRun: body.dry_run === true });
    if (!result.dry_run) {
      await Promise.all([
        deleteHttpCache(c.env, "miners:stats"),
        statsKV(c.env).delete(`bm25-idx:v2-${result.domain}`).catch(() => {}),
      ]);
    }
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "remove_domain_failed";
    return c.json({ error: message }, message === "invalid_domain" ? 400 : 500);
  }
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

/**
 * POST /v1/ops/migrate-pgkv-to-edb — port PgKV (Neon) rows into EmergentDB qdkv.
 *
 * Contract e65c7118. The Worker has DATABASE_URL + EMERGENTDB_API_KEY bound,
 * which lets us run the migration server-side without exposing those secrets
 * to a developer machine. Idempotent (qdkv/set is upsert); resumable via the
 * `offset` body field.
 *
 * Body:
 *   - dry_run    (bool, default false) — count rows, no writes
 *   - namespace  (string, optional)    — limit to one namespace
 *   - offset     (int, default 0)      — start cursor across namespaces
 *   - max_rows   (int, default 500)    — soft cap per call (CF Worker CPU budget)
 *
 * Returns { namespaces: [{name, total, written, failed, examples_failed}],
 *           next_offset, has_more, written_total, failed_total }
 *
 * Auth: bearerAuth + agent_id === "__admin__" (same as /v1/ops/reindex).
 */
type MigBody = {
  dry_run?: boolean;
  namespace?: string;
  offset?: number;
  max_rows?: number;
};
opsRoutes.post("/ops/migrate-pgkv-to-edb", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  if (agentId !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  if (!c.env.DATABASE_URL?.trim()) {
    return c.json({ error: "DATABASE_URL not bound on this worker" }, 400);
  }
  if (!c.env.EMERGENTDB_API_KEY?.trim()) {
    return c.json({ error: "EMERGENTDB_API_KEY not bound on this worker" }, 400);
  }

  const body: MigBody = (await c.req.json<MigBody>().catch(() => ({} as MigBody))) as MigBody;
  const dryRun = Boolean(body.dry_run);
  const namespaceFilter = (body.namespace ?? "").trim() || null;
  const offset = Math.max(0, Number.isFinite(body.offset) ? Number(body.offset) : 0);
  const maxRows = Math.min(2000, Math.max(50, Number.isFinite(body.max_rows) ? Number(body.max_rows) : 500));

  const { getNeonClient } = await import("../services/neon.js");
  const sql = await getNeonClient(c.env.DATABASE_URL);

  type NsRow = { namespace: string; n: number };
  const allRows = (await sql`
    SELECT namespace, COUNT(*)::int AS n
    FROM app_kv
    GROUP BY namespace
    ORDER BY namespace
  `) as Array<NsRow>;
  const targets = namespaceFilter
    ? allRows.filter((r) => r.namespace === namespaceFilter)
    : allRows;

  if (targets.length === 0) {
    return c.json({
      error: "no_namespaces_to_migrate",
      filter: namespaceFilter,
      all_namespaces: allRows,
    }, 404);
  }

  if (dryRun) {
    return c.json({
      dry_run: true,
      all_namespaces: allRows,
      targets,
      total_rows: targets.reduce((s, r) => s + r.n, 0),
    });
  }

  // Use the EdbKV class — it carries the BUG-011 pre-write size gate
  // (qdkv/set returns {ok:true} for values > 10KB but silently drops them).
  // Going via raw fetch here would re-introduce the silent-drop on large
  // skill manifests; routing through EdbKV makes the failure LOUD.
  // EmergentDB rate-limits CF Worker traffic per-isolate; we still chunk
  // the writes to stay under the CPU budget.
  const namespaceResults: Array<{
    namespace: string;
    total: number;
    written: number;
    failed: number;
    oversize: number;
    examples_failed: string[];
  }> = [];

  let remaining = maxRows;
  let cursorOffset = offset;
  let hasMore = false;
  let nextOffset = offset;

  let consumed = 0;
  for (const ns of targets) {
    if (remaining <= 0) { hasMore = true; break; }
    if (cursorOffset >= consumed + ns.n) {
      consumed += ns.n;
      continue;
    }
    const intraOffset = Math.max(0, cursorOffset - consumed);
    const take = Math.min(remaining, ns.n - intraOffset);

    const rows = (await sql`
      SELECT key, value
      FROM app_kv
      WHERE namespace = ${ns.namespace}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY key
      OFFSET ${intraOffset}
      LIMIT ${take}
    `) as Array<{ key: string; value: string }>;

    // Instantiate EdbKV per-namespace — its put() carries the BUG-011 size
    // gate (refuses to send > EMERGENTDB_MAX_VALUE_BYTES, default 10 KB).
    // qdkv/set returns ok:true even on silent-drop above the limit, so
    // raw-fetch writes would report success while losing the data.
    const edb = new EdbKV(c.env.EMERGENTDB_API_KEY, ns.namespace);
    let written = 0;
    let failed = 0;
    let oversize = 0;
    const examplesFailed: string[] = [];
    // CHUNK_SIZE=6 stays gentle on EmergentDB's per-isolate rate limit
    // (empirically 16 → 50% 429s; 6 → near-zero 429s). 429 retry once.
    const CHUNK_SIZE = 6;
    const writeOne = async (row: { key: string; value: string }): Promise<{ ok: true } | { ok: false; reason: string; oversize?: boolean }> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await edb.put(row.key, row.value);
          return { ok: true };
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("value_too_large")) {
            return { ok: false, reason: msg.slice(0, 80), oversize: true };
          }
          if (msg.includes("429") && attempt === 0) {
            await new Promise((res) => setTimeout(res, 250));
            continue;
          }
          if (attempt === 0) {
            await new Promise((res) => setTimeout(res, 250));
            continue;
          }
          return { ok: false, reason: msg.slice(0, 80) };
        }
      }
      return { ok: false, reason: "retry exhausted" };
    };
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const results = await Promise.allSettled(chunk.map(async (row) => ({ row, res: await writeOne(row) })));
      for (const settled of results) {
        if (settled.status === "fulfilled") {
          const { row, res } = settled.value;
          if (res.ok) {
            written++;
          } else {
            failed++;
            if (res.oversize) oversize++;
            if (examplesFailed.length < 5) {
              examplesFailed.push(`${row.key.slice(0, 60)} :: ${res.reason}`);
            }
          }
        } else {
          failed++;
          if (examplesFailed.length < 5) {
            examplesFailed.push(`network :: ${String(settled.reason).slice(0, 60)}`);
          }
        }
      }
    }

    namespaceResults.push({
      namespace: ns.namespace,
      total: ns.n,
      written,
      failed,
      oversize,
      examples_failed: examplesFailed,
    });

    consumed += ns.n;
    cursorOffset += rows.length;
    nextOffset = cursorOffset;
    remaining -= rows.length;
    if (intraOffset + rows.length < ns.n) { hasMore = true; break; }
  }

  if (!hasMore) {
    const totalAcrossAll = allRows.reduce((s, r) => s + r.n, 0);
    if (nextOffset < totalAcrossAll) hasMore = true;
  }

  return c.json({
    dry_run: false,
    next_offset: nextOffset,
    has_more: hasMore,
    namespaces: namespaceResults,
    written_total: namespaceResults.reduce((s, r) => s + r.written, 0),
    failed_total: namespaceResults.reduce((s, r) => s + r.failed, 0),
  });
});
