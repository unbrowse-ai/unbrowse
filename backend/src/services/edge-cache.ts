function getEdgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" ? caches.default : null;
  } catch {
    return null;
  }
}

function cacheRequest(key: string): Request {
  return new Request(`https://unbrowse-edge-cache.invalid/${encodeURIComponent(key)}`, {
    method: "GET",
  });
}

export function buildCacheControl(ttlSeconds: number, staleWhileRevalidateSeconds = ttlSeconds * 4): string {
  return `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`;
}

export async function getEdgeCacheJson<T>(key: string): Promise<T | null> {
  const cache = getEdgeCache();
  if (!cache) return null;
  const cached = await cache.match(cacheRequest(key));
  if (!cached) return null;
  try {
    return await cached.json() as T;
  } catch {
    return null;
  }
}

export async function putEdgeCacheJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const cache = getEdgeCache();
  if (!cache) return;
  const response = new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": buildCacheControl(ttlSeconds),
    },
  });
  await cache.put(cacheRequest(key), response);
}
