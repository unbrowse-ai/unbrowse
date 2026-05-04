// LLM judge for "is this captured route a useful API endpoint or noise?"
// Runs in `from-routes` after the heuristic filter, before EndpointDescriptor
// construction. Drops telemetry/beacon/feature-flag/error-shaped responses
// that pass the cheap regex checks but waste skill slots and confuse resolve.
//
// Falls back to heuristic-only when no provider is configured (no LLM key).
// Batched: one prompt per fetch, all routes scored together.

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const NEBIUS_CHAT_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const DEFAULT_MODEL =
  process.env.UNBROWSE_USEFULNESS_MODEL ??
  process.env.UNBROWSE_AGENT_JUDGE_MODEL ??
  "gpt-4.1-mini";
const TIMEOUT_MS = Number(process.env.UNBROWSE_USEFULNESS_TIMEOUT_MS ?? 6000);
const MAX_BATCH = Math.max(1, Number(process.env.UNBROWSE_USEFULNESS_MAX_BATCH ?? 16));
const MAX_BODY_CHARS = Math.max(200, Number(process.env.UNBROWSE_USEFULNESS_MAX_BODY_CHARS ?? 800));

export interface RouteForJudgement {
  url: string;
  method: string;
  status: number;
  content_type?: string;
  body_excerpt?: string;
  body_size?: number;
}

export interface JudgedRoute {
  route: RouteForJudgement;
  verdict: "useful" | "noise" | "unknown";
  reason: string;
}

interface Provider { url: string; key: string; model: string; }

function availableProviders(): Provider[] {
  const out: Provider[] = [];
  if (process.env.OPENAI_API_KEY) out.push({ url: OPENAI_CHAT_URL, key: process.env.OPENAI_API_KEY, model: DEFAULT_MODEL });
  if (process.env.NEBIUS_API_KEY) out.push({ url: NEBIUS_CHAT_URL, key: process.env.NEBIUS_API_KEY, model: DEFAULT_MODEL });
  return out;
}

function trimBody(body: string | undefined): string {
  if (!body) return "";
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + "…" : body;
}

const SYSTEM_PROMPT = `You classify captured HTTP API calls as useful or noise.

A route is "useful" if a calling agent might want to invoke it as a public/semi-public API:
- returns data: lists, search results, items, products, repos, posts, profiles, prices, charts, content, search results
- canonical CRUD: get/list/create/update/delete on a resource
- domain-relevant business logic

A route is "noise" if it serves the page/app, not the agent's intent:
- telemetry, analytics, beacons, pixel/tracking, error reporting (sentry, datadog, newrelic, mixpanel, amplitude)
- feature flags, A/B tests, experiments, remote config, settings sync
- auth side-effects: cookie sync, consent, csrf rotation, session ping, heartbeat
- ad/personalization endpoints, doubleverify, pubmatic, doubleclick
- internal/private deploy probes, CDN warmup, RSC chunks
- error envelopes (200 with {"error": …} or empty body)
- redirected to login/captcha pages

For each route return: { "endpoint_id": <index>, "verdict": "useful"|"noise", "reason": "<one short clause>" }
Always classify every input. Never invent endpoints.`;

function buildPayload(routes: RouteForJudgement[]): string {
  return JSON.stringify(
    routes.map((r, i) => ({
      i,
      method: r.method,
      url: r.url,
      status: r.status,
      content_type: r.content_type ?? "",
      body_size: r.body_size ?? 0,
      body_excerpt: trimBody(r.body_excerpt),
    })),
  );
}

interface LlmVerdict { endpoint_id?: number; i?: number; verdict?: string; reason?: string; }
interface LlmResponse { endpoints?: LlmVerdict[]; results?: LlmVerdict[]; }

async function callLlm(provider: Provider, payload: string): Promise<LlmVerdict[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.key}`,
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Routes (JSON array):\n${payload}\n\nReturn JSON: {"endpoints":[{"i":0,"verdict":"useful|noise","reason":"…"}, …]}` },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;
    const parsed = JSON.parse(text) as LlmResponse;
    return parsed.endpoints ?? parsed.results ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function judgeRoutes(routes: RouteForJudgement[]): Promise<JudgedRoute[]> {
  if (routes.length === 0) return [];
  const provider = availableProviders()[0];
  if (!provider) {
    return routes.map((r) => ({ route: r, verdict: "unknown", reason: "no LLM key configured" }));
  }
  const out: JudgedRoute[] = [];
  for (let i = 0; i < routes.length; i += MAX_BATCH) {
    const batch = routes.slice(i, i + MAX_BATCH);
    const verdicts = await callLlm(provider, buildPayload(batch));
    if (!verdicts) {
      for (const r of batch) out.push({ route: r, verdict: "unknown", reason: "judge call failed" });
      continue;
    }
    const byIdx = new Map<number, LlmVerdict>();
    for (const v of verdicts) {
      const idx = typeof v.i === "number" ? v.i : (typeof v.endpoint_id === "number" ? v.endpoint_id : -1);
      if (idx >= 0) byIdx.set(idx, v);
    }
    batch.forEach((r, idx) => {
      const v = byIdx.get(idx);
      const verdict = v?.verdict === "useful" ? "useful" : v?.verdict === "noise" ? "noise" : "unknown";
      out.push({ route: r, verdict, reason: v?.reason ?? "no verdict returned" });
    });
  }
  return out;
}
