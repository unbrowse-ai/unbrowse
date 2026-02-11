import type { ApiData, ParsedRequest } from "./types.js";
import { testGetEndpoints, type TestSummary } from "./endpoint-tester.js";

export type VerifiedGetSummary = TestSummary & {
  /** Number of GET endpoints removed because they failed verification. */
  pruned: number;
};

/**
 * Tests GET endpoints and removes failing tested GET routes from ApiData.
 * Non-tested GET endpoints (e.g. templated paths) are preserved.
 */
export async function verifyAndPruneGetEndpoints(
  apiData: ApiData,
  cookies: Record<string, string>,
  opts?: {
    maxEndpoints?: number;
    timeoutMs?: number;
    concurrency?: number;
  },
): Promise<VerifiedGetSummary | null> {
  if (!apiData.baseUrl || Object.keys(apiData.endpoints).length === 0) return null;

  const summary = await testGetEndpoints(
    apiData.baseUrl,
    apiData.endpoints,
    apiData.authHeaders,
    { ...apiData.cookies, ...cookies },
    {
      maxEndpoints: opts?.maxEndpoints,
      timeoutMs: opts?.timeoutMs,
      concurrency: opts?.concurrency,
    },
  );

  if (summary.total === 0) {
    return { ...summary, pruned: 0 };
  }

  const byPath = new Map<string, boolean>();
  for (const r of summary.results) {
    byPath.set(r.path, r.ok && r.hasData);
  }

  // Mark verified state on tested GET requests.
  for (const reqs of Object.values(apiData.endpoints)) {
    for (const req of reqs) {
      if (req.method !== "GET") continue;
      const isVerified = byPath.get(req.path);
      if (isVerified !== undefined) req.verified = isVerified;
    }
  }

  const failedPaths = new Set(
    summary.results
      .filter((r) => !(r.ok && r.hasData))
      .map((r) => r.path),
  );

  if (failedPaths.size === 0) {
    return { ...summary, pruned: 0 };
  }

  // Remove failing tested GET routes from grouped endpoints.
  const prunedEndpoints: Record<string, ParsedRequest[]> = {};
  for (const [key, reqs] of Object.entries(apiData.endpoints)) {
    const kept = reqs.filter((req) => !(req.method === "GET" && failedPaths.has(req.path)));
    if (kept.length > 0) prunedEndpoints[key] = kept;
  }
  apiData.endpoints = prunedEndpoints;

  // Keep requests list aligned with endpoint pruning.
  apiData.requests = apiData.requests.filter(
    (req) => !(req.method === "GET" && failedPaths.has(req.path)),
  );

  return { ...summary, pruned: failedPaths.size };
}

