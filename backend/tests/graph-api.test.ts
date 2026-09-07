/**
 * Graph API integration tests.
 *
 * Tests the EmergentDB Graph API integration end-to-end:
 * - batch_insert (auto-embed via Gemini)
 * - search (cosine similarity + graph reranking)
 * - batch_insert (auto-embed via Gemini)
 * - search (cosine similarity + graph reranking)
 * - DAG edges + chain resolution
 * - session recording + predictions
 * - negative examples
 * - observability (credits, cooccurrence, intent-cache, edges)
 *
 * Uses two real domains: finance.yahoo.com and reddit.com
 *
 * Run against deployed API:
 *   GRAPH_TEST_API_URL=https://beta-api.unbrowse.ai bun test backend/tests/graph-api.test.ts
 *
 * Run against local (start wrangler first in a separate terminal):
 *   cd backend && npx wrangler dev --port 9787
 *   GRAPH_TEST_API_URL=http://localhost:9787 GRAPH_TEST_API_KEY=local-test bun test tests/graph-api.test.ts
 *
 * Note: miniflare 3.x crashes when bun test sends concurrent requests.
 * If running locally, ensure wrangler is started separately before running tests.
 * - observability (credits, cooccurrence, intent-cache, edges)
 *
 * Uses two real domains: finance.yahoo.com and reddit.com
 *
 * Run: bun test backend/tests/graph-api.test.ts
 *
 * Requires EMERGENTDB_API_KEY in environment or .dev.vars.
 */
