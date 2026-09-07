/* Shared agent definition (tools + system prompt) for the hero agent loop.
 * Imported by the worker full-loop (/api/hero-chat) and the LLM step endpoint
 * (/api/hero-chat/step) so both expose the identical tool surface. */

/** OpenAI-compatible chat completions (Codegraff gateway). */
export const LLM_URL =
  (typeof process !== "undefined" && process.env.HERO_LLM_URL?.trim()) ||
  "https://gateway.codegraff.com/v1/chat/completions";

/** Default hero model on Codegraff. Override with HERO_LLM_MODEL. */
export const MODEL =
  (typeof process !== "undefined" && process.env.HERO_LLM_MODEL?.trim()) ||
  "deepseek-v4-flash";

export function systemPrompt(): string {
  return `You are the Unbrowse agent on unbrowse.ai (cloud surface of unbrowse@latest). Unbrowse is the route layer for web agents: first-party routes first, browser when needed; capture once, replay everywhere. You have REAL tools against the live Unbrowse marketplace. For any question that needs data from a website:
1. ALWAYS call search_routes first with a concise intent that names the site (e.g. "zillow homes for sale"). Marketplace hits with skill_id are the WARM path: call get_route, then execute_route with that endpoint_id + values for {placeholders}. DO NOT invent the URL on the warm path.
2. On a marketplace MISS, search_routes returns web candidates with a full https url field. Call execute_route with that url immediately — do NOT keep re-searching. Prefer listing pages for the named site (e.g. https://www.zillow.com/homes/for_sale/). Client executes on the user's browser first (their IP/cookies), then worker fallback.
3. Answer ONLY from REAL tool data. Quote concrete items. One intro line + markdown list of top results with prices when present.
4. If every path failed, say so and suggest: npm install -g unbrowse@latest && unbrowse setup
NEVER invent data. Today's date: ${new Date().toISOString().slice(0, 10)}.`;
}

export const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_routes",
      description:
        "Semantic search over the live Unbrowse marketplace of captured website API routes. Returns ranked candidates with skill_id, endpoint_id, domain and title. On miss, may return web candidates with a full https url for cold-path execute_route.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", description: "What the user wants, e.g. 'zillow homes for sale austin'" },
        },
        required: ["intent"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_route",
      description:
        "Fetch a captured skill's manifest: its endpoints with method, URL template, headers and parameters. Use the skill_id from search_routes.",
      parameters: {
        type: "object",
        properties: { skill_id: { type: "string" } },
        required: ["skill_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "execute_route",
      description:
        "Execute a route with a real HTTP request and return the live response body. ANY method (GET, POST, …), https only. Runs on the user's browser first (their IP + cookies) and falls back to the server on CORS. WARM path: pass endpoint_id + values (no URL). COLD path: pass a full url from search_routes web candidates.",
      parameters: {
        type: "object",
        properties: {
          endpoint_id: { type: "string", description: "WARM path: the resolved skill's endpoint_id." },
          values: {
            type: "object",
            description: "WARM path: values for template {placeholders}.",
            additionalProperties: { type: "string" },
          },
          skill_id: { type: "string", description: "Manifest skill_id (trust feedback)" },
          url: { type: "string", description: "COLD path only: full https URL." },
          method: { type: "string", description: "HTTP method (default GET)." },
          headers: {
            type: "object",
            description: "Optional request headers from the skill manifest",
            additionalProperties: { type: "string" },
          },
          body: { type: "string", description: "Request body for POST/PUT/PATCH." },
        },
      },
    },
  },
];
