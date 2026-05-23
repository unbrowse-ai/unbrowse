/**
 * Server-side semantic augmentation.
 *
 * The endpoint-skeleton enrichment LLM call used to run client-side
 * (src/graph/agent-augment.ts). The prompt engineering and model
 * orchestration now live here so the prompt is not shipped in the npm
 * bundle and the model can be swapped via server env without a client
 * release.
 *
 * Contract: the client sends already-sanitized endpoint payloads UP
 * (no secrets -- sample_request / sample_response are compacted by the
 * client before transit). This service runs the augmentation prompt and
 * returns enriched semantic metadata DOWN. It NEVER throws and NEVER
 * gates the caller -- on any failure (model unavailable, timeout, bad
 * JSON, augmentation disabled) it returns `{ endpoints: [] }` so the
 * client falls back to its local heuristic (generateLocalDescription).
 *
 * Substrate principle: this LABELS endpoints by the evidence the client
 * captured (URL, trigger URL, sample request/response, sibling context).
 * It does not prescribe. It is best-effort and never blocks the
 * index/publish pipeline.
 */

import type { Env } from "../types.js";

const CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const DEFAULT_MODEL = "moonshotai/Kimi-K2.5";
const AUGMENT_TIMEOUT_MS = 8000;

/** One captured binding the client surfaced for an endpoint. */
export type AugmentBinding = {
  key?: string;
  semantic_type?: string;
  required?: boolean;
  source?: string;
  example_value?: string;
};

/**
 * One endpoint skeleton from the client. Mirrors the shape produced by
 * `buildEndpointPayload` in src/graph/agent-augment.ts -- the client owns
 * selection + compaction; the server only reads what it was sent.
 */
export type AugmentEndpointPayload = {
  endpoint_id?: string;
  method?: string;
  url_template?: string;
  trigger_url?: string;
  description?: string;
  current_semantic?: {
    action_kind?: string;
    resource_kind?: string;
    description_out?: string;
    requires?: AugmentBinding[];
    provides?: AugmentBinding[];
    negative_tags?: string[];
  };
  sample_request?: unknown;
  sample_response?: unknown;
  example_fields?: string[];
};

export type AugmentRequest = {
  intent?: string;
  domain?: string;
  /**
   * Optional prior-knowledge preamble the client read from its local
   * domain notes. Passed through verbatim as additional LLM context
   * only -- the deterministic ranker never sees it.
   */
  note_preamble?: string;
  endpoints: AugmentEndpointPayload[];
};

export type AugmentEndpointSemantic = {
  endpoint_id?: string;
  action_kind?: string;
  resource_kind?: string;
  description_out?: string;
  requires?: AugmentBinding[];
  provides?: AugmentBinding[];
  negative_tags?: string[];
};

export type AugmentResponse = {
  endpoints: AugmentEndpointSemantic[];
};

const EMPTY: AugmentResponse = { endpoints: [] };

function semanticModel(env: Env): string {
  return (
    env.UNBROWSE_AGENT_SEMANTIC_MODEL ??
    env.UNBROWSE_AGENT_JUDGE_MODEL ??
    DEFAULT_MODEL
  );
}

function augmentEnabled(env: Env): boolean {
  return env.UNBROWSE_AGENT_SEMANTIC_AUGMENT !== "0";
}

/**
 * Run the augmentation prompt against the configured semantic model.
 * Returns enriched per-endpoint semantic metadata, or `{ endpoints: [] }`
 * on any failure. Never throws.
 */
export async function augmentEndpointsSemantic(
  env: Env,
  req: AugmentRequest,
): Promise<AugmentResponse> {
  if (!augmentEnabled(env)) return EMPTY;
  if (!env.NEBIUS_API_KEY) return EMPTY;
  const endpoints = Array.isArray(req.endpoints) ? req.endpoints : [];
  if (endpoints.length === 0) return EMPTY;

  const basePrompt = [
    "You refine learned API skill metadata for a web automation system.",
    "Return JSON only.",
    "Do not invent endpoints or binding keys.",
    "Only reuse keys already present in each endpoint's current requires/provides.",
    "Upgrade generic labels into better action/resource kinds and semantic binding types when grounded by the URL, trigger URL, sample request, sample response, and sibling endpoint context.",
    "Prefer precise semantic types like repository_owner, repository_name, profile_identifier, query_text, product_identifier, recommendation_placement_id.",
    "Reject generic output like identifier, input, resource unless no better grounded type exists.",
    "For each endpoint, produce endpoint_id plus any improved action_kind, resource_kind, description_out, requires, provides, and negative_tags.",
    "description_out must be instance-independent and transferable to any caller — never embed captured user IDs, session tokens, entity-specific values, or user-specific names in description_out.",
  ].join("\n");
  const preamble = typeof req.note_preamble === "string" ? req.note_preamble : "";
  const prompt = preamble ? `${preamble}${basePrompt}` : basePrompt;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUGMENT_TIMEOUT_MS);
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NEBIUS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: semanticModel(env),
        response_format: { type: "json_object" },
        // Pin determinism: the same captured endpoint must produce the
        // same semantic labels on repeat captures. Without this,
        // action_kind / resource_kind drift across captures and the
        // description the agent reads is unstable.
        temperature: 0,
        top_p: 0,
        seed: 1,
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content: JSON.stringify({
              intent: req.intent,
              domain: req.domain,
              endpoints,
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[semantic-augment] LLM call failed: ${res.status}`);
      return EMPTY;
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return EMPTY;
    const parsed = JSON.parse(content) as Partial<AugmentResponse>;
    const out = Array.isArray(parsed.endpoints) ? parsed.endpoints : [];
    return { endpoints: out };
  } catch (err) {
    console.error(`[semantic-augment] error: ${(err as Error).message}`);
    return EMPTY;
  } finally {
    clearTimeout(timeout);
  }
}
