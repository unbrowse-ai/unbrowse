// Backfill local cache → backend marketplace. Publishing was historically broken
// (bearer-required), so real captures piled up in the local skill caches
// (~/.unbrowse/skill-snapshots, ~/.unbrowse/skill-cache) and never reached the
// backend. Now that publish works (bearer-optional + private-store), backfill them —
// but only items whose FORMAT SHAPE MATCHES a real, indexable skill manifest.
import { isIndexableDomain } from "../capture/indexable.js";

export interface BackfillCandidate {
  skill_id: string;
  domain: string;
  endpoints: unknown[];
  visibility?: "public" | "private";
}

/**
 * Shape gate: does this cached object match the SkillManifest format well enough to
 * backfill? Requires a real skill_id + an externally-reachable domain (reuses the
 * passive-index admission so localhost/example.com/error-page junk is never backfilled)
 * + at least one endpoint. Pure; no I/O. "format shape matches" ⇒ true.
 */
export function isBackfillableManifest(obj: unknown): obj is BackfillCandidate {
  if (!obj || typeof obj !== "object") return false;
  const m = obj as Record<string, unknown>;
  if (typeof m.skill_id !== "string" || m.skill_id.length === 0) return false;
  if (typeof m.domain !== "string" || m.domain.length === 0) return false;
  if (!isIndexableDomain(m.domain)) return false;
  if (!Array.isArray(m.endpoints) || m.endpoints.length === 0) return false;
  return true;
}

/** Dedupe candidates by skill_id (a skill can appear in both snapshot + cache),
 *  keeping the first seen. Returns the unique backfillable manifests. */
export function dedupeBackfill<T extends { skill_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.skill_id)) continue;
    seen.add(it.skill_id);
    out.push(it);
  }
  return out;
}
