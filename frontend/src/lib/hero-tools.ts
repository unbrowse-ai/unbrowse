/* Shared agent definition (tools + system prompt) for the hero agent loop.
 * Imported by the worker full-loop (/api/hero-chat) and the LLM step endpoint
 * (/api/hero-chat/step) so both expose the identical tool surface. */

export const NEBIUS_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
export const MODEL = "moonshotai/Kimi-K2.5";

export function systemPrompt(): string {
  return `You are the Unbrowse agent on unbrowse.ai. Unbrowse turns websites into reusable API routes: capture once, replay everywhere. You have REAL tools. For any question that needs data from a website:
1. ALWAYS call search_routes first with a concise intent. A hit is the WARM path: call get_route, then execute_route on its endpoint. Fill template placeholders like {query} from the user's ask, set method/body for POST routes from the manifest, and pass the manifest's skill_id + endpoint_id so the execution feeds the route's trust score.
2. On a marketplace MISS, take the COLD path (this is how Unbrowse captures a site on first visit): call execute_route directly on the site's own public search/listing URL or API for the ask — e.g. https://hn.algolia.com/api/v1/search?query=X&tags=front_page for Hacker News, https://www.airbnb.com.sg/s/homes?query=cats for Airbnb. The executor extracts the page's embedded SSR/JSON state automatically.
3. Answer ONLY from the REAL data the tools returned. Quote concrete items (names, prices, ratings, titles). Keep it tight: one intro line, then a markdown list of the top 5-8 results. Include prices/ratings when present.
4. If every tool path failed, say so plainly and suggest running Unbrowse locally (npx unbrowse setup --mcp) to capture the site with a real browser.
NEVER invent data. NEVER claim you fetched something you didn't. Today's date: ${new Date().toISOString().slice(0, 10)}.`;
}

export const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_routes",
      description:
        "Semantic search over the live Unbrowse marketplace of captured website API routes. Returns ranked candidates with skill_id, endpoint_id, domain and title.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", description: "What the user wants, e.g. 'search airbnb listings'" },
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
        "Execute a route with a real HTTP request and return the live response body. ANY method (GET, POST, …), https only. It runs on the user's own browser first (their IP + cookies) and falls back to the server on CORS. Fill template placeholders and, for POST/PUT, set method + body.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full https URL with params filled in" },
          method: { type: "string", description: "HTTP method (default GET). Use POST/PUT/etc for routes that require it." },
          headers: {
            type: "object",
            description: "Optional request headers from the skill manifest (no cookies/auth — those ride from the user's browser)",
            additionalProperties: { type: "string" },
          },
          body: { type: "string", description: "Request body for POST/PUT/PATCH (JSON string or form-encoded). Omit for GET." },
          skill_id: { type: "string", description: "Manifest skill_id when executing a captured route (enables trust feedback)" },
          endpoint_id: { type: "string", description: "Manifest endpoint_id when executing a captured route" },
        },
        required: ["url"],
      },
    },
  },
];
