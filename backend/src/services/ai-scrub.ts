/**
 * LLM-layer PII scrubber for publish-time endpoint descriptions.
 *
 * Sits AFTER `enforcePublishSanitization` + `detectResidualSecretLeak`
 * (the regex/token-shape scrubber). A cheap-model LLM call inspects each
 * endpoint's textual surface (`description`, `semantic.description_out`,
 * parameter examples, response excerpt) for residual PII / cookie / bearer
 * leaks the regex misses (e.g. real-shaped phone numbers, named individuals,
 * partial-PII descriptions, "your bearer is ..." prose where the value
 * itself doesn't match a regex pattern).
 *
 * Contract:
 *   - Best-effort, soft-fail. If NEBIUS_API_KEY is unset, model unavailable,
 *     timeout, or the JSON is malformed, we return `{scrubbed: false,
 *     rejected: false, ...}` and the publish proceeds (the regex layer is
 *     still authoritative; this is a defense-in-depth layer).
 *   - High-confidence leaks -> the endpoint's textual fields are WIPED to a
 *     structural pointer placeholder ("[scrubbed: <reason>]") rather than
 *     held as the original value (contract 3c2dd353 pointer-not-payload).
 *     `rejected = true` is returned so the caller can choose to 422 instead
 *     of silently shipping the wiped descriptor.
 *   - Budget caps: max 30 endpoints per publish, 8s timeout per call.
 *
 * Substrate principle: the LLM LABELS what the regex missed. It does not
 * invent policy beyond "is this textual field leaking PII the regex
 * skipped?". The reasons it returns are surfaced to the caller for the
 * 422 error body.
 */

import type { Env } from "../types.js";
import type { SanitizableEndpoint } from "./publish-sanitize.js";

const CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const DEFAULT_MODEL = "moonshotai/Kimi-K2.5";
const SCRUB_TIMEOUT_MS = 8000;
const MAX_SCRUB_ENDPOINTS = 30;

export interface AiScrubResult {
  endpoints: SanitizableEndpoint[];
  scrubbed: boolean;
  llm_residual: number;
  rejected: boolean;
  reasons: string[];
}

type LlmLeak = { field?: string; reason?: string };
type LlmVerdict = {
  endpoint_id?: string;
  leaks?: LlmLeak[];
  scrubbed?: string;
};

function scrubModel(env: Env): string {
  return env.UNBROWSE_AI_SCRUB_MODEL ?? DEFAULT_MODEL;
}

/**
 * Extract the textual surface the LLM should inspect for a single endpoint.
 * Mirrors the publish-sanitize fields that hold free-form text (the ones the
 * regex layer scans but a regex can still miss PII prose).
 */
function endpointTextualSurface(ep: SanitizableEndpoint): Record<string, string> {
  const surface: Record<string, string> = {};
  if (typeof ep.description === "string" && ep.description.length > 0) {
    surface.description = ep.description;
  }
  const semantic = ep.semantic as Record<string, unknown> | undefined;
  if (semantic) {
    const descOut = semantic.description_out;
    if (typeof descOut === "string" && descOut.length > 0) {
      surface["semantic.description_out"] = descOut;
    }
    const descIn = semantic.description_in;
    if (typeof descIn === "string" && descIn.length > 0) {
      surface["semantic.description_in"] = descIn;
    }
    const respSummary = semantic.response_summary;
    if (typeof respSummary === "string" && respSummary.length > 0) {
      surface["semantic.response_summary"] = respSummary;
    }
    const exampleResp = semantic.example_response_compact;
    if (exampleResp != null) {
      try {
        surface["semantic.example_response_compact"] = JSON.stringify(exampleResp).slice(0, 2000);
      } catch {
        /* skip */
      }
    }
    const exampleReq = semantic.example_request;
    if (exampleReq != null) {
      try {
        surface["semantic.example_request"] = JSON.stringify(exampleReq).slice(0, 2000);
      } catch {
        /* skip */
      }
    }
  }
  return surface;
}

/**
 * Wipe a flagged endpoint's textual fields to structural pointer placeholders.
 * Replaces the original value with `[scrubbed: <reason>]` rather than the
 * original prose, in line with contract 3c2dd353 (pointer-not-payload) and
 * feedback_deep_indexing_language (never hold raw values).
 */
function wipeEndpointTextualFields(
  ep: SanitizableEndpoint,
  leaks: LlmLeak[],
): SanitizableEndpoint {
  const reason = leaks.map((l) => l.reason).filter(Boolean).join("; ") || "pii_detected";
  const placeholder = `[scrubbed: ${reason.slice(0, 120)}]`;
  const flaggedFields = new Set(leaks.map((l) => l.field).filter((f): f is string => typeof f === "string"));
  const wipeAll = flaggedFields.size === 0;

  const out: SanitizableEndpoint = { ...ep };
  if (wipeAll || flaggedFields.has("description")) {
    if (typeof out.description === "string") out.description = placeholder;
  }
  const semantic = (out.semantic ? { ...out.semantic } : undefined) as Record<string, unknown> | undefined;
  if (semantic) {
    if (wipeAll || flaggedFields.has("semantic.description_out")) {
      if (typeof semantic.description_out === "string") semantic.description_out = placeholder;
    }
    if (wipeAll || flaggedFields.has("semantic.description_in")) {
      if (typeof semantic.description_in === "string") semantic.description_in = placeholder;
    }
    if (wipeAll || flaggedFields.has("semantic.response_summary")) {
      if (typeof semantic.response_summary === "string") semantic.response_summary = placeholder;
    }
    if (wipeAll || flaggedFields.has("semantic.example_response_compact")) {
      if (semantic.example_response_compact != null) semantic.example_response_compact = placeholder;
    }
    if (wipeAll || flaggedFields.has("semantic.example_request")) {
      if (semantic.example_request != null) semantic.example_request = placeholder;
    }
    out.semantic = semantic as SanitizableEndpoint["semantic"];
  }
  return out;
}

