/**
 * LLM Describer — Enrich endpoint documentation using an LLM.
 *
 * Calls OpenRouter (claude-3.5-haiku) or OpenAI (gpt-4o-mini) to generate
 * rich descriptions, parameter hints, and "when to use" guidance for each
 * endpoint. Falls back gracefully if no API key is available.
 */

import type { EndpointGroup } from "./types.js";

interface LlmEndpointInput {
  method: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  requestSchema?: string;
  responseSchema?: string;
}

interface LlmEndpointOutput {
  description: string;
  paramHints: Record<string, string>;
  whenToUse: string;
}

/**
 * Enrich endpoint groups with LLM-generated descriptions.
 * Mutates groups in-place: sets description, paramHints, whenToUse.
 *
 * Skips silently if no API key is available (heuristic descriptions remain).
 */
export async function enrichEndpointDescriptions(
  service: string,
  baseUrl: string,
  groups: EndpointGroup[],
  opts?: { apiKey?: string; model?: string },
): Promise<void> {
  if (groups.length === 0) return;

  const { apiKey, provider } = resolveProvider(opts?.apiKey);
  if (!apiKey) return; // No key — skip enrichment silently

  const endpoints: LlmEndpointInput[] = groups.map(g => ({
    method: g.method,
    path: g.normalizedPath,
    pathParams: g.pathParams.map(p => p.name),
    queryParams: g.queryParams.map(p => p.name),
    requestSchema: g.requestBodySchema?.summary,
    responseSchema: g.responseBodySchema?.summary,
  }));

  const prompt = buildPrompt(service, baseUrl, endpoints);

  try {
    const results = await callLlm(prompt, apiKey, provider, opts?.model);
    if (!results || results.length !== groups.length) return;

    for (let i = 0; i < groups.length; i++) {
      const r = results[i];
      if (!r) continue;
      if (r.description) groups[i].description = r.description;
      if (r.paramHints && Object.keys(r.paramHints).length > 0) {
        groups[i].paramHints = r.paramHints;
      }
      if (r.whenToUse) groups[i].whenToUse = r.whenToUse;
    }
  } catch {
    // LLM call failed — keep heuristic descriptions
  }
}

function buildPrompt(service: string, baseUrl: string, endpoints: LlmEndpointInput[]): string {
  return `You are documenting a reverse-engineered API for "${service}" (${baseUrl}).
Given these endpoints with their schemas, generate rich documentation.

For each endpoint, return:
- description: What this endpoint does (1 sentence, specific to ${service}). NEVER use generic phrases like "List resource" or "Get resource". Be specific about what data is returned.
- paramHints: For each path/query param, what it represents with an example value. NEVER embed literal identifiers from the URL — describe the parameter semantically.
- whenToUse: When an agent should call this endpoint (1 sentence).

Endpoints:
${JSON.stringify(endpoints, null, 2)}

Return a JSON array matching the input order. Each element: { "description": "...", "paramHints": { "paramName": "description (e.g. example_value)" }, "whenToUse": "..." }

IMPORTANT: Return ONLY the JSON array, no markdown fences, no explanation.`;
}

type Provider = "openrouter" | "openai";

function resolveProvider(explicitKey?: string): { apiKey: string | undefined; provider: Provider } {
  if (explicitKey) {
    return { apiKey: explicitKey, provider: "openrouter" };
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) return { apiKey: openrouterKey, provider: "openrouter" };

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) return { apiKey: openaiKey, provider: "openai" };

  return { apiKey: undefined, provider: "openrouter" };
}

async function callLlm(
  prompt: string,
  apiKey: string,
  provider: Provider,
  model?: string,
): Promise<LlmEndpointOutput[] | null> {
  const url = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";

  const modelId = model
    ?? (provider === "openrouter" ? "anthropic/claude-3.5-haiku" : "gpt-4o-mini");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return null;

  // Strip markdown fences if present
  const json = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed as LlmEndpointOutput[];
  } catch {
    return null;
  }
}
