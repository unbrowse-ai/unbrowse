function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeToken(value ?? "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value!.trim());
  }
  return out;
}

function combineQueryAndLocation(query: string | undefined, location: string | undefined): string | undefined {
  const cleanQuery = query?.trim();
  const cleanLocation = location?.trim();
  if (!cleanQuery) return cleanLocation;
  if (!cleanLocation) return cleanQuery;
  const normalizedQuery = normalizeToken(cleanQuery);
  const normalizedLocation = normalizeToken(cleanLocation);
  if (!normalizedLocation || normalizedQuery.includes(normalizedLocation)) return cleanQuery;
  return `${cleanQuery} ${cleanLocation}`;
}

function tokenizeIntent(value: string | undefined): string[] {
  return normalizeToken(value ?? "")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !new Set([
      "the", "and", "for", "with", "from", "that", "this", "events",
      "event", "page", "site", "browse", "show", "find", "search", "get",
    ]).has(token));
}

function firstNonEmptyParam(url: URL, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function deriveIntentQuery(intent: string | undefined): string | undefined {
  const source = intent?.trim();
  if (!source) return undefined;
  const quoted = source.match(/"([^"]+)"/)?.[1]?.trim();
  if (quoted) return quoted;
  const patterns = [
    /\b(?:search|find|discover|explore|browse)(?:\s+for)?\s+(.+)/i,
    /\b(?:look up|look for)\s+(.+)/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern)?.[1]?.trim();
    if (match) {
      const cleaned = match
        .replace(/\b(on|in|at)\s+[a-z0-9.-]+\.[a-z]{2,}\b.*$/i, "")
        .replace(/\b(with|using)\s+unbrowse\b.*$/i, "")
        .trim();
      const normalized = normalizeToken(cleaned);
      if (!normalized) return undefined;
      const tokens = normalized.split(/\s+/).filter(Boolean);
      if (tokens.length === 1 && new Set(["event", "events", "result", "results", "page", "pages"]).has(tokens[0]!)) {
        return undefined;
      }
      return cleaned;
    }
  }
  return undefined;
}

export function deriveInteractionQueryTerms(captureUrl?: string, intent?: string): string[] {
  const inferredIntentQuery = deriveIntentQuery(intent);
  if (!captureUrl) return uniqueStrings([inferredIntentQuery]);
  try {
    const parsed = new URL(captureUrl);
    const query = firstNonEmptyParam(parsed, ["q", "query", "search", "keyword", "keywords", "term"]);
    const location = firstNonEmptyParam(parsed, ["city", "location", "loc", "place"]);
    const combined = combineQueryAndLocation(query, location);
    return uniqueStrings([combined, query, inferredIntentQuery, location]);
  } catch {
    return uniqueStrings([inferredIntentQuery]);
  }
}

export function deriveInteractionClickTerms(captureUrl?: string, intent?: string): string[] {
  const lowerIntent = intent?.toLowerCase() ?? "";
  const baseTerms: string[] = [];
  if (/\b(register|rsvp|join|apply|ticket|signup|sign up)\b/.test(lowerIntent)) {
    baseTerms.push("register", "rsvp", "join", "apply", "ticket");
  }
  if (/\b(search|find|discover|explore|browse)\b/.test(lowerIntent)) {
    baseTerms.push("search", "find", "discover", "explore");
  }
  if (/\b(next|more|load|show more|see more)\b/.test(lowerIntent)) {
    baseTerms.push("next", "more", "load more", "show more");
  }
  if (captureUrl) {
    try {
      const parsed = new URL(captureUrl);
      if (/search|discover|explore|browse/i.test(parsed.pathname + parsed.search)) {
        baseTerms.push("search", "discover", "show more", "load more", "next");
      }
    } catch {
      // ignore
    }
  }
  for (const token of tokenizeIntent(intent)) {
    if (token.length >= 4) baseTerms.push(token);
  }
  return uniqueStrings(baseTerms);
}

export function shouldAttemptInteractiveExploration(captureUrl?: string, intent?: string): boolean {
  if (!captureUrl) return false;
  const lowerIntent = intent?.toLowerCase() ?? "";
  if (/\b(register|rsvp|join|apply|ticket|signup|sign up|search|find|discover|explore|browse)\b/.test(lowerIntent)) {
    return true;
  }
  try {
    const parsed = new URL(captureUrl);
    if (parsed.searchParams.size > 0) return true;
    return /search|discover|explore|browse|results/i.test(parsed.pathname);
  } catch {
    return false;
  }
}