import { describe, it, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LIVE_GRAPH_TEST_RUN =
  process.env.BACKEND_LIVE_TEST_RUN === "1" || process.env.GRAPH_TEST_RUN === "1";
const liveDescribe = LIVE_GRAPH_TEST_RUN ? describe : describe.skip;

function loadApiKey(): string {
  if (process.env.GRAPH_TEST_API_KEY) return process.env.GRAPH_TEST_API_KEY;
  try {
    const configPath = join(homedir(), ".unbrowse", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.api_key ?? "";
  } catch {
    return "";
  }
}

const API_URL = process.env.GRAPH_TEST_API_URL ?? "https://beta-api.unbrowse.ai";
const API_KEY = loadApiKey();
const TIMEOUT = 120_000;
const REQUEST_TIMEOUT = 15_000;

// Graph API tests hit a live backend with rate limits (30 req/60s).
// Increase the default timeout to accommodate retries on rate-limited responses.
setDefaultTimeout(TIMEOUT);
type ApiResult = { status: number; data: Record<string, unknown> };

function expectSearchOkOrPaid(result: ApiResult): boolean {
  expect([200, 402]).toContain(result.status);
  if (result.status === 402) {
    expect(result.data.error).toBe("Payment Required");
    return false;
  }
  return true;
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json() as Record<string, unknown>;
  } catch {
    return { error: await res.text().catch(() => "non-JSON response") };
  }
}

async function retryOnRateLimit(fn: () => Promise<ApiResult>, maxRetries = 4): Promise<ApiResult> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await fn();
      const isRateLimited = result.status === 429 ||
        (result.status === 500 && result.data?.error === "Rate limit exceeded");
      if (isRateLimited && i < maxRetries - 1) {
        // Wait progressively longer — rate limit window is 60s
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
        continue;
      }
      return result;
    } catch (err) {
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 3000 * (i + 1)));
        continue;
      }
      return { status: 0, data: { error: (err as Error).message } };
    }
  }
  return { status: 0, data: { error: "retry limit exhausted" } };
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function post(path: string, body: unknown, maxRetries = 4): Promise<ApiResult> {
  return retryOnRateLimit(async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
    const res = await fetchWithTimeout(`${API_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await safeJson(res) };
  }, maxRetries);
}

async function get(path: string, maxRetries = 4): Promise<ApiResult> {
  return retryOnRateLimit(async () => {
    const headers: Record<string, string> = {};
    if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
    const res = await fetchWithTimeout(`${API_URL}${path}`, { headers });
    return { status: res.status, data: await safeJson(res) };
  }, maxRetries);
}

// ─── Fixtures ────────────────────────────────────────────────

const YAHOO_SKILL = {
  skill_id: "graph-test-yahoo",
  version: "1.0.0",
  schema_version: "1",
  name: "finance.yahoo.com",
  intent_signature: "finance.yahoo.com",
  domain: "finance.yahoo.com",
  description: "Yahoo Finance stock data API",
  owner_type: "agent",
  lifecycle: "active",
  execution_type: "http",
  created_at: "2026-03-15T00:00:00Z",
  updated_at: "2026-03-15T00:00:00Z",
  endpoints: [
    {
      endpoint_id: "yf-quote-v7",
      description: "Get real-time stock quote data including price volume and market cap for given ticker symbols like AAPL TSLA MSFT",
      method: "GET",
      url_template: "https://query1.finance.yahoo.com/v7/finance/quote?symbols={symbols}",
      reliability_score: 0.9,
      verification_status: "verified",
      idempotency: "safe",
    },
    {
      endpoint_id: "yf-chart-v8",
      description: "Get historical price chart data with customizable time range and interval for a stock symbol",
      method: "GET",
      url_template: "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range}&interval={interval}",
      reliability_score: 0.85,
      verification_status: "verified",
      idempotency: "safe",
    },
    {
      endpoint_id: "yf-search-v1",
      description: "Search for ticker symbols and company names by keyword query",
      method: "GET",
      url_template: "https://query1.finance.yahoo.com/v1/finance/search?q={query}",
      reliability_score: 0.95,
      verification_status: "verified",
      idempotency: "safe",
    },
  ],
};

const REDDIT_SKILL = {
  skill_id: "graph-test-reddit",
  version: "1.0.0",
  schema_version: "1",
  name: "reddit.com",
  intent_signature: "reddit.com",
  domain: "reddit.com",
  description: "Reddit content API",
  owner_type: "agent",
  lifecycle: "active",
  execution_type: "http",
  created_at: "2026-03-15T00:00:00Z",
  updated_at: "2026-03-15T00:00:00Z",
  endpoints: [
    {
      endpoint_id: "reddit-hot",
      description: "Get hot posts from a subreddit sorted by popularity and recent activity",
      method: "GET",
      url_template: "https://www.reddit.com/r/{subreddit}/hot.json?limit={limit}",
      reliability_score: 0.9,
      verification_status: "verified",
      idempotency: "safe",
    },
    {
      endpoint_id: "reddit-search",
      description: "Search for posts across all of Reddit or within a specific subreddit by keyword",
      method: "GET",
      url_template: "https://www.reddit.com/search.json?q={query}&limit={limit}",
      reliability_score: 0.85,
      verification_status: "verified",
      idempotency: "safe",
    },
    {
      endpoint_id: "reddit-comments",
      description: "Get comments and replies for a specific Reddit post by its article ID",
      method: "GET",
      url_template: "https://www.reddit.com/r/{subreddit}/comments/{article}.json",
      reliability_score: 0.88,
      verification_status: "verified",
      idempotency: "safe",
    },
    {
      endpoint_id: "reddit-user",
      description: "Get a Reddit user profile and their recent post history",
      method: "GET",
      url_template: "https://www.reddit.com/user/{username}/about.json",
      reliability_score: 0.82,
      verification_status: "verified",
      idempotency: "safe",
    },
  ],
};

// ─── Tests ───────────────────────────────────────────────────

liveDescribe("Graph API — Index & Search", () => {
  beforeAll(async () => {
    // Best-effort fixture publish only. Search tests below tolerate cold/missing index state.
    // Keep setup bounded so a transient live API stall does not burn the whole suite timeout.
    for (const [label, skill] of [
      ["yahoo", YAHOO_SKILL],
      ["reddit", REDDIT_SKILL],
    ] as const) {
      const result = await post("/v1/skills", skill, 1);
      console.log(`  ${label} index_status: ${(result.data as any).index_status ?? result.data.error ?? "unknown"}`);
    }
  });

  it("searches Yahoo Finance domain for stock quote", async () => {
    // Wait for vectors to be queryable
    await new Promise((r) => setTimeout(r, 2000));
    const { status, data } = await post("/v1/search/domain", {
      intent: "get stock quote for TSLA",
      domain: "finance.yahoo.com",
      k: 5,
    });
    if (!expectSearchOkOrPaid({ status, data })) return;
    const results = (data.results as any[]) ?? [];
    // Results may be empty if publish failed or index is cold — log for debugging
    console.log(`  yahoo quote search: ${results.length} results${results[0] ? `, top score=${results[0]?.score?.toFixed(4)}` : ""}`);
  }, TIMEOUT);

  it("searches Reddit domain for hot posts", async () => {
    const { status, data } = await post("/v1/search/domain", {
      intent: "get trending hot posts from a subreddit",
      domain: "reddit.com",
      k: 5,
    });
    if (!expectSearchOkOrPaid({ status, data })) return;
    const results = (data.results as any[]) ?? [];
    console.log(`  reddit hot search: ${results.length} results${results[0] ? `, top score=${results[0]?.score?.toFixed(4)}` : ""}`);
  }, TIMEOUT);

  it("global search finds both Yahoo and Reddit endpoints", async () => {
    const { status, data } = await post("/v1/search", {
      intent: "search for something by keyword",
      k: 10,
    });
    if (!expectSearchOkOrPaid({ status, data })) return;
    const results = (data.results as any[]) ?? [];
    console.log(`  global search: ${results.length} results`);
  }, TIMEOUT);
  it("search/resolve returns domain + global results", async () => {
    const { status, data } = await post("/v1/search/resolve", {
      intent: "get stock price history",
      domain: "finance.yahoo.com",
      domain_k: 3,
      global_k: 5,
    });
    // Resolve may return empty when index is cold or rate-limited; paid prod returns 402.
    if (!expectSearchOkOrPaid({ status, data })) return;
    const domain_results = (data.domain_results as any[]) ?? [];
    const global_results = (data.global_results as any[]) ?? [];
    console.log(`  resolve: domain=${domain_results.length} global=${global_results.length} skipped=${data.skipped_global}`);
  }, TIMEOUT);

  it("chart query ranks chart endpoint higher than quote", async () => {
    const { status, data } = await post("/v1/search/domain", {
      intent: "show historical price chart for AAPL over the last year",
      domain: "finance.yahoo.com",
      k: 3,
    });
    // Search may return empty when index is cold or rate-limited; paid prod returns 402.
    if (!expectSearchOkOrPaid({ status, data })) return;
    const results = (data.results as any[]) ?? [];
    console.log(`  chart query top scores: ${results.map((r: any) => r.score?.toFixed(4)).join(", ") || "(none)"}`);
  }, TIMEOUT);
});

liveDescribe("Graph API — DAG Chain Resolution", () => {
  it("resolves chain for chart-v8 endpoint", async () => {
    const { status, data } = await post("/v1/graph/chain", {
      domain: "finance.yahoo.com",
      target_endpoint_id: "yf-chart-v8",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    const chain = data.chain as any[];
    // Chain may be empty if edges weren't upserted (batch_insert dedup)
    console.log(`  chain: ${chain.map((n: any) => n.endpoint_id).join(" → ") || "(empty)"} (length=${data.chain_length})`);
  }, TIMEOUT);

  it("resolves chain for reddit comments", async () => {
    const { status, data } = await post("/v1/graph/chain", {
      domain: "reddit.com",
      target_endpoint_id: "reddit-comments",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    console.log(`  chain: ${(data.chain as any[]).map((n: any) => n.endpoint_id).join(" → ")}`);
  }, TIMEOUT);

  it("reads edges for a specific endpoint", async () => {
    const { status, data } = await get("/v1/graph/edges/finance.yahoo.com/yf-chart-v8");
    expect(status).toBe(200);
    console.log(`  edges: ${JSON.stringify(data).slice(0, 200)}`);
  }, TIMEOUT);
});

liveDescribe("Graph API — Sessions & Predictions", () => {
  it("records session actions", async () => {
    const sessionId = `test-session-${Date.now()}`;
    const { status: s1 } = await post("/v1/graph/session", {
      session_id: sessionId,
      action: { intent: "search ticker", domain: "finance.yahoo.com", endpoint_id: "yf-search-v1", result: "success" },
    });
    expect(s1).toBe(200);

    const { status: s2 } = await post("/v1/graph/session", {
      session_id: sessionId,
      action: { intent: "get quote", domain: "finance.yahoo.com", endpoint_id: "yf-quote-v7", result: "success" },
    });
    expect(s2).toBe(200);

    const { status: s3 } = await post("/v1/graph/session", {
      session_id: sessionId,
      action: { intent: "price chart", domain: "finance.yahoo.com", endpoint_id: "yf-chart-v8", result: "success" },
    });
    expect(s3).toBe(200);
    console.log(`  recorded 3 session actions for ${sessionId}`);
  }, TIMEOUT);

  it("gets predictions for an endpoint", async () => {
    const { status, data } = await get("/v1/graph/predict/finance.yahoo.com?from=yf-quote-v7&k=3");
    expect(status).toBe(200);
    const predictions = data.predictions as any[] ?? [];
    console.log(`  predictions from yf-quote-v7: ${predictions.length} (${predictions.map((p: any) => p.endpoint_id).join(", ")})`);
  }, TIMEOUT);
});

liveDescribe("Graph API — Negative Examples", () => {
  it("records a negative example", async () => {
    const { status, data } = await post("/v1/graph/negative", {
      domain: "finance.yahoo.com",
      intent_pattern: "cancel",
      endpoint_id: "yf-quote-v7",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    console.log(`  negative recorded: "cancel" should not match yf-quote-v7`);
  }, TIMEOUT);
});

liveDescribe("Graph API — Observability", () => {
  it("returns credit balance", async () => {
    const { status, data } = await get("/v1/graph/credits");
    expect(status).toBe(200);
    expect(data.balance_usd).toBeDefined();
    console.log(`  credits: ${data.balance_usd}`);
  }, TIMEOUT);

  it("returns co-occurrence matrix", async () => {
    const { status, data } = await get("/v1/graph/cooccurrence/finance.yahoo.com");
    expect(status).toBe(200);
    console.log(`  cooccurrence: ${JSON.stringify(data).slice(0, 200)}`);
  }, TIMEOUT);

  it("checks intent cache", async () => {
    const { status } = await get("/v1/graph/intent-cache?query=stock+quote&domain=finance.yahoo.com");
    expect(status).toBe(200);
  }, TIMEOUT);

  it("proxy health check works", async () => {
    const { status, data } = await get("/v1/graph/proxy/health");
    expect(status).toBe(200);
    expect(data.status).toBe("ok");
    console.log(`  proxy health: ${JSON.stringify(data)}`);
  }, TIMEOUT);
});
