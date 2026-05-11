export interface ExaWebResult {
  url: string;
  title?: string;
  score: number;
  highlights?: string[];
}

export async function exaSearch(
  apiKey: string,
  query: string,
  numResults = 5,
): Promise<ExaWebResult[]> {
  let res: Response;
  try {
    res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults,
        contents: {
          highlights: { numSentences: 3, highlightsPerUrl: 2 },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.error("[exa] fetch error:", (err as Error).message);
    return [];
  }
  if (!res.ok) {
    console.error(`[exa] search failed: ${res.status} ${res.statusText}`);
    return [];
  }
  const data = await res.json() as {
    results?: Array<{ url: string; title?: string; score?: number; highlights?: string[] }>;
  };
  return (data.results ?? []).map((r) => ({
    url: r.url,
    title: r.title,
    score: r.score ?? 0,
    highlights: r.highlights,
  }));
}
