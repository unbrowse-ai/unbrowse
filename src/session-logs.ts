import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getRegistrableDomain } from "./domain.js";

export interface SessionLogEntry {
  file: string;
  kind: "execution" | "resolve" | "generation" | "debug";
  trace_id?: string;
  skill_id?: string;
  endpoint_id?: string;
  intent?: string;
  url?: string;
  started_at?: string;
  completed_at?: string;
  success?: boolean;
  status_code?: number;
  error?: string;
}

function normalizeDomainVariants(domain: string): string[] {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed, trimmed.replace(/^www\./, "")]);
  try {
    variants.add(getRegistrableDomain(trimmed));
  } catch {
    // ignore invalid input
  }
  return [...variants].filter(Boolean);
}

function textContainsDomain(text: string, variants: string[]): boolean {
  const lower = text.toLowerCase();
  return variants.some((variant) => lower.includes(variant));
}

function findMatchingUrl(value: unknown, variants: string[], depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && textContainsDomain(value, variants)) return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const match = findMatchingUrl(item, variants, depth + 1);
      if (match) return match;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const next of Object.values(value as Record<string, unknown>).slice(0, 40)) {
      const match = findMatchingUrl(next, variants, depth + 1);
      if (match) return match;
    }
  }
  return undefined;
}

function inferKind(file: string, payload: Record<string, unknown>): SessionLogEntry["kind"] {
  if (file.includes("-resolve-")) return "resolve";
  if (file.includes("-generation-")) return "generation";
  if (typeof payload.trace_id === "string") return "execution";
  return "debug";
}

function timestampFromFilename(filePath: string): string | undefined {
  const match = filePath.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!match) return undefined;
  return match[1].replace(
    /(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)/,
    "$1:$2:$3.$4",
  );
}

function extractTimestamp(payload: Record<string, unknown>, filePath: string): string | undefined {
  const startedAt = typeof payload.started_at === "string" ? payload.started_at : undefined;
  const completedAt = typeof payload.completed_at === "string" ? payload.completed_at : undefined;
  if (startedAt) return startedAt;
  if (completedAt) return completedAt;
  const fileTimestamp = timestampFromFilename(filePath);
  if (fileTimestamp) return fileTimestamp;
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

export function listRecentSessionsForDomain(tracesDir: string, domain: string, limit = 10): SessionLogEntry[] {
  if (!existsSync(tracesDir)) return [];
  const variants = normalizeDomainVariants(domain);
  if (variants.length === 0) return [];

  const entries: Array<SessionLogEntry & { sort_key?: string }> = [];
  for (const name of readdirSync(tracesDir)) {
    if (!name.endsWith(".json")) continue;
    const filePath = join(tracesDir, name);
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    if (!textContainsDomain(raw, variants)) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const matchingUrl = findMatchingUrl(parsed, variants);
    const sortKey = extractTimestamp(parsed, filePath);
    entries.push({
      file: name,
      kind: inferKind(name, parsed),
      trace_id: typeof parsed.trace_id === "string" ? parsed.trace_id : undefined,
      skill_id: typeof parsed.skill_id === "string" ? parsed.skill_id : undefined,
      endpoint_id: typeof parsed.endpoint_id === "string"
        ? parsed.endpoint_id
        : typeof parsed.selected_endpoint_id === "string"
          ? parsed.selected_endpoint_id
          : undefined,
      intent: typeof parsed.intent === "string" ? parsed.intent : undefined,
      url: matchingUrl,
      started_at: typeof parsed.started_at === "string" ? parsed.started_at : sortKey,
      completed_at: typeof parsed.completed_at === "string" ? parsed.completed_at : undefined,
      success: typeof parsed.success === "boolean"
        ? parsed.success
        : parsed.outcome === "autoexec_success"
          ? true
          : undefined,
      status_code: typeof parsed.status_code === "number" ? parsed.status_code : undefined,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      sort_key: sortKey,
    });
  }

  entries.sort((lhs, rhs) => (rhs.sort_key ?? "").localeCompare(lhs.sort_key ?? ""));
  return entries.slice(0, Math.max(1, limit)).map(({ sort_key: _sortKey, ...entry }) => entry);
}
