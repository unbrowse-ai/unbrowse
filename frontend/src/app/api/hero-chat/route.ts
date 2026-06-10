/*
 * POST /api/hero-chat — the hero chat bar's agent loop, server-side.
 *
 * This is the real product demo: the LLM gets actual tools against the live
 * marketplace — search captured routes, fetch the skill manifest, execute the
 * endpoint with a real HTTP call — and answers from the data that comes back.
 * Every tool call is returned as a step so the UI can show the route the
 * answer took (search → execute → answer), with latencies.
 *
 * No tools, no answer: if the marketplace has no route for the ask, the agent
 * says so honestly instead of pretending.
 */

import { getConfiguredApiOrigin } from "@/lib/api-base";

export const runtime = "nodejs";
export const maxDuration = 30;

const NEBIUS_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const MODEL = "moonshotai/Kimi-K2.5";
const MAX_TOOL_ROUNDS = 6;
const FETCH_TIMEOUT_MS = 9000;
const BODY_CAP = 7000; // chars of tool output fed back to the model

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface HeroStep {
  tool: string;
  label: string;
  ms: number;
  ok: boolean;
}

const SYSTEM_PROMPT = `You are the Unbrowse agent on unbrowse.ai. Unbrowse turns websites into reusable API routes: capture once, replay everywhere. You have REAL tools. For any question that needs data from a website:
1. ALWAYS call search_routes first with a concise intent. A hit is the WARM path: call get_route, then execute_route on its endpoint (fill template placeholders like {query} from the user's ask, and pass the manifest's skill_id + endpoint_id so the execution feeds the route's trust score).
2. On a marketplace MISS, take the COLD path (this is how Unbrowse captures a site on first visit): call execute_route directly on the site's own public search/listing URL for the ask — e.g. https://www.airbnb.com.sg/s/homes?query=cats for Airbnb, https://news.ycombinator.com/ for Hacker News front page, https://hn.algolia.com/api/v1/search?query=X for HN search. The executor extracts the page's embedded SSR/JSON state automatically, the same way Unbrowse's capture engine does.
3. Answer ONLY from the REAL data the tools returned. Quote concrete items (names, prices, ratings, titles). Keep it tight: one intro line, then a markdown list of the top 5-8 results. If a price/rating is in the data, include it.
4. If every tool path failed, say so plainly and suggest running Unbrowse locally (npx unbrowse setup --mcp) to capture the site with a real browser.
NEVER invent data. NEVER claim you fetched something you didn't. Today's date: ${new Date().toISOString().slice(0, 10)}.`;

const TOOLS = [
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
        "Execute a captured route with a real HTTP request and return the live response body (truncated). GET only, https only. Fill template placeholders before calling.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full https URL with params filled in" },
          headers: {
            type: "object",
            description: "Optional request headers from the skill manifest (no cookies)",
            additionalProperties: { type: "string" },
          },
          skill_id: { type: "string", description: "When executing a route from a skill manifest, the manifest's skill_id (enables trust feedback)" },
          endpoint_id: { type: "string", description: "When executing a route from a skill manifest, the endpoint's endpoint_id" },
        },
        required: ["url"],
      },
    },
  },
];

/** Report a real execution outcome back to the marketplace trust loop (the
 * continuous-trust model: success/failure traces from a distinct agent are
 * what verify and rank routes). Fire-and-forget with a short cap so it never
 * holds up the answer. */
async function reportExecution(apiOrigin: string, skillId: string, endpointId: string, ok: boolean, statusCode: number, startedAt: string): Promise<void> {
  const key = process.env.UNBROWSE_AGENT_KEY;
  if (!key) return;
  try {
    await fetch(`${apiOrigin}/v1/stats/execution`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        skill_id: skillId,
        endpoint_id: endpointId,
        trace: {
          trace_id: `hero-${Date.now()}-${endpointId.slice(0, 6)}`,
          skill_id: skillId,
          endpoint_id: endpointId,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          success: ok,
          status_code: statusCode,
          api_call_count: 1,
        },
      }),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* trust feedback is best-effort */
  }
}

function truncate(s: string, n = BODY_CAP): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
}

/* ---- cold-path extraction: pull structured data out of an HTML page ---- */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Find embedded SSR JSON blobs (Next.js, Airbnb deferred-state, Apollo, generic
 * application/json script tags) and parse the largest ones. */
function embeddedJsonBlobs(html: string): Json[] {
  const blobs: Json[] = [];
  const scriptRe = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const raw: string[] = [];
  while ((m = scriptRe.exec(html)) !== null) {
    if (m[1] && m[1].length > 2000) raw.push(m[1]);
  }
  const nextData = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (nextData?.[1]) raw.push(nextData[1]);
  raw.sort((a, b) => b.length - a.length);
  for (const r of raw.slice(0, 3)) {
    try {
      blobs.push(JSON.parse(r) as Json);
    } catch {
      /* not valid JSON */
    }
  }
  return blobs;
}

/** Keys that mark a list as result-shaped (vs i18n/config junk). */
const SIGNAL = /name|title|price|rating|listing|review|url|label/i;

