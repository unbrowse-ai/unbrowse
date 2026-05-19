/**
 * Browser history scanner — list recently-visited eTLD+1 domains.
 *
 * Read-only, redacted-by-construction: only domain + visit counts surface,
 * never subdomain / path / query. Used by the MCP resource layer to expose
 * `unbrowse://browser-history/recent` so the calling agent can disambiguate
 * intents (e.g. resolve "reddit" → user actually visits r/singularity).
 *
 * Privacy model:
 * - Default OFF. Reading the resource without `UNBROWSE_EXPOSE_HISTORY=1`
 *   (or `browser.expose_history=true` in `~/.unbrowse/settings.json`)
 *   yields a disabled-shape response from the MCP layer; this module
 *   never enforces that gate — it's the resource handler's job.
 * - eTLD+1 only. Subdomain stripped by `getRegistrableDomain`.
 * - No URL paths, query strings, fragments, or page titles surface.
 */

import { existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getRegistrableDomain } from "../domain.js";

export interface HistoryDomainSummary {
  etld_plus_one: string;
  visit_count: number;
  last_visit: string;
}

export interface HistoryScanReport {
  since: string;
  until: string;
  count: number;
  domains: HistoryDomainSummary[];
  source_browsers: string[];
  redacted: true;
  redaction_rule: "eTLD+1 only; subdomain/path/query stripped";
}

// Same browser list shape as browser-cookies.ts. Kept local rather than
// imported because the cookies module's CHROMIUM_BROWSERS is a private
// const; lifting it into a shared util is out of scope for this seam.
const CHROMIUM_BROWSERS_HISTORY: Array<{ name: string; macPath: string }> = [
  { name: "Chrome", macPath: "Google/Chrome" },
  { name: "Arc", macPath: "Arc/User Data" },
  { name: "Brave", macPath: "BraveSoftware/Brave-Browser" },
  { name: "Edge", macPath: "Microsoft Edge" },
  { name: "Vivaldi", macPath: "Vivaldi" },
  { name: "Opera", macPath: "com.operasoftware.Opera" },
  { name: "Dia", macPath: "Dia/User Data" },
  { name: "Chromium", macPath: "Chromium" },
];

function historyDbPathFor(userDataDir: string): string | null {
  const candidates = [
    join(userDataDir, "Default", "History"),
    join(userDataDir, "Profile 1", "History"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function withTempCopy<T>(dbPath: string, fn: (temp: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "unbrowse-history-"));
  const dest = join(dir, "History");
  try {
    copyFileSync(dbPath, dest);
    for (const ext of ["-wal", "-shm"]) {
      const src = dbPath + ext;
      if (existsSync(src)) copyFileSync(src, dest + ext);
    }
    return fn(dest);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function sqliteQuery(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", ["-separator", "|", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

/**
 * List eTLD+1 domains the user visited in the last `sinceDaysAgo` days
 * across all installed Chromium-family browsers. Returns aggregated visit
 * counts + last-visit timestamps. Never returns subdomain / path / query.
 *
 * Default lookback: 7 days. Chrome's `urls.last_visit_time` is microseconds
 * since 1601-01-01 UTC; converted to ms-since-epoch inside.
 */
export function listRecentDomains(opts?: { sinceDaysAgo?: number }): HistoryScanReport {
  const days = opts?.sinceDaysAgo ?? 7;
  const untilMs = Date.now();
  const sinceMs = untilMs - days * 24 * 60 * 60 * 1000;
  // Chrome stores last_visit_time as microseconds since 1601-01-01.
  // Convert sinceMs to that representation for the WHERE clause.
  const sinceChromeMicros = sinceMs * 1000 + 11644473600000000;

  const agg = new Map<string, { visits: number; last: number }>();
  const browsersFound: string[] = [];
  const home = homedir();

  for (const browser of CHROMIUM_BROWSERS_HISTORY) {
    const userDataDir = platform() === "darwin"
      ? join(home, "Library", "Application Support", browser.macPath)
      : platform() === "win32"
        ? join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), browser.macPath, "User Data")
        : join(home, ".config", browser.macPath.toLowerCase());

    const dbPath = existsSync(userDataDir) ? historyDbPathFor(userDataDir) : null;
    if (!dbPath) continue;

    let rows: string[];
    try {
      rows = withTempCopy(dbPath, (temp) => {
        // Query: url + visit_count + last_visit_time, restricted to lookback window.
        // We don't trust the column order across Chromium versions, so name explicitly.
        const sql = `SELECT url, visit_count, last_visit_time FROM urls WHERE last_visit_time >= ${sinceChromeMicros}`;
        return sqliteQuery(temp, sql).split("\n").filter((l) => l.length > 0);
      });
    } catch {
      continue; // skip browsers whose history DB is unreadable
    }
    browsersFound.push(browser.name);
    for (const line of rows) {
      const sep = line.indexOf("|");
      if (sep < 0) continue;
      const url = line.slice(0, sep);
      const rest = line.slice(sep + 1).split("|");
      const visits = Number.parseInt(rest[0] ?? "0", 10);
      const lastMicros = Number.parseInt(rest[1] ?? "0", 10);
      if (!Number.isFinite(visits) || visits <= 0) continue;
      let host: string;
      try { host = new URL(url).hostname; } catch { continue; }
      if (!host) continue;
      const etld = getRegistrableDomain(host) || host;
      const lastMs = lastMicros > 0
        ? Math.round((lastMicros - 11644473600000000) / 1000)
        : 0;
      let entry = agg.get(etld);
      if (!entry) {
        entry = { visits: 0, last: 0 };
        agg.set(etld, entry);
      }
      entry.visits += visits;
      if (lastMs > entry.last) entry.last = lastMs;
    }
  }

  const domains: HistoryDomainSummary[] = [];
  for (const [etld, entry] of agg.entries()) {
    if (!etld) continue;
    domains.push({
      etld_plus_one: etld,
      visit_count: entry.visits,
      last_visit: entry.last > 0 ? new Date(entry.last).toISOString() : new Date(0).toISOString(),
    });
  }
  domains.sort((a, b) => b.visit_count - a.visit_count);

  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    count: domains.length,
    domains,
    source_browsers: browsersFound,
    redacted: true,
    redaction_rule: "eTLD+1 only; subdomain/path/query stripped",
  };
}
