// Schema-drift page-fetch recovery.
//
// When `executeEndpoint` observes breaking schema drift on a previously
// learned API endpoint, the current substrate returns a structured
// `schema_drift_recapture_required` envelope with a `re_capture_signal`
// telling the agent to invoke `unbrowse_go` on the context URL. The
// agent then has to drive a separate browser session to refresh the
// shape, and the current execute call returns no useful data.
//
// This helper provides an inline recovery path: when drift fires AND a
// re-capture URL is available, do a single HTTP fetch of that URL, run
// DOM extraction on the response, and return the structured data IF
// extraction confidence is high enough. The agent gets useful page data
// on the same turn instead of an envelope.
//
// Generic and structural: no per-domain logic. The signal that fires
// recovery is the substrate's own drift verdict; the data is whatever
// `extractFromDOM` finds. No second LLM, no heuristic verdict.
//
// Safety:
//   - Single HTTP fetch with the existing 10s timeout.
//   - Confidence threshold (>= 0.5) so we never overwrite a real drift
//     envelope with a junk extraction.
//   - Returns null on any failure (the caller falls back to the
//     envelope path).
//   - Best-effort: never throws.

import { tryHttpFetch } from "./index.js";
import { extractFromDOM } from "../extraction/index.js";

export interface DriftPageRecoveryResult {
  data: unknown;
  confidence: number;
  extraction_method: string;
  final_url: string;
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
    };
  } catch {
    return null;
  }
}
