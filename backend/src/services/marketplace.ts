import { nanoid } from "nanoid";
import type { Env, SkillManifest, EndpointDescriptor } from "../types.js";
import { indexEndpoints, removeSkillFromIndex, removeEndpointsFromIndex } from "./discovery.js";
import { generateDescriptions } from "./descriptions.js";
import { upsertEdges, type GraphEdge, type GraphNode } from "./graph.js";
import { skillsKV } from "./kv.js";

function kvKey(skillId: string): string {
  return `skill:${skillId}`;
}

function domainKey(domain: string): string {
  return `domain-idx:${domain}`;
}

function intentKey(domain: string, intent: string): string {
  return `intent-idx:${domain}:${hashIntent(intent)}`;
}

function hashIntent(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export async function listSkills(env: Env): Promise<SkillManifest[]> {
  const entries = await skillsKV(env).listWithValues("skill:");
  return entries.flatMap(({ value }) => {
    try {
      const skill = JSON.parse(value) as SkillManifest;
      if (!skill.execution_type) skill.execution_type = "http";
      return [skill];
    } catch { return []; }
  });
}

export async function getSkill(env: Env, skillId: string): Promise<SkillManifest | null> {
  const raw = await skillsKV(env).get(kvKey(skillId)) as string | null;
  if (!raw) return null;
  const skill = JSON.parse(raw) as SkillManifest;
  if (!skill.execution_type) skill.execution_type = "http";
  return skill;
}

export async function publishSkill(
  env: Env,
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  }
): Promise<SkillManifest & { index_status: string }> {
  const existing = await findExistingByDomain(env, draft.domain);
  const now = new Date().toISOString();
  let skill: SkillManifest;

  if (existing) {
    const newVersion = bumpMinor(existing.version);
    const mergedEndpoints = mergeEndpoints(existing.endpoints, draft.endpoints);
    // Track which intents contributed endpoints
    const intents = new Set(existing.intents ?? []);
    if (draft.intent_signature && draft.intent_signature !== draft.domain) {
      intents.add(draft.intent_signature);
    }
    skill = {
      ...existing,
      ...draft,
      skill_id: existing.skill_id,
      version: newVersion,
      prev_version: existing.version,
      name: draft.domain,
      intent_signature: draft.domain,
      endpoints: mergedEndpoints,
      intents: Array.from(intents),
      updated_at: now,
      created_at: existing.created_at,
    };
  } else {
    skill = {
      ...draft,
      skill_id: draft.skill_id ?? nanoid(),
      version: draft.version ?? "1.0.0",
      schema_version: "1",
      name: draft.domain,
      intent_signature: draft.domain,
      lifecycle: "active",
      created_at: now,
      updated_at: now,
    } as SkillManifest;
  }

  // Generate LLM descriptions for endpoints that lack them (non-blocking on failure)
  if (skill.endpoints.some((ep) => !ep.description)) {
    try {
      await generateDescriptions(env, skill.endpoints);
    } catch (err) {
      console.error(`[descriptions] failed for ${skill.skill_id}:`, (err as Error).message);
    }
  }

  // putBatch: N parallel sets + 1 idx load + 1 idx save (vs 2 separate puts = 2 loads + 2 saves)
  const kv = skillsKV(env);
  await kv.putBatch([
    { key: kvKey(skill.skill_id), value: JSON.stringify(skill) },
    { key: domainKey(skill.domain), value: skill.skill_id },
  ]);

  const reliabilities = skill.endpoints.map((e) => e.reliability_score);
  const avgReliability = reliabilities.length > 0
    ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
    : 0.5;
  const verifiedCount = skill.endpoints.filter((e) => e.verification_status === "verified").length;
  const verifiedRatio = skill.endpoints.length > 0 ? verifiedCount / skill.endpoints.length : 0;

  // Remove old endpoint vectors that were replaced during merge (if any)
  if (existing) {
    const removedIds = existing.endpoints
      .filter((old) => !skill.endpoints.some((ep) => ep.endpoint_id === old.endpoint_id))
      .map((ep) => ep.endpoint_id);
    if (removedIds.length > 0) {
      removeEndpointsFromIndex(env, skill.skill_id, removedIds, skill.domain).catch(() => {});
    }
  }

  let index_status: string;
  try {
    await indexEndpoints(env, skill.skill_id, skill.endpoints, {
      domain: skill.domain,
      subdomain: skill.subdomain,
      name: skill.name,
      description: skill.description,
      avg_reliability: avgReliability,
      verified_ratio: verifiedRatio,
      updated_at: skill.updated_at,
    });
    index_status = "ok";
  } catch (err) {
    index_status = (err as Error).message;
    console.error(`[indexEndpoints] failed for ${skill.skill_id}:`, index_status);
  }

  // Infer DAG edges from endpoint URL templates and upsert them
  try {
    for (const ep of skill.endpoints) {
      let path: string;
      try { path = new URL(ep.url_template).pathname; } catch { path = ep.url_template; }

      // Extract {param} patterns as requires bindings
      const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

      // Infer action_kind from HTTP method
      const methodKind: Record<string, string> = { GET: "read", POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };
      const actionKind = methodKind[ep.method.toUpperCase()] ?? "read";

      // Infer resource_kind from last meaningful path segment
      const segments = path.split("/").filter((s) => s && !s.startsWith("{"));
      const resourceKind = segments.length > 0 ? segments[segments.length - 1] : undefined;

      // Build node with requires/provides + action/resource kinds
      const node: GraphNode = {
        endpoint_id: ep.endpoint_id,
        requires: params,
        provides: [],
        action_kind: actionKind,
        resource_kind: resourceKind,
        reliability_score: ep.reliability_score,
      };

      // Edges connect this endpoint to others that provide its required params
      // (EmergentDB resolves these via the DAG; we just declare the bindings)
      const edges: GraphEdge[] = params.map((p) => ({ to: "*", binding: p }));

      await upsertEdges(env, skill.domain, node, edges);
    }
  } catch (err) {
    console.error(`[upsertEdges] failed for ${skill.skill_id}:`, (err as Error).message);
  }

  return { ...skill, index_status };
}