/**
 * Run the LLM scrub over already-regex-scrubbed endpoints.
 *
 * Never throws. On any failure (no key, timeout, malformed JSON) returns
 * an honest gap (rejected:false, reasons populated) so the caller can
 * decide. The default behavior at the publish route is to fail closed
 * (422) on `rejected: true`.
 */
export async function aiScrubEndpoints(
  endpoints: SanitizableEndpoint[],
  env: Env,
): Promise<AiScrubResult> {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return { endpoints: endpoints ?? [], scrubbed: false, llm_residual: 0, rejected: false, reasons: [] };
  }
  if (!env.NEBIUS_API_KEY) {
    // Soft-fail: no key configured. Defense-in-depth layer is OFF; regex
    // layer remains authoritative. Mark rejected:false so publish proceeds.
    console.error("[ai-scrub] NEBIUS_API_KEY unset; skipping LLM scrub pass");
    return { endpoints, scrubbed: false, llm_residual: 0, rejected: false, reasons: ["nebius_key_unset"] };
  }

  const targets = endpoints.slice(0, MAX_SCRUB_ENDPOINTS);
  const overflow = endpoints.slice(MAX_SCRUB_ENDPOINTS);

  const systemPrompt = [
    "You are a strict PII redactor for an API endpoint marketplace.",
    "Each user message contains ONE endpoint's textual fields (description, semantic.description_out, response excerpts, request/response examples).",
    "Inspect every field for residual leaks that a regex token-shape scrubber would have missed.",
    "HIGH-CONFIDENCE LEAKS (must flag):",
    "  - bearer tokens, JWT-shaped strings, session cookies (even when described in prose, e.g. 'your bearer is abc123')",
    "  - real-shaped phone numbers, including hyphenated (+1-415-555-0123) or grouped (415 555 0123)",
    "  - real-shaped email addresses pointing to non-example.com domains",
    "  - real-shaped SSN, credit card, government IDs",
    "  - full personal names paired with identifying info (address, phone, email, account id)",
    "  - leaked API keys, secret tokens, OAuth client secrets",
    "DO NOT FLAG:",
    "  - generic placeholders like user@example.com, [REDACTED], example-value, 12345",
    "  - schema descriptions without real values (e.g. 'returns the user phone number' - abstract is fine; concrete '+1-415-555-0123' is not)",
    "Return JSON only, of the shape: {\"leaks\":[{\"field\":\"<field path>\",\"reason\":\"<short reason>\"}]}",
    "If nothing is flagged, return {\"leaks\":[]}.",
  ].join("\n");

  const reasons: string[] = [];
  const outEndpoints: SanitizableEndpoint[] = [];
  let llmResidual = 0;
  let scrubbedAny = false;
  let rejected = false;

  for (const ep of targets) {
    const surface = endpointTextualSurface(ep);
    if (Object.keys(surface).length === 0) {
      outEndpoints.push(ep);
      continue;
    }
    const userPayload = {
      endpoint_id: ep.endpoint_id,
      method: ep.method,
      url_template: ep.url_template,
      fields: surface,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCRUB_TIMEOUT_MS);
    let verdict: LlmVerdict | null = null;
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NEBIUS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: scrubModel(env),
          response_format: { type: "json_object" },
          temperature: 0,
          top_p: 0,
          seed: 1,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(userPayload) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`[ai-scrub] LLM call failed: ${res.status} for endpoint_id=${ep.endpoint_id ?? "?"}`);
        reasons.push(`llm_call_failed_${res.status}`);
        outEndpoints.push(ep);
        continue;
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        outEndpoints.push(ep);
        continue;
      }
      verdict = JSON.parse(content) as LlmVerdict;
    } catch (err) {
      console.error(`[ai-scrub] error for endpoint_id=${ep.endpoint_id ?? "?"}: ${(err as Error).message}`);
      reasons.push(`llm_error:${(err as Error).message.slice(0, 80)}`);
      outEndpoints.push(ep);
      continue;
    } finally {
      clearTimeout(timeout);
    }

    const leaks = Array.isArray(verdict?.leaks)
      ? verdict!.leaks!.filter((l): l is LlmLeak => !!l && typeof l === "object")
      : [];
    if (leaks.length === 0) {
      outEndpoints.push(ep);
      continue;
    }
    // High-confidence leak: wipe textual fields to structural pointer placeholder.
    llmResidual += leaks.length;
    scrubbedAny = true;
    rejected = true;
    for (const l of leaks) {
      if (l.reason) reasons.push(`${ep.endpoint_id ?? "?"}:${l.field ?? "?"}:${l.reason}`);
    }
    outEndpoints.push(wipeEndpointTextualFields(ep, leaks));
  }

  // Append untouched overflow (above the 30-endpoint cap).
  for (const ep of overflow) outEndpoints.push(ep);

  return {
    endpoints: outEndpoints,
    scrubbed: scrubbedAny,
    llm_residual: llmResidual,
    rejected,
    reasons,
  };
}
