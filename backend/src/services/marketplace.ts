import { nanoid } from "nanoid";
import type { Env, SkillListItem, SkillManifest, EndpointDescriptor, EndpointCorroboration } from "../types.js";
import { indexEndpoints, removeEndpointsFromIndex, purgeSkillVectors } from "./discovery.js";
import { generateDescriptions } from "./descriptions.js";
import { upsertEdges, type GraphEdge, type GraphNode } from "./graph.js";
import { summarizeEmergentDBError } from "./emergentdb.js";
import { skillsKV } from "./kv.js";
import { verifyReleaseManifest } from "./release-manifest.js";
import { isMarketplaceDomainSuppressed } from "./domain-suppression.js";
import { matchedReservedDomain } from "./domain-reservations.js";

function kvKey(skillId: string): string {
  return `skill:${skillId}`;
}

function domainKey(domain: string): string {
  return `domain-idx:${domain}`;
}

function intentKey(domain: string, intent: string): string {
  return `intent-idx:${domain}:${hashIntent(intent)}`;
}

const SKILL_LIST_CARD_CACHE_KEY = "cache:skills:list:card:v1";

function isVisibleSkill(skill: Pick<SkillManifest, "lifecycle">): boolean {
  return skill.lifecycle !== "deprecated" && skill.lifecycle !== "disabled";
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

function toSkillListItem(skill: SkillManifest): SkillListItem {
  const endpoints = skill.endpoints.slice(0, 4).map((endpoint) => ({
    endpoint_id: endpoint.endpoint_id,
    method: endpoint.method,
    verification_status: endpoint.verification_status,
    reliability_score: endpoint.reliability_score,
  }));
  const endpointCount = skill.endpoints.length;
  const avgReliabilityScore = endpointCount > 0
    ? skill.endpoints.reduce((sum, endpoint) => sum + endpoint.reliability_score, 0) / endpointCount
    : 0;

  return {
    skill_id: skill.skill_id,
    version: skill.version,
    name: skill.name,
    intent_signature: skill.intent_signature,
    domain: skill.domain,
    subdomain: skill.subdomain,
    description: skill.description,
    owner_type: skill.owner_type,
    execution_type: skill.execution_type,
    lifecycle: skill.lifecycle,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
    endpoint_count: endpointCount,
    avg_reliability_score: avgReliabilityScore,
    endpoints,
  };
}

async function invalidateSkillListCaches(env: Env): Promise<void> {
  await skillsKV(env).delete(SKILL_LIST_CARD_CACHE_KEY).catch(() => {});
}

export async function listSkillCards(
  env: Env,
  opts: { limit?: number; includeDeprecated?: boolean } = {},
): Promise<SkillListItem[]> {
  const kv = skillsKV(env);
  const cached = await kv.get(SKILL_LIST_CARD_CACHE_KEY) as string | null;
  if (cached) {
    const parsed = JSON.parse(cached) as SkillListItem[];
    const filtered = opts.includeDeprecated
      ? parsed
      : parsed.filter(isVisibleSkill);
    const unsuppressed = filtered.filter((skill) => !isMarketplaceDomainSuppressed(env, skill.domain));
    return opts.limit != null ? unsuppressed.slice(0, opts.limit) : unsuppressed;
  }

  const list = (await listSkills(env))
    .filter((skill) => !isMarketplaceDomainSuppressed(env, skill.domain))
    .map(toSkillListItem)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  await kv.put(SKILL_LIST_CARD_CACHE_KEY, JSON.stringify(list), { expirationTtl: 300 }).catch(() => {});

  const filtered = opts.includeDeprecated
    ? list
    : list.filter(isVisibleSkill);
  return opts.limit != null ? filtered.slice(0, opts.limit) : filtered;
}

export async function getSkill(env: Env, skillId: string): Promise<SkillManifest | null> {
  const raw = await skillsKV(env).get(kvKey(skillId)) as string | null;
  if (!raw) return null;
  const skill = JSON.parse(raw) as SkillManifest;
  if (!skill.execution_type) skill.execution_type = "http";
  return skill;
}

// Find the most-recently-updated published skill for a registrable domain.
// Used to serve `unbrowse.ai/<domain>` as a single SKILL.md per domain.
export async function getSkillByDomain(env: Env, domain: string): Promise<SkillManifest | null> {
  const target = domain.toLowerCase();
  if (isMarketplaceDomainSuppressed(env, target)) return null;
  const all = await listSkills(env);
  const candidates = all.filter((s) => {
    if (!isVisibleSkill(s)) return false;
    const d = (s.domain ?? "").toLowerCase();
    if (d === target) return true;
    // allow subdomain match: skill domain could be "api.github.com"
    if (d.endsWith(`.${target}`) || target.endsWith(`.${d}`)) return true;
    return false;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return candidates[0];
}

export async function publishSkill(
  env: Env,
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  },
  context?: {
    submitter_agent_id?: string;
    client_trace_version?: string;
    client_code_hash?: string;
    client_git_sha?: string;
    client_release_manifest?: string;
    client_release_signature?: string;
    transport?: string;
  },
): Promise<SkillManifest & { index_status: string }> {
  const existing = await findExistingByDomain(env, draft.domain);
  const now = new Date().toISOString();

  // Reserved-domain gate: high-impact brand and infra domains can only be
  // published by admin keys. Without this, any agent could squat
  // `domain: "stripe.com"` and seed the marketplace with prompt-injection
  // content downstream agents would read. The ownership gate elsewhere
  // freezes a squat in place once it lands; this prevents it from landing.
  const submitterAgentId = context?.submitter_agent_id;
  const isAdminSubmission = submitterAgentId === "__admin__";
  if (!isAdminSubmission) {
    const reserved = matchedReservedDomain(env, draft.domain);
    if (reserved) {
      throw new Error(`publish_forbidden_reserved_domain:${reserved}`);
    }
  }

  // Optional: require .well-known domain-verification probe before any
  // non-admin publish lands. Operators flip `REQUIRE_DOMAIN_VERIFICATION=1`
  // once the publisher tooling supports the challenge/probe flow. Existing
  // verified skills (re-publishes) bypass; admins always bypass.
  const requireVerification = ((env as { REQUIRE_DOMAIN_VERIFICATION?: string }).REQUIRE_DOMAIN_VERIFICATION ?? "").toLowerCase();
  const requireVerificationOn = requireVerification === "1" || requireVerification === "true";
  if (requireVerificationOn && !isAdminSubmission) {
    const verified = existing?.domain_verified === true;
    if (!verified) {
      throw new Error(`publish_forbidden_domain_unverified:${draft.domain.toLowerCase()}`);
    }
  }

  const releaseVerification = await verifyReleaseManifest(
    env,
    context?.client_release_manifest,
    context?.client_release_signature,
    {
      trace_version: context?.client_trace_version,
      code_hash: context?.client_code_hash,
      git_sha: context?.client_git_sha,
    },
  );
  if (
    releaseVerification.provided
    && !releaseVerification.verified
    && releaseVerification.reason !== "verification_unconfigured"
  ) {
    throw new Error(`release_manifest_${releaseVerification.reason}`);
  }
  const provenanceEvent = {
    submitted_at: now,
    submitter_agent_id: context?.submitter_agent_id,
    client_trace_version: context?.client_trace_version,
    client_code_hash: context?.client_code_hash,
    client_git_sha: context?.client_git_sha,
    transport: context?.transport ?? "unknown",
    release_manifest_version: releaseVerification.manifest?.release_version,
    release_manifest_verified: releaseVerification.verified,
    release_manifest_reason: releaseVerification.reason,
  };
  let skill: SkillManifest;

  if (existing) {
    const newVersion = bumpMinor(existing.version);
    const existingVisibility = existing.trust?.graph_visibility ?? "public";
    const mergedEndpoints = mergeEndpointsWithVisibility(
      existing.endpoints,
      draft.endpoints,
      existingVisibility,
      {
        submitted_at: now,
        submitter_agent_id: context?.submitter_agent_id,
        release_manifest_verified: releaseVerification.verified,
      },
    );
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
      owner_type: submitterAgentId && !isAdminSubmission
        ? "agent"
        : draft.owner_type,
      // Server-owned: never copied from draft. Existing ownership is preserved
      // across re-publishes; first non-admin publish onto an unowned skill
      // claims it; admin re-publishes leave ownership unchanged.
      owner_agent_id: existing.owner_agent_id
        ?? (submitterAgentId && !isAdminSubmission ? submitterAgentId : undefined),
      // domain_verified is server-set by the .well-known probe; preserve.
      domain_verified: existing.domain_verified,
      domain_verified_at: existing.domain_verified_at,
      endpoints: mergedEndpoints,
      intents: Array.from(intents),
      provenance_events: [...(existing.provenance_events ?? []), provenanceEvent],
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
      owner_type: submitterAgentId && !isAdminSubmission
        ? "agent"
        : draft.owner_type,
      // First publisher (non-admin) owns the skill. Admin publishes leave it
      // unowned so the first agent submission can claim it.
      owner_agent_id: submitterAgentId && !isAdminSubmission ? submitterAgentId : undefined,
      domain_verified: false,
      lifecycle: "active",
      provenance_events: [provenanceEvent],
      endpoints: draft.endpoints.map((endpoint) => ({
        ...endpoint,
        verification_status: endpoint.verification_status ?? "unverified",
        graph_visibility: endpoint.graph_visibility ?? "shadow",
        corroboration: applySubmissionToCorroboration(
          undefined,
          now,
          context?.submitter_agent_id,
          releaseVerification.verified,
        ),
      })),
      created_at: now,
      updated_at: now,
      base_price_usd: draft.base_price_usd ?? 0.001,
    } as SkillManifest;
  }

  const trust = computeSkillTrust(
    skill,
    context?.submitter_agent_id,
    (existing?.trust?.graph_visibility ?? "public") === "public" && existing != null,
  );
  applyEndpointVisibility(skill, trust.graph_visibility, trust.promotion_reason);
  skill.trust = trust;

  // Generate LLM descriptions for endpoints that lack them (non-blocking on failure)
  if (skill.endpoints.some((ep) => !ep.description)) {
    try {
      await generateDescriptions(env, skill.endpoints);
    } catch (err) {
      console.error(`[descriptions] failed for ${skill.skill_id}:`, (err as Error).message);
    }
  }

  // putBatch keeps related KV writes coalesced on both storage backends.
  const kv = skillsKV(env);
  await kv.putBatch([
    { key: kvKey(skill.skill_id), value: JSON.stringify(skill) },
    { key: domainKey(skill.domain), value: skill.skill_id },
  ]);

  const publicEndpoints = getPublicEndpoints(skill.endpoints);
  const reliabilities = publicEndpoints.map((e) => e.reliability_score);
  const avgReliability = reliabilities.length > 0
    ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
    : 0.5;
  const verifiedCount = publicEndpoints.filter((e) => e.verification_status === "verified").length;
  const verifiedRatio = publicEndpoints.length > 0 ? verifiedCount / publicEndpoints.length : 0;

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
    if (publicEndpoints.length > 0) {
      await indexEndpoints(env, skill.skill_id, publicEndpoints, {
        domain: skill.domain,
        subdomain: skill.subdomain,
        name: skill.name,
        description: skill.description,
        avg_reliability: avgReliability,
        verified_ratio: verifiedRatio,
        updated_at: skill.updated_at,
      });
      index_status = "ok";
    } else {
      index_status = `shadow:${trust.promotion_reason}`;
    }
  } catch (err) {
    index_status = summarizeEmergentDBError(err);
    console.error(`[indexEndpoints] failed for ${skill.skill_id}:`, index_status);
  }

  // Infer DAG edges from endpoint URL templates and upsert them
  try {
    for (const ep of publicEndpoints) {
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

  await invalidateSkillListCaches(env);

  return { ...skill, index_status };
}

export async function deprecateSkill(env: Env, skillId: string): Promise<SkillManifest | null> {
  const skill = await getSkill(env, skillId);
  if (!skill) return null;
  skill.lifecycle = "deprecated";
  skill.updated_at = new Date().toISOString();
  await skillsKV(env).put(kvKey(skillId), JSON.stringify(skill));
  await purgeSkillVectors(env, skillId, skill.endpoints.map((endpoint) => endpoint.endpoint_id), skill.domain).catch(() => {});
  await invalidateSkillListCaches(env);
  return skill;
}

export async function removeDomainFromMarketplace(
  env: Env,
  domain: string,
  opts: { dryRun?: boolean } = {},
): Promise<{
  domain: string;
  matched_skills: number;
  disabled_skill_ids: string[];
  deleted_keys: string[];
  vectors_purged: number;
  dry_run: boolean;
}> {
  const target = domain.trim().toLowerCase();
  if (!target || !/^[a-z0-9.-]+$/i.test(target) || !target.includes(".")) {
    throw new Error("invalid_domain");
  }

  const kv = skillsKV(env);
  const skills = await listSkills(env);
  const matches = skills.filter((skill) => (skill.domain ?? "").toLowerCase() === target);
  const intentEntries = await kv.listWithValues(`intent-idx:${target}:`);
  const deletedKeys = [
    domainKey(target),
    `domain:${target}`,
    ...intentEntries.map((entry) => entry.key),
  ];

  if (opts.dryRun) {
    return {
      domain: target,
      matched_skills: matches.length,
      disabled_skill_ids: matches.map((skill) => skill.skill_id),
      deleted_keys: deletedKeys,
      vectors_purged: 0,
      dry_run: true,
    };
  }

  const now = new Date().toISOString();
  const disabled: string[] = [];
  let vectorsPurged = 0;

  for (const skill of matches) {
    const endpointIds = skill.endpoints.map((endpoint) => endpoint.endpoint_id);
    await purgeSkillVectors(env, skill.skill_id, endpointIds, skill.domain).catch(() => {});
    vectorsPurged += endpointIds.length;
    await kv.put(kvKey(skill.skill_id), JSON.stringify({
      ...skill,
      lifecycle: "disabled",
      updated_at: now,
    }));
    disabled.push(skill.skill_id);
  }

  for (const key of deletedKeys) {
    await kv.delete(key).catch(() => {});
  }
  await invalidateSkillListCaches(env);

  return {
    domain: target,
    matched_skills: matches.length,
    disabled_skill_ids: disabled,
    deleted_keys: deletedKeys,
    vectors_purged: vectorsPurged,
    dry_run: false,
  };
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
  if (endpoint.verification_status === "verified") {
    endpoint.graph_visibility = "public";
  }
  const trust = computeSkillTrust(skill);
  applyEndpointVisibility(skill, trust.graph_visibility, trust.promotion_reason);
  skill.trust = trust;
  skill.updated_at = new Date().toISOString();
  await skillsKV(env).put(kvKey(skillId), JSON.stringify(skill));
  await invalidateSkillListCaches(env);

  if (trust.graph_visibility === "public") {
    const publicEndpoints = getPublicEndpoints(skill.endpoints);
    if (publicEndpoints.length > 0) {
      const reliabilities = publicEndpoints.map((e) => e.reliability_score);
      const avgReliability = reliabilities.length > 0
        ? reliabilities.reduce((a, b) => a + b, 0) / reliabilities.length
        : 0.5;
      const verifiedCount = publicEndpoints.filter((e) => e.verification_status === "verified").length;
      const verifiedRatio = publicEndpoints.length > 0 ? verifiedCount / publicEndpoints.length : 0;
      await indexEndpoints(env, skill.skill_id, publicEndpoints, {
        domain: skill.domain,
        subdomain: skill.subdomain,
        name: skill.name,
        description: skill.description,
        avg_reliability: avgReliability,
        verified_ratio: verifiedRatio,
        updated_at: skill.updated_at,
      }).catch(() => {});
    }
  }

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
  await invalidateSkillListCaches(env);
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

function mergeEndpointsWithVisibility(
  existing: EndpointDescriptor[],
  incoming: EndpointDescriptor[],
  existingSkillVisibility: "shadow" | "public",
  submission: {
    submitted_at: string;
    submitter_agent_id?: string;
    release_manifest_verified: boolean;
  },
): EndpointDescriptor[] {
  const merged = existing.map((endpoint) => ({
    ...endpoint,
    graph_visibility: endpoint.graph_visibility ?? existingSkillVisibility,
    corroboration: normalizeEndpointCorroboration(
      endpoint.corroboration,
      submission.submitted_at,
      endpoint.graph_visibility ?? existingSkillVisibility,
    ),
  }));

  for (const ep of incoming) {
    const dupeIdx = merged.findIndex(
      (e) =>
        e.method === ep.method &&
        normalizeTemplate(e.url_template) === normalizeTemplate(ep.url_template),
    );
    if (dupeIdx === -1) {
      merged.push({
        ...ep,
        graph_visibility: ep.graph_visibility ?? "shadow",
        corroboration: applySubmissionToCorroboration(
          undefined,
          submission.submitted_at,
          submission.submitter_agent_id,
          submission.release_manifest_verified,
        ),
      });
    } else if (isRicher(ep, merged[dupeIdx])) {
      merged[dupeIdx] = {
        ...ep,
        endpoint_id: merged[dupeIdx].endpoint_id,
        graph_visibility: merged[dupeIdx].graph_visibility ?? existingSkillVisibility,
        corroboration: applySubmissionToCorroboration(
          merged[dupeIdx].corroboration,
          submission.submitted_at,
          submission.submitter_agent_id,
          submission.release_manifest_verified,
        ),
      };
    } else {
      merged[dupeIdx] = {
        ...merged[dupeIdx],
        corroboration: applySubmissionToCorroboration(
          merged[dupeIdx].corroboration,
          submission.submitted_at,
          submission.submitter_agent_id,
          submission.release_manifest_verified,
        ),
      };
    }
  }
  return merged;
}

function getPublicEndpoints(endpoints: EndpointDescriptor[]): EndpointDescriptor[] {
  return endpoints.filter((endpoint) => (endpoint.graph_visibility ?? "public") === "public");
}

function computeVerifiedRatio(endpoints: EndpointDescriptor[]): number {
  if (endpoints.length === 0) return 0;
  const verified = endpoints.filter((endpoint) => endpoint.verification_status === "verified").length;
  return verified / endpoints.length;
}

function countUniqueSubmitters(events: SkillManifest["provenance_events"]): number {
  return new Set((events ?? []).map((event) => event.submitter_agent_id).filter(Boolean)).size;
}

function countVerifiedReleaseSubmissions(events: SkillManifest["provenance_events"]): number {
  return (events ?? []).filter((event) => event.release_manifest_verified).length;
}

function countUniqueVerifiedSubmitters(events: SkillManifest["provenance_events"]): number {
  return new Set(
    (events ?? [])
      .filter((event) => event.release_manifest_verified)
      .map((event) => event.submitter_agent_id)
      .filter(Boolean),
  ).size;
}

function computeSkillTrust(
  skill: SkillManifest,
  currentSubmitterAgentId?: string,
  existingWasPublic = false,
): NonNullable<SkillManifest["trust"]> {
  const submissionCount = skill.provenance_events?.length ?? 0;
  const uniqueSubmitters = countUniqueSubmitters(skill.provenance_events);
  const verifiedReleaseSubmissions = countVerifiedReleaseSubmissions(skill.provenance_events);
  const uniqueVerifiedSubmitters = countUniqueVerifiedSubmitters(skill.provenance_events);
  const verifiedRatio = computeVerifiedRatio(skill.endpoints);
  const alreadyPublic = existingWasPublic || skill.trust?.graph_visibility === "public";
  const trustedSystemPublisher = !currentSubmitterAgentId && skill.owner_type === "marketplace";
  const adminPublisher = currentSubmitterAgentId === "__admin__";

  if (alreadyPublic) {
    return {
      graph_visibility: "public",
      promotion_reason: existingWasPublic ? "already_public" : skill.trust?.promotion_reason ?? "already_public",
      submission_count: submissionCount,
      unique_submitters: uniqueSubmitters,
      verified_release_submissions: verifiedReleaseSubmissions,
      unique_verified_submitters: uniqueVerifiedSubmitters,
      verified_ratio: verifiedRatio,
      last_submission_at: skill.updated_at,
    };
  }

  let graphVisibility: "shadow" | "public" = "shadow";
  let promotionReason = "awaiting_verification";
  if (verifiedRatio > 0) {
    graphVisibility = "public";
    promotionReason = "verified_endpoint";
  } else if (uniqueVerifiedSubmitters >= 2) {
    graphVisibility = "public";
    promotionReason = "multi_submitter_verified_release";
  } else if (uniqueSubmitters >= 2) {
    graphVisibility = "public";
    promotionReason = "multi_submitter";
  } else if (trustedSystemPublisher || adminPublisher) {
    graphVisibility = "public";
    promotionReason = "trusted_system_publisher";
  }

  return {
    graph_visibility: graphVisibility,
    promotion_reason: promotionReason,
    submission_count: submissionCount,
    unique_submitters: uniqueSubmitters,
    verified_release_submissions: verifiedReleaseSubmissions,
    unique_verified_submitters: uniqueVerifiedSubmitters,
    verified_ratio: verifiedRatio,
    last_submission_at: skill.updated_at,
  };
}

function applyEndpointVisibility(
  skill: SkillManifest,
  graphVisibility: "shadow" | "public",
  promotionReason: string,
): void {
  for (const endpoint of skill.endpoints) {
    const existingVisibility = endpoint.graph_visibility;
    if (endpoint.verification_status === "verified" || isEndpointCorroborated(endpoint)) {
      endpoint.graph_visibility = "public";
      continue;
    }
    if (graphVisibility === "public") {
      endpoint.graph_visibility = promotionReason === "already_public"
        ? existingVisibility === "public" ? "public" : "shadow"
        : "public";
      continue;
    }
    endpoint.graph_visibility = existingVisibility === "public" ? "public" : "shadow";
  }
}

function normalizeEndpointCorroboration(
  corroboration: EndpointCorroboration | undefined,
  submittedAt: string,
  existingVisibility: "shadow" | "public",
): EndpointCorroboration {
  if (!corroboration) {
    return {
      submission_count: 1,
      unique_submitters: existingVisibility === "public" ? 1 : 1,
      verified_release_submissions: 0,
      unique_verified_submitters: 0,
      last_submission_at: submittedAt,
    };
  }
  const submitterIds = Array.from(new Set(corroboration.submitter_agent_ids ?? []));
  const verifiedSubmitterIds = Array.from(new Set(corroboration.verified_release_submitter_ids ?? []));
  return {
    ...corroboration,
    unique_submitters: Math.max(corroboration.unique_submitters, submitterIds.length),
    unique_verified_submitters: Math.max(corroboration.unique_verified_submitters, verifiedSubmitterIds.length),
    last_submission_at: corroboration.last_submission_at || submittedAt,
    submitter_agent_ids: submitterIds.length > 0 ? submitterIds : undefined,
    verified_release_submitter_ids: verifiedSubmitterIds.length > 0 ? verifiedSubmitterIds : undefined,
  };
}

function applySubmissionToCorroboration(
  corroboration: EndpointCorroboration | undefined,
  submittedAt: string,
  submitterAgentId: string | undefined,
  releaseManifestVerified: boolean,
): EndpointCorroboration {
  const base = corroboration
    ? normalizeEndpointCorroboration(corroboration, submittedAt, "shadow")
    : {
      submission_count: 0,
      unique_submitters: 0,
      verified_release_submissions: 0,
      unique_verified_submitters: 0,
      last_submission_at: submittedAt,
      submitter_agent_ids: undefined,
      verified_release_submitter_ids: undefined,
    };
  const submitterIds = Array.from(new Set(base.submitter_agent_ids ?? []));
  const hadSubmitter = submitterAgentId ? submitterIds.includes(submitterAgentId) : false;
  if (submitterAgentId && !hadSubmitter) submitterIds.push(submitterAgentId);

  const verifiedSubmitterIds = Array.from(new Set(base.verified_release_submitter_ids ?? []));
  const hadVerifiedSubmitter = submitterAgentId ? verifiedSubmitterIds.includes(submitterAgentId) : false;
  if (submitterAgentId && releaseManifestVerified && !hadVerifiedSubmitter) {
    verifiedSubmitterIds.push(submitterAgentId);
  }

  const trackedSubmitterIds = base.submitter_agent_ids?.length ?? 0;
  const trackedVerifiedSubmitterIds = base.verified_release_submitter_ids?.length ?? 0;

  return {
    submission_count: base.submission_count + 1,
    unique_submitters: submitterAgentId
      ? base.unique_submitters === 0
        ? Math.max(1, submitterIds.length)
        : hadSubmitter
          ? Math.max(base.unique_submitters, submitterIds.length)
          : trackedSubmitterIds > 0
            ? Math.max(base.unique_submitters + 1, submitterIds.length)
            : Math.max(base.unique_submitters, submitterIds.length)
      : base.unique_submitters,
    verified_release_submissions: base.verified_release_submissions + (releaseManifestVerified ? 1 : 0),
    unique_verified_submitters: submitterAgentId && releaseManifestVerified
      ? base.unique_verified_submitters === 0
        ? Math.max(1, verifiedSubmitterIds.length)
        : hadVerifiedSubmitter
          ? Math.max(base.unique_verified_submitters, verifiedSubmitterIds.length)
          : trackedVerifiedSubmitterIds > 0
            ? Math.max(base.unique_verified_submitters + 1, verifiedSubmitterIds.length)
            : Math.max(base.unique_verified_submitters, verifiedSubmitterIds.length)
      : base.unique_verified_submitters,
    last_submission_at: submittedAt,
    submitter_agent_ids: submitterIds.length > 0 ? submitterIds : undefined,
    verified_release_submitter_ids: verifiedSubmitterIds.length > 0 ? verifiedSubmitterIds : undefined,
  };
}

function isEndpointCorroborated(endpoint: EndpointDescriptor): boolean {
  const corroboration = endpoint.corroboration;
  if (!corroboration) return false;
  return corroboration.unique_verified_submitters >= 2 || corroboration.unique_submitters >= 2;
}
