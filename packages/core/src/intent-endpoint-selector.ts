import type { EndpointGroup } from "./types.js";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who",
  "with", "you", "your", "me", "my", "we", "our",
]);

function tokenize(input: string): string[] {
  return String(input || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && !STOPWORDS.has(s));
}

function wantsAuth(intent: string): boolean {
  return /\b(auth|login|log-in|signin|sign-in|signup|sign-up|oauth|token|session|csrf)\b/i.test(intent);
}

function verbBonus(intentLower: string, methodUpper: string): number {
  if (methodUpper === "POST" && /\b(create|post|submit|send|add|new)\b/.test(intentLower)) return 2;
  if ((methodUpper === "PUT" || methodUpper === "PATCH") && /\b(update|edit|change|set)\b/.test(intentLower)) return 2;
  if (methodUpper === "DELETE" && /\b(delete|remove|cancel)\b/.test(intentLower)) return 2;
  if (methodUpper === "GET" && /\b(get|list|fetch|read|search|find|query|browse)\b/.test(intentLower)) return 1;
  return 0;
}

function scoreGroup(g: EndpointGroup, tokens: string[], intentLower: string): number {
  const method = String(g.method || "GET").toUpperCase();
  const path = String(g.normalizedPath || "/");
  const hay = `${method} ${path} ${g.methodName ?? ""} ${g.description ?? ""} ${g.whenToUse ?? ""}`.toLowerCase();
  const pathLower = path.toLowerCase();
  const segments = new Set(pathLower.split("/").filter(Boolean));

  let score = 0;
  score += verbBonus(intentLower, method);

  for (const t of tokens) {
    if (!hay.includes(t)) continue;
    score += 1;
    if (segments.has(t)) score += 2;
  }

  // Mild penalty for infra-ish endpoints unless explicitly requested.
  if (!/\b(feature|flag|config|metrics|telemetry|analytics)\b/.test(intentLower)) {
    if (/\b(feature|flag|config|metrics|telemetry|analytics)\b/.test(pathLower)) score -= 1;
  }

  // Prefer endpoints with clear generated method names.
  if (g.methodName) score += 0.5;

  // Prefer "core" categories by default.
  if (g.category === "read" || g.category === "write") score += 0.25;
  return score;
}

export function selectEndpointGroupsForIntent(
  groups: EndpointGroup[],
  intent: string,
  opts?: { limit?: number },
): EndpointGroup[] {
  if (!Array.isArray(groups) || groups.length === 0) return [];

  const rawIntent = String(intent || "").trim();
  if (!rawIntent) return groups;

  const limit = Number.isFinite(opts?.limit) && (opts?.limit as number) > 0
    ? Math.min(200, Math.max(1, Math.trunc(opts!.limit as number)))
    : 25;

  const tokens = tokenize(rawIntent);
  const intentLower = rawIntent.toLowerCase();
  const includeAuth = wantsAuth(rawIntent);

  const scored = groups
    .map((g) => ({ g, score: scoreGroup(g, tokens, intentLower) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.g.method !== b.g.method) return String(a.g.method).localeCompare(String(b.g.method));
      return String(a.g.normalizedPath).localeCompare(String(b.g.normalizedPath));
    });

  const selected: EndpointGroup[] = [];
  for (const { g, score } of scored) {
    if (selected.length >= limit) break;
    if (!includeAuth && g.category === "auth" && score < 3) continue;
    selected.push(g);
  }

  // Fallback: never return empty selection.
  if (selected.length === 0) {
    return scored.slice(0, Math.min(limit, scored.length)).map((x) => x.g);
  }

  return selected;
}

