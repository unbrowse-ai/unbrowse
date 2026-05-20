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
      const extracted = extractFromDOM(ssr.html, intent ?? "");
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
    const extracted = extractFromDOM(fetched.html, intent ?? "");
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
