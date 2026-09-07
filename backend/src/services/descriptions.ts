/**
 * LLM-powered endpoint description generation.
 *
 * Called during publishSkill() to generate human-readable descriptions
 * for endpoints that lack them. Descriptions power BM25 matching so
 * the orchestrator can auto-select the right endpoint for an intent.
 */

import type { Env, EndpointDescriptor } from "../types.js";

const CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const MODEL = "moonshotai/Kimi-K2.5";

/** Extract the most meaningful identifier from a URL template */
function extractEndpointIdentifier(url: string): string {
  try {
    const u = new URL(url);
    // GraphQL: extract queryId name (e.g., voyagerFeedDashMainFeed)
    const qid = u.searchParams.get("queryId") ?? "";
    const match = qid.match(/^([a-zA-Z]+)\./);
    if (match) return match[1];
    // REST: use last meaningful path segment
    const segs = u.pathname.split("/").filter((s) => s.length > 1 && !s.startsWith("{") && !/^v\d+$/.test(s));
    return segs[segs.length - 1] ?? u.pathname;
  } catch {
    return url.slice(0, 80);
  }
}

/** Extract top-level schema property names (max 2 levels) */
function schemaKeys(ep: EndpointDescriptor): string {
  if (!ep.response_schema?.properties) return "";
  const top = Object.keys(ep.response_schema.properties);
  const nested: string[] = [];
  for (const [k, v] of Object.entries(ep.response_schema.properties)) {
    const sub = v as { properties?: Record<string, unknown> };
    if (sub?.properties) {
      nested.push(`${k}:{${Object.keys(sub.properties).slice(0, 5).join(",")}}`);
    } else {
      nested.push(k);
    }
  }
  return nested.slice(0, 10).join(", ");
}

function collectTemplateParams(value: unknown, params: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{([^}]+)\}/g)) {
      const param = match[1]?.trim();
      if (param) params.add(param);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTemplateParams(item, params);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      params.add(key);
      collectTemplateParams(nested, params);
    }
  }
}

function collectParamNames(ep: EndpointDescriptor): string[] {
  const params = new Set<string>();
  collectTemplateParams(ep.url_template, params);
  collectTemplateParams(ep.query, params);
  collectTemplateParams(ep.body, params);
  collectTemplateParams(ep.headers_template, params);
  return Array.from(params).sort();
}

function actionKind(method: EndpointDescriptor["method"]): "read" | "create" | "update" | "delete" | "stream" {
  switch (method) {
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    case "WS":
      return "stream";
    default:
      return "read";
  }
}

/** Build a compact summary line for one endpoint (used in the LLM prompt) */
/** Build a compact summary line for one endpoint (used in the LLM prompt) */
function endpointSummary(ep: EndpointDescriptor, idx: number): string {
  const id = extractEndpointIdentifier(ep.url_template);
  const keys = schemaKeys(ep);
  const trigger = ep.trigger_url ? ` (page: ${new URL(ep.trigger_url).pathname})` : "";
  const params = collectParamNames(ep);
  const action = actionKind(ep.method);
  const paramStr = params.length > 0 ? ` | params: ${params.join(", ")}` : "";
  const actionStr = action !== "read" ? ` [${action}]` : "";
  return `${idx + 1}. ${ep.method} ${id}${keys ? ` — fields: ${keys}` : ""}${paramStr}${actionStr}${trigger}`;
}

/**
 * Generate descriptions for endpoints missing them via a single LLM call.
 * Mutates endpoints in-place. On failure, falls back to heuristic descriptions.
 */
export async function generateDescriptions(
  env: Env,
  endpoints: EndpointDescriptor[]
): Promise<void> {
  const needDesc = endpoints.filter((ep) => !ep.description);
  if (needDesc.length === 0) return;

  // Build the batch prompt
  const lines = needDesc.map((ep, i) => endpointSummary(ep, i));
  const prompt = `For each API endpoint below, write a concise description (10-20 words) of what data it returns.
Focus on the data type: feed posts, notifications, user profiles, search results, messages, etc.
Include key data fields when obvious from the schema.

${lines.join("\n")}

Respond with ONLY numbered descriptions, one per line. Example:
1. Returns user's main feed posts including author name, post text, and engagement metrics
2. Returns notification cards for connection requests and activity alerts`;

  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.NEBIUS_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "You describe API endpoints concisely. Output only numbered descriptions." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: needDesc.length * 50,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[descriptions] LLM call failed: ${res.status} ${errText.slice(0, 200)}`);
      applyHeuristicDescriptions(needDesc);
      return;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const descLines = text.split("\n").filter((l) => /^\d+\./.test(l.trim()));

    // Parse numbered lines and assign to endpoints
    for (let i = 0; i < needDesc.length; i++) {
      const line = descLines[i];
      if (line) {
        // Strip leading number and dot
        needDesc[i].description = line.replace(/^\d+\.\s*/, "").trim();
      } else {
        needDesc[i].description = heuristicDescription(needDesc[i]);
      }
    }

    console.log(`[descriptions] Generated ${descLines.length}/${needDesc.length} LLM descriptions`);
  } catch (err) {
    console.error(`[descriptions] LLM error: ${(err as Error).message}`);
    applyHeuristicDescriptions(needDesc);
  }
}

/** Fallback: generate description from URL pattern + schema keys */
export function heuristicDescription(ep: EndpointDescriptor): string {
  const id = extractEndpointIdentifier(ep.url_template);
  // Split camelCase: voyagerFeedDashMainFeed → voyager Feed Dash Main Feed
  const words = id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase();

  // Strip common LinkedIn/site prefixes to get meaningful core: "voyager feed dash main feed" → "feed main feed"
  const stripped = words
    .replace(/^(voyager|api|graphql|dash)\s+/g, "")
    .replace(/\b(voyager|dash|graphql)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const keys = schemaKeys(ep);
  // Build description: "Returns [core endpoint name]" + schema info
  const core = stripped || words;
  const parts = [`Returns ${core} data`];
  if (keys) parts.push(`fields: ${keys}`);
  return parts.join(". ");
}

function applyHeuristicDescriptions(endpoints: EndpointDescriptor[]): void {
  for (const ep of endpoints) {
    if (!ep.description) {
      ep.description = heuristicDescription(ep);
    }
  }
}
