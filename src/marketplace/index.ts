import { nanoid } from "nanoid";
import * as client from "../client/index.js";
import type { EndpointDescriptor, SkillManifest, VerificationStatus } from "../types/index.js";

export async function listSkills(): Promise<SkillManifest[]> {
  return client.listSkills();
}

export async function getSkill(skillId: string, scopeId?: string): Promise<SkillManifest | null> {
  return client.getSkill(skillId, scopeId);
}
// ---------------------------------------------------------------------------
// Phase 8.1 — In-process marketplace TTL cache.
//
// `getSkillCached` wraps `getSkill` with a 5-minute TTL keyed by (scope, skill_id).
// Cuts repeated round-trips during a hot-path race (recipe || marketplace || probe)
// from ~2.5s backend timeout to ~1ms map lookup. Bounded LRU (100 entries) so a
// chatty scope can't pin the heap.
//
// `invalidateMarketplaceCache(domain)` is called from `publishSkill` after a
// successful publish so other agents see the new skill within the publish window.
// Domain matches any cache entry whose stored skill has that `skill_id` or
// `domain`. Callers may pass either.
// ---------------------------------------------------------------------------

interface CacheEntry { skill: SkillManifest; expires: number }

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 100;
const marketplaceCache = new Map<string, CacheEntry>();

function cacheKey(skillId: string, scope?: string): string {
  return `${scope ?? "global"}:${skillId}`;
}

function evictExpiredAndOverflow(): void {
  const now = Date.now();
  for (const [k, v] of marketplaceCache) {
    if (v.expires <= now) marketplaceCache.delete(k);
  }
  // LRU-ish: insertion order is iteration order; drop oldest until under cap.
  while (marketplaceCache.size > MAX_ENTRIES) {
    const oldest = marketplaceCache.keys().next().value;
    if (!oldest) break;
    marketplaceCache.delete(oldest);
  }
}

/**
 * Cached wrapper around `getSkill`. Returns the cached SkillManifest when fresh
 * (≤ 5 min old), otherwise fetches from backend and stores. Returns null on miss.
 */
export async function getSkillCached(skillId: string, scopeId?: string): Promise<SkillManifest | null> {
  const key = cacheKey(skillId, scopeId);
  const cached = marketplaceCache.get(key);
  if (cached && cached.expires > Date.now()) {
    // refresh LRU position
    marketplaceCache.delete(key);
    marketplaceCache.set(key, cached);
    return cached.skill;
  }
  const fresh = await client.getSkill(skillId, scopeId);
  if (fresh) {
    marketplaceCache.set(key, { skill: fresh, expires: Date.now() + TTL_MS });
    evictExpiredAndOverflow();
  }
  return fresh;
}

/**
 * Drop every cached entry whose skill_id or domain matches the input. Called
 * by `publishSkill` after a successful publish so subsequent `getSkillCached`
 * calls from any client_scope re-fetch the new version.
 */
export function invalidateMarketplaceCache(skillIdOrDomain: string): void {
  if (!skillIdOrDomain) return;
  for (const [key, entry] of marketplaceCache) {
    if (key.endsWith(`:${skillIdOrDomain}`)) {
      marketplaceCache.delete(key);
      continue;
    }
    if (entry.skill.skill_id === skillIdOrDomain || entry.skill.domain === skillIdOrDomain) {
      marketplaceCache.delete(key);
    }
  }
}

/** Test-only: clear the entire cache. */
export function _clearMarketplaceCacheForTests(): void {
  marketplaceCache.clear();
}

/** Test-only: read current cache size. */
export function _marketplaceCacheSizeForTests(): number {
  return marketplaceCache.size;
}

export async function publishSkill(
  draft: Omit<SkillManifest, "skill_id" | "created_at" | "updated_at" | "version"> & {
    skill_id?: string;
    version?: string;
  }
): Promise<SkillManifest> {
  // Pre-cache locally so the skill is immediately available even if the remote publish
  // fails or EmergentDB hasn't indexed it yet (eventual consistency).
  const now = new Date().toISOString();
  const preCache = {
    ...draft,
    skill_id: draft.skill_id ?? nanoid(),
    created_at: now,
    updated_at: now,
    version: draft.version ?? "1.0.0",
  } as SkillManifest;
  client.cachePublishedSkill(preCache);

  if (client.isLocalOnlyMode()) {
    return preCache;
  }

  try {
    const { warnings: _, ...backendFields } = await client.publishSkill(draft);
    // Merge draft with backend response — avoids read-after-write race
    const skill = { ...draft, ...backendFields } as SkillManifest;
    client.cachePublishedSkill(skill);
    // Phase 8.1 — invalidate TTL cache so other agents see the new skill
    invalidateMarketplaceCache(skill.skill_id);
    if (skill.domain) invalidateMarketplaceCache(skill.domain);
    return skill;
  } catch (err) {
    console.error("[publish] remote publish failed, using local cache:", (err as Error).message);
    return preCache;
  }
}

export async function updateEndpointScore(
  skillId: string,
  endpointId: string,
  score: number,
  status?: VerificationStatus
): Promise<void> {
  await client.updateEndpointScore(skillId, endpointId, score, status);
}

// --- Pure local helpers (no backend call) ---

export function mergeEndpoints(
  existing: EndpointDescriptor[],
  incoming: EndpointDescriptor[]
): EndpointDescriptor[] {
  const merged = [...existing];
  for (const ep of incoming) {
    const dupeIndex = merged.findIndex(
      (e) =>
        e.method === ep.method &&
        normalizeTemplate(e.url_template) === normalizeTemplate(ep.url_template)
    );
    if (dupeIndex === -1) {
      merged.push(ep);
      continue;
    }

    const dupe = merged[dupeIndex]!;
    merged[dupeIndex] = {
      ...dupe,
      ...ep,
      endpoint_id: dupe.endpoint_id,
      reliability_score: Math.max(dupe.reliability_score ?? 0, ep.reliability_score ?? 0),
      verification_status: dupe.verification_status === "verified" ? dupe.verification_status : ep.verification_status,
      exec_strategy: ep.exec_strategy ?? dupe.exec_strategy,
      dom_extraction: ep.dom_extraction ?? dupe.dom_extraction,
      semantic: ep.semantic ?? dupe.semantic,
      response_schema: ep.response_schema ?? dupe.response_schema,
      headers_template: Object.keys(ep.headers_template ?? {}).length > 0 ? ep.headers_template : dupe.headers_template,
      query: ep.query ?? dupe.query,
      path_params: ep.path_params ?? dupe.path_params,
      body: ep.body ?? dupe.body,
      body_params: ep.body_params ?? dupe.body_params,
      trigger_url: ep.trigger_url ?? dupe.trigger_url,
      csrf_plan: ep.csrf_plan ?? dupe.csrf_plan,
      oauth_plan: ep.oauth_plan ?? dupe.oauth_plan,
      search_form: ep.search_form ?? dupe.search_form,
      policy: ep.policy ?? dupe.policy,
      graph_visibility: ep.graph_visibility ?? dupe.graph_visibility,
      corroboration: ep.corroboration ?? dupe.corroboration,
      auth_tokens: ep.auth_tokens ?? dupe.auth_tokens,
    };
  }
  return merged;
}

export function normalizeTemplate(t: string): string {
  return t
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/([?&]queryid=)([^?&]+)/gi, (_match, prefix: string, value: string) => {
      if (value === "{}") return `${prefix}${value}`;
      return `${prefix}${value.replace(/\.[a-f0-9]{8,}$/i, "")}`;
    })
    .toLowerCase();
}