/** Flatten one object to its scalar leaves (depth ≤ 3), skipping noise keys. */
function flattenItem(o: Record<string, Json>, depth = 0): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("__")) continue;
    if (v === null) continue;
    if (typeof v === "string") {
      if (v.length > 0 && v.length <= 220 && !v.startsWith("data:")) out[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (depth < 3 && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(flattenItem(v as Record<string, Json>, depth + 1))) {
        out[`${k}.${k2}`] = v2;
      }
    }
  }
  return out;
}

/** Score+collect arrays of objects (likely result lists) inside a JSON tree.
 * Signal-weighted: lists whose flattened keys look like results (name/price/
 * rating/…) beat bigger but junk-shaped lists (i18n tables, badge configs). */
function collectLists(node: Json, depth = 0, out: { list: Record<string, Json>[]; score: number }[] = []): { list: Record<string, Json>[]; score: number }[] {
  if (depth > 14 || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    const objs = node.filter((x): x is Record<string, Json> => !!x && typeof x === "object" && !Array.isArray(x));
    if (objs.length >= 3) {
      const flatKeys = Object.keys(flattenItem(objs[0]));
      const signal = new Set(
        flatKeys.filter((k) => SIGNAL.test(k)).map((k) => (k.toLowerCase().match(SIGNAL) as RegExpMatchArray)[0]),
      ).size;
      const keys = new Set<string>();
      for (const o of objs.slice(0, 5)) for (const k of Object.keys(o)) keys.add(k);
      out.push({ list: objs, score: objs.length * keys.size * (1 + 3 * signal) });
    }
    for (const x of node) collectLists(x, depth + 1, out);
  } else {
    for (const v of Object.values(node)) collectLists(v, depth + 1, out);
  }
  return out;
}

/** Cold-path extraction: HTML → the richest embedded result lists, flattened. */
function extractFromHtml(html: string): string | null {
  const blobs = embeddedJsonBlobs(html);
  if (!blobs.length) return null;
  const lists = blobs.flatMap((b) => collectLists(b)).sort((a, b) => b.score - a.score);
  if (!lists.length) return null;
  const picked: Record<string, string | number | boolean>[] = [];
  for (const { list } of lists.slice(0, 2)) {
    for (const item of list.slice(0, 12)) {
      const flat = flattenItem(item);
      if (Object.keys(flat).length >= 2) picked.push(flat);
      if (picked.length >= 16) break;
    }
    if (picked.length >= 8) break;
  }
  if (!picked.length) return null;
  return JSON.stringify({ extracted_from: "embedded SSR state", items: picked });
}

/** Last-resort: strip tags to readable text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** SSRF guard: https only, no localhost/private-looking hosts, GET only. */
function urlAllowed(raw: string): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "https only" };
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    host.includes("[")
  ) {
    return { ok: false, reason: "host not allowed" };
  }
  return { ok: true };
}

