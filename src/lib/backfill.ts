// Backfill local cache → backend marketplace. Publishing was historically broken
// (bearer-required), so real captures piled up in the local skill caches
// (~/.unbrowse/skill-snapshots, ~/.unbrowse/skill-cache) and never reached the
// backend. Now that publish works (bearer-optional + private-store), backfill them —
// but only items whose FORMAT SHAPE MATCHES a real, indexable skill manifest.
import { isIndexableDomain, isIndexableUrl } from "../capture/indexable.js";

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

/**
 * Does an endpoint pass the backend's publish validation — https(s) + a host that is
 * the skill domain or a subdomain of it? The local caches hold test-polluted manifests
 * with `http://127.0.0.1:PORT/...` endpoints under a real domain (e.g. www.linkedin.com)
 * which the backend 422s. Keep only the genuinely-publishable endpoints.
 */
function endpointPublishable(ep: unknown, domain: string): boolean {
  const u = (ep as { url_template?: unknown })?.url_template;
  if (typeof u !== "string" || !isIndexableUrl(u)) return false;
  try {
    const host = new URL(u).hostname.toLowerCase();
    const d = domain.toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  } catch {
    return false;
  }
}

/**
 * Clean a shape-matching manifest down to endpoints that will actually LAND (same-domain
 * https). Returns the cleaned manifest, or null if nothing publishable remains — so the
 * backfill only sends what the backend accepts (no 422 storms, no rate-limit cascade).
 */
export function cleanBackfillManifest<T extends BackfillCandidate>(m: T): T | null {
  const endpoints = (m.endpoints as unknown[]).filter((ep) => endpointPublishable(ep, m.domain));
  if (endpoints.length === 0) return null;
  return { ...m, endpoints };
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
