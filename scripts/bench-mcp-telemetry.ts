#!/usr/bin/env bun
// bench-mcp-telemetry.ts — pull recent telemetry session logs and produce a
// fix-priority report. Bench coverage failures get most of the attention, but
// real-world MCP sessions (the user's actual day-to-day) reveal which tools
// fail in the wild and why. Surface those so the bench corpus keeps tracking
// reality.
import fs from "node:fs";
import path from "node:path";

const SESSIONS_DIR = process.env.UNBROWSE_SESSIONS_DIR
  || path.join(process.env.HOME ?? "/tmp", ".unbrowse", "sessions");

type Event = {
  ts?: string;
  session_id?: string;
  event?: string;
  tool?: string;
  call_id?: string;
  success?: boolean;
  duration_ms?: number;
  error_code?: string;
  response_summary?: {
    shape?: string;
    bytes?: number;
    top_keys?: string[];
  };
  args_fingerprint?: {
    intent?: { intent_hash?: string; length?: number; word_count?: number };
    url?: { scheme?: string; host?: string; path_template?: string };
  };
  intent_status?: string;
  tool_calls_total?: number;
  errors_total?: number;
};

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

function loadSession(file: string): Event[] {
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l) as Event; } catch { return null; }
    })
    .filter((e): e is Event => e !== null);
}

const flags = parseFlags(process.argv.slice(2));
const sinceDays = Number(flags["since-days"] ?? 7);
const sinceMs = Date.now() - sinceDays * 86400_000;
const minOccurrences = Number(flags["min-occurrences"] ?? 1);

if (!fs.existsSync(SESSIONS_DIR)) {
  console.error(`sessions dir not found: ${SESSIONS_DIR}`);
  process.exit(2);
}

const files = fs.readdirSync(SESSIONS_DIR)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => path.join(SESSIONS_DIR, f));

type FailureBucket = {
  tool: string;
  count: number;
  hosts: Map<string, number>;
  error_codes: Map<string, number>;
  intent_hashes: Set<string>;
  sample_durations_ms: number[];
};

const failures = new Map<string, FailureBucket>();
const successes = new Map<string, number>();
const intentStatus = { achieved: 0, partial: 0, failed: 0, missing: 0 };
let sessionsScanned = 0;

for (const file of files) {
  const events = loadSession(file);
  if (events.length === 0) continue;
  const sessionStart = events.find((e) => e.event === "session_start");
  if (!sessionStart?.ts || new Date(sessionStart.ts).getTime() < sinceMs) continue;
  sessionsScanned++;

  // Pair tool_start with tool_end via call_id to recover host context on failures.
  const starts = new Map<string, Event>();
  for (const e of events) {
    if (e.event === "tool_start" && e.call_id) starts.set(e.call_id, e);
    if (e.event === "tool_end" && e.call_id) {
      const start = starts.get(e.call_id);
      const tool = e.tool ?? start?.tool ?? "unknown";
      if (e.success) {
        successes.set(tool, (successes.get(tool) ?? 0) + 1);
      } else {
        if (!failures.has(tool)) {
          failures.set(tool, {
            tool,
            count: 0,
            hosts: new Map(),
            error_codes: new Map(),
            intent_hashes: new Set(),
            sample_durations_ms: [],
          });
        }
        const bucket = failures.get(tool)!;
        bucket.count++;
        const host = start?.args_fingerprint?.url?.host;
        if (host) bucket.hosts.set(host, (bucket.hosts.get(host) ?? 0) + 1);
        if (e.error_code) bucket.error_codes.set(e.error_code, (bucket.error_codes.get(e.error_code) ?? 0) + 1);
        const intentHash = start?.args_fingerprint?.intent?.intent_hash;
        if (intentHash) bucket.intent_hashes.add(intentHash);
        if (typeof e.duration_ms === "number") bucket.sample_durations_ms.push(e.duration_ms);
      }
    }
    if (e.event === "reflection" && e.intent_status) {
      if (e.intent_status === "achieved") intentStatus.achieved++;
      else if (e.intent_status === "partial") intentStatus.partial++;
      else if (e.intent_status === "failed") intentStatus.failed++;
    }
    if (e.event === "reflection_missing") intentStatus.missing++;
  }
}

// Optionally pull server-side telemetry triage clusters via the GitHub auto-filed
// issues. Server side: ~/.unbrowse/sessions ships to
// beta-api.unbrowse.ai/v1/telemetry/session, stored in Neon Postgres, then
// backend/src/jobs/triage-telemetry.ts files GitHub issues labeled
// `triage-needed` on unbrowse-ai/unbrowse-dev for each new failure cluster.
async function fetchGithubTriage(): Promise<Array<Record<string, unknown>>> {
  const repo = process.env.UNBROWSE_TRIAGE_REPO ?? "unbrowse-ai/unbrowse-dev";
  const token = process.env.GITHUB_TOKEN ?? process.env.SKILL_REPO_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "bench-mcp-telemetry",
  };
  if (token) headers.Authorization = `token ${token}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues?labels=triage-needed&state=open&per_page=20`,
      { headers },
    );
    if (!res.ok) return [];
    const issues = await res.json() as Array<Record<string, unknown>>;
    return issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      created_at: issue.created_at,
      body_excerpt: typeof issue.body === "string" ? issue.body.slice(0, 400) : "",
    }));
  } catch {
    return [];
  }
}

const includeServer = !!flags["include-server"];
const serverTriage = includeServer ? await fetchGithubTriage() : [];

const report = {
  sessions_scanned: sessionsScanned,
  since_days: sinceDays,
  sessions_dir: SESSIONS_DIR,
  server_triage_clusters_open: serverTriage,
  intent_status: intentStatus,
  successes: Object.fromEntries(successes),
  failure_buckets: [...failures.values()]
    .filter((b) => b.count >= minOccurrences)
    .sort((a, b) => b.count - a.count)
    .map((b) => ({
      tool: b.tool,
      count: b.count,
      success_rate: (() => {
        const succ = successes.get(b.tool) ?? 0;
        const total = succ + b.count;
        return total > 0 ? Number((succ / total).toFixed(3)) : 0;
      })(),
      top_hosts: [...b.hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      top_error_codes: [...b.error_codes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      distinct_intents: b.intent_hashes.size,
      median_duration_ms: (() => {
        if (b.sample_durations_ms.length === 0) return null;
        const sorted = [...b.sample_durations_ms].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      })(),
    })),
};

console.log(JSON.stringify(report, null, 2));
