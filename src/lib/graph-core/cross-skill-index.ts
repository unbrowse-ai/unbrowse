/**
 * src/lib/graph-core/cross-skill-index.ts — the GLOBAL producer index.
 *
 * Per-skill, buildSkillOperationGraph already traces requires→provides WITHIN one skill.
 * This joins EVERY known skill's `provides` into ONE dependency graph so an op whose
 * `requires` hole no endpoint in its OWN skill can fill is resolved to a producer
 * endpoint in ANOTHER skill — the cross-contract DAG for the shared graph.
 *
 * Matching is by SEMANTIC IDENTITY, never a bare key (the same lesson as the session
 * store's scope-namespacing): a `post.id` hole matches a `post` producer's `id`, but a
 * `comment.id` hole does not. Identity = `<entity>::<field>`, where the entity is read
 * from the key prefix (postId → post) or the endpoint's resource_kind, normalized
 * through a small alias table.
 */
import type { EndpointDescriptor, OperationBinding, SkillManifest } from "../../types/skill.js";

export interface CrossSkillProducer {
  skill_id: string;
  endpoint_id: string;
  binding_key: string;
  identity: string;
  semantic_type?: string;
  resource_kind?: string;
}

export interface GlobalProducerIndex {
  /** identity (`<entity>::<field>`) → producing endpoints across all skills */
  byIdentity: Map<string, CrossSkillProducer[]>;
}

// Entity aliases so synonymous resources collapse to one identity.
const ENTITY_ALIASES: Record<string, string> = {
  repo: "repository",
  repository: "repository",
  org: "organization",
  organisation: "organization",
  organization: "organization",
  user: "user",
  account: "user",
  post: "post",
  posts: "post",
  comment: "comment",
  comments: "comment",
};

function normEntity(e: string): string {
  const k = e.toLowerCase();
  return ENTITY_ALIASES[k] ?? k;
}

/** The id-like fields a binding key can resolve to. */
const ID_FIELD = /^(id|uuid|guid|slug|key|number|no)$/i;

/**
 * Normalize a binding key (+ optional endpoint resource_kind) to `<entity>::<field>`.
 *  - "postId" / "post_id" / "postID"  → post::id
 *  - "id" with resource_kind "post"   → post::id
 *  - "slug" with resource_kind "post" → post::slug
 *  - "email"                          → ::email  (no entity — matches only same bare field)
 */
export function bindingIdentityKey(key: string, resourceKind?: string): string {
  const raw = String(key ?? "").trim();
  if (!raw) return "::";
  // entity-prefixed id: postId / post_id / postID / postUuid (case-insensitive suffix)
  const m = raw.match(/^([A-Za-z][A-Za-z0-9]*?)[_]?(id|ids|uuid|guid|slug|key)$/i);
  if (m && m[1] && m[1].toLowerCase() !== m[2].toLowerCase()) {
    const field = m[2].toLowerCase() === "ids" ? "id" : m[2].toLowerCase();
    return `${normEntity(m[1])}::${field}`;
  }
  // bare id-like field → take the entity from the endpoint's resource_kind
  if (ID_FIELD.test(raw) && resourceKind) {
    return `${normEntity(resourceKind)}::${raw.toLowerCase()}`;
  }
  // otherwise: entity from resource_kind (if any), field = the key itself
  return `${resourceKind ? normEntity(resourceKind) : ""}::${raw.toLowerCase()}`;
}

function endpointResourceKind(ep: EndpointDescriptor): string | undefined {
  return (ep.semantic as { resource_kind?: string } | undefined)?.resource_kind;
}

/** Build the global producer index from a set of skills. */
export function buildGlobalProducerIndex(skills: SkillManifest[]): GlobalProducerIndex {
  const byIdentity = new Map<string, CrossSkillProducer[]>();
  for (const skill of skills ?? []) {
    if (!skill?.endpoints) continue;
    for (const ep of skill.endpoints) {
      const rk = endpointResourceKind(ep);
      const provides = (ep.semantic as { provides?: OperationBinding[] } | undefined)?.provides ?? [];
      for (const b of provides) {
        if (!b?.key) continue;
        const identity = bindingIdentityKey(b.key, rk);
        const producer: CrossSkillProducer = {
          skill_id: skill.skill_id,
          endpoint_id: ep.endpoint_id,
          binding_key: b.key,
          identity,
          semantic_type: b.semantic_type,
          resource_kind: rk,
        };
        const list = byIdentity.get(identity) ?? [];
        list.push(producer);
        byIdentity.set(identity, list);
      }
    }
  }
  return { byIdentity };
}

/**
 * Resolve which producers (in OTHER skills, by default) can fill a `requires` hole.
 * @param consumerResourceKind the consuming endpoint's resource_kind (entity hint).
 * @param opts.excludeSkillId   skip producers from this skill (cross-skill discovery).
 */
export function resolveProducersForHole(
  index: GlobalProducerIndex,
  hole: OperationBinding,
  consumerResourceKind?: string,
  opts?: { excludeSkillId?: string; includeSameSkill?: boolean },
): CrossSkillProducer[] {
  if (!hole?.key) return [];
  const identity = bindingIdentityKey(hole.key, consumerResourceKind);
  const all = index.byIdentity.get(identity) ?? [];
  if (opts?.includeSameSkill) return [...all];
  const exclude = opts?.excludeSkillId;
  return exclude ? all.filter((p) => p.skill_id !== exclude) : [...all];
}

/**
 * Build the global producer index from every locally-cached skill (in-memory ∪ disk).
 * Dynamic import keeps this module dependency-light + avoids a static client cycle.
 */
export async function buildGlobalProducerIndexFromCache(): Promise<GlobalProducerIndex> {
  try {
    const { listLocalSkills } = await import("../../client/index.js");
    return buildGlobalProducerIndex(listLocalSkills());
  } catch {
    return { byIdentity: new Map() };
  }
}

export interface CrossSkillSuggestion {
  hole: string;                      // the unfilled requires key
  producers: CrossSkillProducer[];   // run one of these (in another skill) to produce it
}

/**
 * For an endpoint about to execute, name the cross-skill producers that could fill each
 * `requires` hole the caller left empty (after local/session fill). This is what turns the
 * global index into agent-actionable guidance: "to fill `postId`, run skill B's create_post
 * first." Excludes the endpoint's own skill (that's the per-skill graph's job).
 */
export function suggestCrossSkillProducers(
  endpointRequires: OperationBinding[] | undefined,
  filledParams: Record<string, unknown>,
  consumerResourceKind: string | undefined,
  consumerSkillId: string,
  index: GlobalProducerIndex,
): CrossSkillSuggestion[] {
  const out: CrossSkillSuggestion[] = [];
  for (const b of endpointRequires ?? []) {
    if (!b?.key) continue;
    if (filledParams[b.key] !== undefined && filledParams[b.key] !== null) continue; // already filled
    const producers = resolveProducersForHole(index, b, consumerResourceKind, { excludeSkillId: consumerSkillId });
    if (producers.length) out.push({ hole: b.key, producers });
  }
  return out;
}