async function runTool(name: string, args: Record<string, unknown>, apiOrigin: string): Promise<{ output: string; label: string; ok: boolean }> {
  if (name === "search_routes") {
    const intent = String(args.intent ?? "").slice(0, 300);
    const res = await fetch(`${apiOrigin}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { output: `search failed: HTTP ${res.status}`, label: `search · ${intent}`, ok: false };
    const data = (await res.json()) as { results?: { id?: string; score?: number; metadata?: Record<string, unknown> }[] };
    const rows = (data.results ?? []).slice(0, 6).map((r) => {
      const m = r.metadata ?? {};
      // skill/endpoint ids ride inside metadata.content (JSON string) on this index
      let inner: Record<string, unknown> = {};
      try {
        inner = JSON.parse(String(m.content ?? "{}"));
      } catch {
        /* not json */
      }
      return {
        skill_id: inner.skill_id ?? (r.id ?? "").split(":")[0],
        endpoint_id: inner.endpoint_id ?? (r.id ?? "").split(":")[1],
        domain: inner.domain ?? m.source_url ?? "",
        title: m.title ?? inner.name ?? "",
        score: Number((r.score ?? 0).toFixed(3)),
      };
    });
    return { output: JSON.stringify(rows.length ? rows : { results: [], note: "no captured routes matched this intent" }), label: `search · ${intent}`, ok: true };
  }

  if (name === "get_route") {
    const skillId = encodeURIComponent(String(args.skill_id ?? ""));
    const res = await fetch(`${apiOrigin}/v1/skills/${skillId}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 402) return { output: "this skill is payment-gated for anonymous calls", label: `manifest · ${skillId}`, ok: false };
    if (!res.ok) return { output: `manifest fetch failed: HTTP ${res.status}`, label: `manifest · ${skillId}`, ok: false };
    const skill = (await res.json()) as Record<string, unknown>;
    // Trim to what the model needs: endpoints with method/url/headers/params.
    const endpoints = (Array.isArray(skill.endpoints) ? skill.endpoints : []).slice(0, 10).map((e) => {
      const ep = e as Record<string, unknown>;
      return {
        endpoint_id: ep.endpoint_id ?? ep.id,
        method: ep.method,
        url: ep.url ?? ep.url_template ?? ep.path,
        description: ep.description ?? ep.intent ?? "",
        headers: ep.headers ?? undefined,
        params: ep.params ?? ep.query_params ?? undefined,
      };
    });
    return {
      output: JSON.stringify({ skill_id: skill.skill_id, domain: skill.domain, endpoints }),
      label: `manifest · ${String(skill.domain ?? skillId)}`,
      ok: true,
    };
  }

  if (name === "execute_route") {
    const url = String(args.url ?? "");
    const gate = urlAllowed(url);
    if (!gate.ok) return { output: `blocked: ${gate.reason}`, label: `GET ${url.slice(0, 80)}`, ok: false };
    const hdrs: Record<string, string> = { accept: "application/json, text/html;q=0.5", "user-agent": "unbrowse-hero/1.0" };
    const passed = (args.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(passed).slice(0, 8)) {
      const key = k.toLowerCase();
      if (key === "cookie" || key === "authorization" || key === "host") continue;
      hdrs[k] = String(v).slice(0, 500);
    }
    const host = new URL(url).host;
    hdrs["user-agent"] =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    const startedAt = new Date().toISOString();
    const res = await fetch(url, { method: "GET", headers: hdrs, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    const text = await res.text();
    // Warm-path execution: feed the real outcome back into the marketplace
    // trust loop (success traces from a distinct agent verify + rank routes).
    const skillId = String(args.skill_id ?? "");
    const endpointId = String(args.endpoint_id ?? "");
    if (skillId && endpointId) {
      await reportExecution(apiOrigin, skillId, endpointId, res.ok, res.status, startedAt);
    }
    const ct = res.headers.get("content-type") ?? "";
    const looksHtml = ct.includes("html") || text.trimStart().startsWith("<");
    if (looksHtml) {
      // Cold path: same move as the capture engine's SSR extraction — the
      // page's embedded JSON state IS the API response.
      const extracted = extractFromHtml(text);
      if (extracted) {
        return { output: `HTTP ${res.status}\n${truncate(extracted)}`, label: `GET ${host} · extracted SSR data`, ok: res.ok };
      }
      return { output: `HTTP ${res.status}\n${truncate(htmlToText(text))}`, label: `GET ${host} · page text`, ok: res.ok };
    }
    return {
      output: `HTTP ${res.status}\n${truncate(text)}`,
      label: `GET ${host}`,
      ok: res.ok,
    };
  }

  return { output: `unknown tool: ${name}`, label: name, ok: false };
}

export async function POST(req: Request): Promise<Response> {
  const key = process.env.NEBIUS_API_KEY;
  if (!key) return Response.json({ error: "agent backend not configured" }, { status: 503 });

  let body: { messages?: { role: string; content: string }[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const userMessages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 4000) }));
  if (!userMessages.length || userMessages[userMessages.length - 1].role !== "user") {
    return Response.json({ error: "last message must be from user" }, { status: 400 });
  }

  const apiOrigin = getConfiguredApiOrigin();
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...userMessages];
  const steps: HeroStep[] = [];
  const t0 = Date.now();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const llmRes = await fetch(NEBIUS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!llmRes.ok) {
      const errText = truncate(await llmRes.text(), 300);
      return Response.json({ error: `llm: HTTP ${llmRes.status} ${errText}`, steps }, { status: 502 });
    }
    const data = (await llmRes.json()) as { choices?: { message?: ChatMessage }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) return Response.json({ error: "llm returned no message", steps }, { status: 502 });

    if (msg.tool_calls?.length) {
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls.slice(0, 3)) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* malformed args — tool will report */
        }
        const tStep = Date.now();
        let result: { output: string; label: string; ok: boolean };
        try {
          result = await runTool(tc.function.name, parsed, apiOrigin);
        } catch (e) {
          result = { output: `tool error: ${e instanceof Error ? e.message : String(e)}`, label: tc.function.name, ok: false };
        }
        steps.push({ tool: tc.function.name, label: result.label, ms: Date.now() - tStep, ok: result.ok });
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.output });
      }
      // Wall-clock / step guard: leave room to compose a final answer inside
      // the worker limit, and stop exploratory thrash after enough evidence.
      if (Date.now() - t0 > 18000 || steps.length >= 4) {
        messages.push({ role: "user", content: "(tool budget reached — compose the best final answer NOW from the data you already have; no more tool calls)" });
      }
      continue;
    }

    const answer = (msg.content ?? "").trim();
    if (!answer && round < MAX_TOOL_ROUNDS) {
      // Reasoning models occasionally spend the whole budget thinking and emit
      // empty content — nudge once for the plain final answer.
      messages.push({ role: "assistant", content: "" });
      messages.push({ role: "user", content: "(your last message was empty — write the final answer now as plain markdown, no tool calls)" });
      continue;
    }
    return Response.json({ answer, steps, total_ms: Date.now() - t0 });
  }

  return Response.json({ answer: "I ran out of tool budget before finishing — try a more specific ask.", steps, total_ms: Date.now() - t0 });
}
