/**
 * route-snapshot — the pointer-keyed-cache primitive for the route cache.
 *
 * /contract's pointer-keyed truthy cache resolves a cache hit by a deterministic content
 * snapshot and fires `cache_invalidated` when an upstream pointer drifts. This is that shape
 * applied to unbrowse's route cache: a route's INPUT SHAPE (url template + holes + method +
 * response cardinality) is hashed to a snapshot; when a site's internal API drifts, the
 * snapshot changes, so the cached route is stale and must re-resolve — instead of silently
 * replaying a dead route (the `web-fallback-generic-fabrication` / stale-cached-resolve bug
 * class). Pure + deterministic; the IQ-bound invalidation recorder lives in cached-resolution.
 */
import { createHash } from "node:crypto";

export interface RouteShape {
  url_template?: string;
  method?: string;
  holes?: string[];
  param_names?: string[];
  response_cardinality?: string;
}

/** Deterministic content snapshot of a route's input shape — same shape → same snapshot, any process. */
export function routeInputSnapshot(r: RouteShape): string {
  const canon = JSON.stringify({
    t: r.url_template ?? "",
    m: (r.method ?? "GET").toUpperCase(),
    h: [...(r.holes ?? [])].map(String).sort(),
    p: [...(r.param_names ?? [])].map(String).sort(),
    c: r.response_cardinality ?? "",
  });
  return "snap:" + createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/** Drift = a prior snapshot exists AND differs from the current. First-resolve (no prior) is never drift. */
export function snapshotDrifted(prev: string | undefined | null, current: string): boolean {
  return !!prev && prev.length > 0 && prev !== current;
}

/** The sentinel result pointer recorded to the IQ ledger when a route is invalidated by shape-drift. */
export function invalidationPointer(snapshot: string, reason: string): string {
  const r = reason.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "drift";
  return `sha256:invalidated:${r}:${snapshot}`;
}
