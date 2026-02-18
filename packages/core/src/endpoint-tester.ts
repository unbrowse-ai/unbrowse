/**
 * Endpoint Tester — Validate discovered GET endpoints with captured auth.
 *
 * Only tests GET (safe, read-only). Records status, response shape,
 * and latency for each endpoint.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface EndpointTestResult {
  method: string;
  path: string;
  url: string;
  status: number;
  ok: boolean;
  hasData: boolean;
  /** e.g. "array[5]", "object{id,name}", "non-json", "empty", "error" */
  responseShape: string;
  responseSize: number;
  latencyMs: number;
}

export interface TestSummary {
  total: number;
  verified: number;
  failed: number;
  skipped: number;
  results: EndpointTestResult[];
}

// ── Tester ───────────────────────────────────────────────────────────────────

async function testSingle(
  endpoint: { method: string; path: string; url?: string },
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<EndpointTestResult> {
  let url: string;
  try {
    url = endpoint.url || new URL(endpoint.path, baseUrl).toString();
  } catch {
    url = `${baseUrl.replace(/\/$/, "")}${endpoint.path}`;
  }

  const start = Date.now();

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await resp.text().catch(() => "");
    const latencyMs = Date.now() - start;

    let responseShape = "empty";
    let hasData = false;

    if (text.length > 0) {
      try {
        const json = JSON.parse(text);
        if (Array.isArray(json)) {
          responseShape = `array[${json.length}]`;
          hasData = json.length > 0;
        } else if (typeof json === "object" && json !== null) {
          const keys = Object.keys(json);
          responseShape = `object{${keys.slice(0, 5).join(",")}}`;
          hasData = keys.length > 0;
        } else {
          responseShape = typeof json;
          hasData = true;
        }
      } catch {
        responseShape = text.length > 200 ? "html/text" : "non-json";
        hasData = text.length > 2;
      }
    }

    return {
      method: "GET",
      path: endpoint.path,
      url,
      status: resp.status,
      ok: resp.ok,
      hasData,
      responseShape,
      responseSize: text.length,
      latencyMs,
    };
  } catch {
    return {
      method: "GET",
      path: endpoint.path,
      url,
      status: 0,
      ok: false,
      hasData: false,
      responseShape: "error",
      responseSize: 0,
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Test all GET endpoints with captured auth headers/cookies.
 */
export async function testGetEndpoints(
  baseUrl: string,
  endpoints: Record<string, Array<{ method: string; path: string; url?: string }>>,
  authHeaders: Record<string, string>,
  cookies: Record<string, string>,
  opts?: {
    maxEndpoints?: number;
    timeoutMs?: number;
    concurrency?: number;
  },
): Promise<TestSummary> {
  const maxEndpoints = opts?.maxEndpoints ?? 20;
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const concurrency = opts?.concurrency ?? 3;

  // Collect unique GET endpoints
  const getEndpoints: Array<{ method: string; path: string; url?: string }> = [];
  const seenPaths = new Set<string>();
  let skipped = 0;

  for (const reqs of Object.values(endpoints)) {
    const req = reqs[0];
    if (!req) continue;
    if (req.method !== "GET") {
      skipped++;
      continue;
    }
    // Skip paths with template variables (can't test without real values)
    if (/\{[^}]+\}/.test(req.path)) {
      skipped++;
      continue;
    }
    if (!seenPaths.has(req.path)) {
      seenPaths.add(req.path);
      getEndpoints.push(req);
    }
  }

  const toTest = getEndpoints.slice(0, maxEndpoints);

  // Build headers
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders,
  };
  if (Object.keys(cookies).length > 0) {
    headers["Cookie"] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  // Test with bounded concurrency
  const results: EndpointTestResult[] = [];
  for (let i = 0; i < toTest.length; i += concurrency) {
    const chunk = toTest.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map((ep) => testSingle(ep, baseUrl, headers, timeoutMs)),
    );
    results.push(...chunkResults);
  }

  const verified = results.filter((r) => r.ok && r.hasData).length;
  const failed = results.filter((r) => !r.ok).length;

  return { total: toTest.length, verified, failed, skipped, results };
}
