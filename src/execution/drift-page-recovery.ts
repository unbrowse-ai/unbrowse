// Schema-drift page-fetch recovery.
//
// When executeEndpoint observes breaking schema drift on a previously
// learned API endpoint, the current substrate returns a structured
// schema_drift_recapture_required envelope with a re_capture_signal
// telling the agent to invoke unbrowse_go on the context URL. The
// agent then has to drive a separate browser session to refresh the
// shape, and the current execute call returns no useful data.
//
// This helper provides an inline recovery path. When drift fires AND a
// re-capture URL is available:
//   1. Try the SSR fast-path (libcurl-impersonate via Kuri sandbox).
//      Bypasses Cloudflare / Datadome / PerimeterX challenges that
//      reject plain Node fetch on its default TLS fingerprint.
//   2. If SSR fast-path returned HTML, run extractFromDOM and return
//      structured data if confidence is high enough.
//   3. Else fall back to plain tryHttpFetch (some sites work fine; no
//      Kuri sandbox dependency).
//
// Generic and structural: no per-domain logic. The signal that fires
// recovery is the substrate's own drift verdict; the data is whatever
// extractFromDOM finds. No second LLM, no heuristic verdict.
//
// Safety:
//   - Both fetches are best-effort. Either path failing returns null.
//   - Confidence threshold (>= 0.5) so we never overwrite a real drift
//     envelope with a junk extraction.
//   - Returns null on any failure (the caller falls back to the
//     envelope path).
//   - Best-effort: never throws.

import { tryHttpFetch } from "./index.js";
import { extractFromDOM } from "../extraction/index.js";
import { trySsrFastPathOnBlock } from "../capture/ssr-fastpath.js";

export interface DriftPageRecoveryResult {
  data: unknown;
  confidence: number;
  extraction_method: string;
  final_url: string;
  recovery_path: "ssr_fastpath" | "http_fetch";
}

export async function tryRecoverFromSchemaDrift(
  url: string,
  intent: string | undefined,
  authHeaders: Record<string, string> | undefined,
  cookies: Array<{ name: string; value: string; domain: string }> | undefined,
  options?: { minConfidence?: number },
): Promise<DriftPageRecoveryResult | null> {
  if (!url || typeof url !== "string" || url.length === 0) return null;
  const minConfidence = options?.minConfidence ?? 0.5;

  // Path 1: SSR fast-path (libcurl-impersonate via Kuri sandbox).
  // Beats CF/Datadome/PerimeterX on most sites where Node's bare fetch
  // gets a 403 challenge. The seedCookies parameter accepts the same
  // cookie shape we already carry.
  try {
    const ssrCookies = (cookies ?? []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
    }));
    const ssr = await trySsrFastPathOnBlock({
      url,
      seedCookies: ssrCookies.length > 0 ? ssrCookies : undefined,
      timeoutMs: 12000,
    });
    if (ssr && typeof ssr.html === "string" && ssr.html.length > 0) {
      const extracted = extractFromDOM(ssr.html, intent ?? "", url);
      if (extracted.data != null && extracted.confidence >= minConfidence) {
        return {
          data: extracted.data,
          confidence: extracted.confidence,
          extraction_method: extracted.extraction_method,
          final_url: ssr.final_url || url,
          recovery_path: "ssr_fastpath",
        };
      }
    }
  } catch {
    /* best-effort; fall through to plain http_fetch */
  }

  // Path 2: plain Node fetch with a Chrome UA. Works on sites that
  // don't gate on JA4. Cheaper than the sandbox path.
  try {
    const fetched = await tryHttpFetch(url, authHeaders ?? {}, cookies ?? []);
    if (!fetched) return null;
    const extracted = extractFromDOM(fetched.html, intent ?? "", url);
    if (extracted.data == null) return null;
    if (extracted.confidence < minConfidence) return null;
    return {
      data: extracted.data,
      confidence: extracted.confidence,
      extraction_method: extracted.extraction_method,
      final_url: fetched.final_url,
      recovery_path: "http_fetch",
    };
  } catch {
    return null;
  }
}

