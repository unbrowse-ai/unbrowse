/**
 * Free residual: structural JSON-API mirror recovery.
 *
 * When the requested URL is JSON-API-shaped and the origin early-fetch missed
 * (DNS dead / CF 525 origin SSL), try path-compatible / path-transplanted
 * candidates from web-search hits. No host allowlist — tryDirectJsonFetch
 * fails closed on non-JSON. Settles as direct-fetch (strict usable), never a
 * soft browser-capture shell.
 *
 * Pure candidate construction lives in url-shape; this module owns the
 * bounded free-fetch settle loop for orchestrator / CLI callers.
 */
import {
  structuralJsonApiMirrorUrls,
  urlLooksLikeJsonApi,
} from "./url-shape.js";

export type JsonMirrorFetch = (
  url: string,
  opts?: { timeoutMs?: number },
) => Promise<{ data: unknown; content_type: string } | null>;

export interface JsonMirrorSettle {
  data: unknown;
  content_type: string;
  mirror_url: string;
  origin_url: string;
}

/**
 * Try free JSON fetch on structural mirrors derived from search hits.
 * Returns first usable JSON body or null. Bounded (default 5 mirrors).
 */
export async function settleJsonApiStructuralMirrors(opts: {
  requestedUrl: string;
  hits: ReadonlyArray<{ url: string }>;
  tryFetch: JsonMirrorFetch;
  timeoutMs?: number;
  maxMirrors?: number;
}): Promise<JsonMirrorSettle | null> {
  const { requestedUrl, hits, tryFetch } = opts;
  if (!urlLooksLikeJsonApi(requestedUrl) || hits.length === 0) return null;
  const mirrors = structuralJsonApiMirrorUrls(
    requestedUrl,
    hits,
    opts.maxMirrors ?? 5,
  );
  const timeoutMs = opts.timeoutMs ?? 8_000;
  for (const mirrorUrl of mirrors) {
    try {
      const out = await tryFetch(mirrorUrl, { timeoutMs });
      if (out && out.data != null) {
        return {
          data: out.data,
          content_type: out.content_type,
          mirror_url: mirrorUrl,
          origin_url: requestedUrl,
        };
      }
    } catch {
      /* best-effort mirror */
    }
  }
  return null;
}
