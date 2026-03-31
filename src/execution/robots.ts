/**
 * robots.txt compliance check for route execution.
 *
 * Fetches and caches robots.txt per domain (24 h TTL), then checks
 * whether a given path is allowed for the Unbrowse user-agent.
 *
 * RFC 9309-compliant: the function checks rules for "unbrowse" first,
 * then falls back to the wildcard agent "*". Paths under Disallow
 * directives are blocked; an absent or unparseable robots.txt is
 * treated as fully permissive.
 */

const USER_AGENT = "unbrowse";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 h

interface CacheEntry {
  rules: AgentRules[];
  fetchedAt: number;
}

interface AgentRules {
  agents: string[]; // lowercase user-agent names; ["*"] for wildcard
  disallow: string[];
  allow: string[];
  crawlDelay?: number;
}

// In-process cache — survives for the lifetime of the process.
const cache = new Map<string, CacheEntry>();

/** Exported for tests only — clear the in-process cache. */
export function clearRobotsCache(): void {
  cache.clear();
}

/** Parse a raw robots.txt string into per-agent rule blocks. */
export function parseRobotsTxt(text: string): AgentRules[] {
  const groups: AgentRules[] = [];
  let current: AgentRules | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      // Blank line ends the current group.
      current = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "disallow") {
      if (current && value) current.disallow.push(value);
    } else if (field === "allow") {
      if (current && value) current.allow.push(value);
    } else if (field === "crawl-delay") {
      if (current) current.crawlDelay = parseFloat(value);
    } else {
      // Unknown directive — reset so a subsequent User-agent starts fresh.
      current = null;
    }
  }

  return groups;
}

/** Return the best-matching rule block for a given user-agent string. */
function selectRules(groups: AgentRules[], agent: string): AgentRules | null {
  const lower = agent.toLowerCase();
  // Exact match first.
  const exact = groups.find((g) => g.agents.some((a) => a === lower));
  if (exact) return exact;
  // Wildcard fallback.
  return groups.find((g) => g.agents.includes("*")) ?? null;
}

/** True when `path` starts with `prefix` (robots.txt path matching). */
function pathMatches(path: string, prefix: string): boolean {
  // The "$" anchor means the pattern must match the entire path.
  if (prefix.endsWith("$")) {
    return path === prefix.slice(0, -1);
  }
  return path.startsWith(prefix);
}

/** Return the length of the longest matching Allow/Disallow prefix. */
function longestMatch(path: string, patterns: string[]): number {
  let best = -1;
  for (const p of patterns) {
    const base = p.endsWith("$") ? p.slice(0, -1) : p;
    if (pathMatches(path, p) && base.length > best) best = base.length;
  }
  return best;
}

/**
 * Fetch (with caching) and parse robots.txt for a given origin.
 * Never throws — returns [] (fully permissive) on any error.
 */
async function fetchRules(origin: string): Promise<AgentRules[]> {
  const now = Date.now();
  const cached = cache.get(origin);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.rules;

  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // 4xx → treat as no restrictions; 5xx → same (permissive on error).
      cache.set(origin, { rules: [], fetchedAt: now });
      return [];
    }
    const text = await res.text();
    const rules = parseRobotsTxt(text);
    cache.set(origin, { rules, fetchedAt: now });
    return rules;
  } catch {
    // Network error / timeout → permissive.
    cache.set(origin, { rules: [], fetchedAt: now });
    return [];
  }
}

/**
 * Check whether the Unbrowse user-agent is allowed to access `url`.
 *
 * Returns `true` (allowed) when:
 * - robots.txt cannot be fetched or parsed
 * - no matching rule exists
 * - the most-specific matching rule is an Allow directive
 *
 * Returns `false` (blocked) only when the most-specific matching rule
 * is a Disallow directive with a longer (or equal) prefix than any
 * matching Allow directive.
 */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  let origin: string;
  let pathname: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    pathname = parsed.pathname || "/";
  } catch {
    return true; // unparseable URL — let execution proceed
  }

  const groups = await fetchRules(origin);
  const rules = selectRules(groups, USER_AGENT);
  if (!rules) return true; // no matching rules — fully allowed

  const allowLen = longestMatch(pathname, rules.allow);
  const disallowLen = longestMatch(pathname, rules.disallow);

  if (disallowLen < 0) return true; // no disallow matched
  if (allowLen >= disallowLen) return true; // allow wins on tie or longer match
  return false;
}
