/**
 * Local execution trace storage for future RAG retrieval.
 *
 * Persists execution traces as JSONL files at ~/.unbrowse/traces/{domain}.jsonl.
 * Append-only writes, most-recent-last ordering.
 * All operations are synchronous — trace storage is not in the hot path.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface StoredTrace {
  trace_id: string;
  domain: string;
  intent: string;
  goal_embedding?: number[]; // For future similarity search
  endpoint_sequence: string[]; // Ordered list of endpoint_ids tried
  selected_endpoint_id?: string; // The one that succeeded
  params: Record<string, unknown>;
  success: boolean;
  timestamp: string;
  duration_ms?: number;
  context_url?: string;
}

const MAX_TRACES_PER_DOMAIN = 1000;

/** Allow tests to override the trace store root via env var. */
function getTraceStoreRoot(): string {
  return process.env.UNBROWSE_TRACE_STORE_DIR ?? join(homedir(), ".unbrowse", "traces");
}

/**
 * Normalize a domain for use as a filename:
 * - strip leading "www."
 * - lowercase
 * - replace non-alphanumeric/dot/hyphen chars with underscore
 */
function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.\-]/g, "_");
}

/** Get the trace store directory path. */
export function getTraceStorePath(): string {
  return getTraceStoreRoot();
}

/** Get the JSONL file path for a given domain. */
function domainFilePath(domain: string): string {
  return join(getTraceStoreRoot(), `${normalizeDomain(domain)}.jsonl`);
}

/**
 * Append a trace to the local trace store (JSONL file per domain).
 * Graceful degradation: if fs fails, log and continue.
 */
export function storeExecutionTrace(trace: StoredTrace): void {
  try {
    const dir = getTraceStoreRoot();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const filePath = domainFilePath(trace.domain);
    const line = JSON.stringify(trace) + "\n";
    appendFileSync(filePath, line, "utf-8");
  } catch (err) {
    console.warn(`[trace-store] failed to store trace: ${(err as Error).message}`);
  }
}

/**
 * Parse a JSONL file into an array of StoredTrace, skipping malformed lines.
 * Returns most-recent-last (file order). Truncates to MAX_TRACES_PER_DOMAIN.
 */
function readTraces(domain: string): StoredTrace[] {
  const filePath = domainFilePath(domain);
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const traces: StoredTrace[] = [];
    for (const line of lines) {
      try {
        traces.push(JSON.parse(line) as StoredTrace);
      } catch {
        // Skip malformed lines
      }
    }
    // Truncate old traces if over limit — keep the most recent ones
    if (traces.length > MAX_TRACES_PER_DOMAIN) {
      const truncated = traces.slice(-MAX_TRACES_PER_DOMAIN);
      // Rewrite the file with only the recent traces
      try {
        writeFileSync(filePath, truncated.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf-8");
      } catch {
        // Ignore rewrite failures — reads still work
      }
      return truncated;
    }
    return traces;
  } catch (err) {
    console.warn(`[trace-store] failed to read traces for ${domain}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Retrieve recent traces for a domain (most recent first).
 * @param domain - The domain to look up
 * @param limit - Maximum number of traces to return (default 10)
 */
export function getRecentTraces(domain: string, limit = 10): StoredTrace[] {
  const traces = readTraces(domain);
  // Reverse so most recent is first
  return traces.reverse().slice(0, limit);
}

/**
 * Retrieve traces matching an intent (simple case-insensitive substring match).
 * Returns most recent first.
 * @param domain - The domain to search within
 * @param intent - Substring to match against trace intents
 * @param limit - Maximum number of traces to return (default 5)
 */
export function findTracesByIntent(domain: string, intent: string, limit = 5): StoredTrace[] {
  const traces = readTraces(domain);
  const lowerIntent = intent.toLowerCase();
  return traces
    .filter((t) => t.intent.toLowerCase().includes(lowerIntent))
    .reverse()
    .slice(0, limit);
}