/**
 * Flatten a plain JS value into a Set of dot-path keys up to maxDepth levels.
 * Arrays descend into `[0]` (the shape, not enumerated indices).
 * Used to compare two structurally-distinct payloads for overlap.
 * Substrate-faithful: structural primitive, no per-domain knowledge.
 */
export function flattenKeys(value: unknown, maxDepth = 3): Set<string> {
  const keys = new Set<string>();
  function walk(v: unknown, prefix: string, depth: number): void {
    if (depth > maxDepth) return;
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      walk(v[0], prefix + "[]", depth); // arrays do not consume a depth level
      return;
    }
    if (typeof v === "object") {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${k}` : k;
        keys.add(path);
        walk((v as Record<string, unknown>)[k], path, depth + 1);
      }
    }
  }
  walk(value, "", 0);
  return keys;
}

/**
 * Flatten a captured `ResponseSchema` (JSON-Schema-like) into the same
 * dot-path key Set produced by `flattenKeys` for the live data. Walks
 * `properties` and descends into `items` for arrays (annotating with `[]`
 * to match flattenKeys's array convention).
 *
 * Typed `unknown` so the helper does not import the skill types and stays
 * substrate-neutral; callers pass `endpoint.response_schema`.
 */
export function flattenSchemaKeys(schema: unknown, maxDepth = 3): Set<string> {
  const keys = new Set<string>();
  function walk(node: unknown, prefix: string, depth: number): void {
    if (depth > maxDepth) return;
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; properties?: Record<string, unknown>; items?: unknown };
    if (n.properties && typeof n.properties === "object") {
      for (const k of Object.keys(n.properties)) {
        const path = prefix ? `${prefix}.${k}` : k;
        keys.add(path);
        walk(n.properties[k], path, depth + 1);
      }
    }
    if (n.items) {
      // arrays don't consume a depth level; the array's element shape is
      // the same logical level as the array itself.
      walk(n.items, prefix + "[]", depth);
    }
  }
  walk(schema, "", 0);
  return keys;
}

/**
 * Substrate-faithful shape-overlap gate for drift recovery.
 *
 * When `tryRecoverFromSchemaDrift` returns extracted data from a fallback
 * page-fetch, the data may have NO structural relationship to the original
 * endpoint's `response_schema` (real case: x.com /home logged-out SSR shell
 * with keys `optimist`, `entities`, `featureSwitch`, `settings` passed
 * extraction confidence 0.85 but had zero overlap with the actual
 * `data.home.home_timeline_urt.instructions[].entries[]` GraphQL contract).
 *
 * Returns `matches: true` when recovery is acceptable, `false` when it
 * should be rejected as structurally unrelated. Tiny schemas (<= 2 keys)
 * skip the check; confidence alone gates them.
 */
export function recoveredDataMatchesOriginalShape(
  originalSchema: unknown,
  recoveredData: unknown,
): {
  matches: boolean;
  originalKeys: string[];
  recoveredKeys: string[];
  intersection: string[];
  reason: "skipped_tiny_schema" | "no_overlap" | "overlap_found";
} {
  const originalSet = flattenSchemaKeys(originalSchema, 3);
  const recoveredSet = flattenKeys(recoveredData, 3);
  const originalKeys = Array.from(originalSet);
  const recoveredKeys = Array.from(recoveredSet);
  if (originalSet.size <= 2) {
    return { matches: true, originalKeys, recoveredKeys, intersection: [], reason: "skipped_tiny_schema" };
  }
  const intersection: string[] = [];
  originalSet.forEach((k) => {
    if (recoveredSet.has(k)) intersection.push(k);
  });
  if (intersection.length === 0) {
    return { matches: false, originalKeys, recoveredKeys, intersection, reason: "no_overlap" };
  }
  return { matches: true, originalKeys, recoveredKeys, intersection, reason: "overlap_found" };
}