export async function deprecateSkill(env: Env, skillId: string): Promise<SkillManifest | null> {
  const skill = await getSkill(env, skillId);
  if (!skill) return null;
  skill.lifecycle = "deprecated";
  skill.updated_at = new Date().toISOString();
  await skillsKV(env).put(kvKey(skillId), JSON.stringify(skill));
  await removeSkillFromIndex(env, skillId, skill.domain).catch(() => {});
  return skill;
}

export async function updateEndpointScore(
  env: Env,
  skillId: string,
  endpointId: string,
  score: number,
  status?: import("../types.js").VerificationStatus
): Promise<void> {
  const skill = await getSkill(env, skillId);
  if (!skill) return;
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  if (!endpoint) return;
  endpoint.reliability_score = score;
  if (status) endpoint.verification_status = status;
  skill.updated_at = new Date().toISOString();
  await skillsKV(env).put(kvKey(skillId), JSON.stringify(skill));

  if (status === "disabled" || status === "failed") {
    const allDead = skill.endpoints.every(
      (e) => e.verification_status === "disabled" || e.verification_status === "failed"
    );
    if (allDead && skill.lifecycle === "active") {
      await deprecateSkill(env, skillId);
    }
  }
}

export async function updateEndpointSchema(
  env: Env,
  skillId: string,
  endpointId: string,
  schema: import("../types.js").ResponseSchema
): Promise<void> {
  const skill = await getSkill(env, skillId);
  if (!skill) return;
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  if (!endpoint) return;
  if (endpoint.response_schema) return; // don't overwrite existing schema
  endpoint.response_schema = schema;
  skill.updated_at = new Date().toISOString();
  await skillsKV(env).put(kvKey(skillId), JSON.stringify(skill));
}

export async function getEndpointSchema(
  env: Env,
  skillId: string,
  endpointId: string
): Promise<import("../types.js").ResponseSchema | null> {
  const skill = await getSkill(env, skillId);
  if (!skill) return null;
  const endpoint = skill.endpoints.find((e) => e.endpoint_id === endpointId);
  return endpoint?.response_schema ?? null;
}

/** Find the canonical domain-level skill, with lazy migration from old intent-idx entries. */
async function findExistingByDomain(
  env: Env,
  domain: string
): Promise<SkillManifest | null> {
  // Primary: domain-level index key
  const existingId = await skillsKV(env).get(domainKey(domain)) as string | null;
  if (existingId) {
    const skill = await getSkill(env, existingId);
    if (skill && skill.lifecycle === "active") return skill;
  }
  // Fallback: scan old intent-idx entries for this domain (lazy migration)
  const entries = await skillsKV(env).listWithValues(`intent-idx:${domain}:`);
  for (const { value } of entries) {
    const skill = await getSkill(env, value as string);
    if (skill && skill.lifecycle === "active") return skill;
  }
  return null;
}

function bumpMinor(version: string): string {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "1.0.0";
  return `${parts[0]}.${parts[1] + 1}.0`;
}

export function mergeEndpoints(
  existing: EndpointDescriptor[],
  incoming: EndpointDescriptor[]
): EndpointDescriptor[] {
  const merged = [...existing];
  for (const ep of incoming) {
    const dupeIdx = merged.findIndex(
      (e) =>
        e.method === ep.method &&
        normalizeTemplate(e.url_template) === normalizeTemplate(ep.url_template)
    );
    if (dupeIdx === -1) {
      merged.push(ep);
    } else if (isRicher(ep, merged[dupeIdx])) {
      merged[dupeIdx] = ep;
    }
  }
  return merged;
}

/** Count richness signals on an endpoint; higher = more metadata captured. */
function endpointRichness(ep: EndpointDescriptor): number {
  let score = 0;
  if (ep.response_schema) score++;
  if (ep.csrf_plan) score++;
  if (ep.oauth_plan) score++;
  if (ep.description) score++;
  if (ep.body && Object.keys(ep.body).length > 0) score++;
  if (ep.query && Object.keys(ep.query).length > 0) score++;
  if (ep.signature) score++;
  return score;
}

/** Returns true if `a` is strictly richer than `b`. Tie-breaks by response_schema JSON length. */
function isRicher(a: EndpointDescriptor, b: EndpointDescriptor): boolean {
  const sa = endpointRichness(a);
  const sb = endpointRichness(b);
  if (sa !== sb) return sa > sb;
  // Tie-break: prefer larger response_schema
  const lenA = a.response_schema ? JSON.stringify(a.response_schema).length : 0;
  const lenB = b.response_schema ? JSON.stringify(b.response_schema).length : 0;
  return lenA > lenB;
}

export function normalizeTemplate(t: string): string {
  return t.replace(/\{[^}]+\}/g, "{}").toLowerCase();
}
