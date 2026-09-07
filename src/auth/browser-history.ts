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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRegistrableDomain } from "../domain.js";
import {
  type BrowserProfileTarget,
  existingBrowserProfileRoots,
  listProfileArtifactsInRoot,
} from "./browser-profile-roots.js";

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
/**
 * History lives beside cookies, so it must be discovered the same way — through
 * the one resolver, not a sixth hand-rolled expression.
 *
 * The previous Linux branch was `join(home, ".config", macPath.toLowerCase())`,
 * which is not merely sandbox-blind but wrong for most of this list on ANY Linux
 * install: Chrome is `~/.config/google-chrome`, not `google/chrome`; Edge is
 * `microsoft-edge`, not `microsoft edge`; Brave keeps its capitals on a
 * case-sensitive filesystem. Only Vivaldi and Chromium ever resolved. Naming
 * `linuxUserData` explicitly is what makes that unrepresentable, and routing
 * through the resolver is what picks up Flatpak and Snap for free.
 *
 * macOS is unchanged: the resolver's darwin branch is the same expression this
 * file used to inline.
 *
 * Windows IS changed, and was broken before. `%LOCALAPPDATA%/<macPath>/User Data`
 * gives Edge `Microsoft Edge/User Data` when Windows uses `Microsoft\Edge\`, and
 * gives Arc and Dia a doubled `User Data/User Data` because their macOS leaf
 * already ends in it. Hence the explicit `winPath` on those three. This was
 * pre-existing — the inlined expression did the same — and was found by fixing
 * the sibling browser-preferences.ts, which is precisely the failure mode
 * duplicated discovery produces: the same defect surviving in the copy nobody
 * touched.
 */
export const CHROMIUM_BROWSERS_HISTORY: Array<{ name: string; target: BrowserProfileTarget }> = [
  { name: "Chrome", target: { family: "chromium", macPath: "Google/Chrome", linuxUserData: "google-chrome" } },
  { name: "Arc", target: { family: "chromium", macPath: "Arc/User Data", linuxUserData: "arc", winPath: "Arc" } },
  { name: "Brave", target: { family: "chromium", macPath: "BraveSoftware/Brave-Browser", linuxUserData: "BraveSoftware/Brave-Browser" } },
  { name: "Edge", target: { family: "chromium", macPath: "Microsoft Edge", linuxUserData: "microsoft-edge", winPath: "Microsoft/Edge" } },
  { name: "Vivaldi", target: { family: "chromium", macPath: "Vivaldi", linuxUserData: "vivaldi" } },
  { name: "Opera", target: { family: "chromium", macPath: "com.operasoftware.Opera", linuxUserData: "opera" } },
  { name: "Dia", target: { family: "chromium", macPath: "Dia/User Data", linuxUserData: "dia", winPath: "Dia" } },
  { name: "Chromium", target: { family: "chromium", macPath: "Chromium", linuxUserData: "chromium" } },
];

/**
 * The History DB under this user-data dir: the profile that HAS one, most
 * recently used first. A `Default` / `Profile 1` name list misses the profile
 * the user actually browses with whenever it is any other one — see
 * `listProfileArtifactsInRoot`.
 */
function historyDbPathFor(userDataDir: string): string | null {
  return listProfileArtifactsInRoot(userDataDir, "History")[0]?.path ?? null;
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

  for (const browser of CHROMIUM_BROWSERS_HISTORY) {
    // A machine can run a native Chrome AND a Flatpak one; scan every root that
    // exists rather than stopping at the first, exactly as the cookie inventory
    // does — the logged-in session may live in either.
    const dbPath = existingBrowserProfileRoots(browser.target)
      .map((root) => historyDbPathFor(root))
      .find((p): p is string => p !== null) ?? null;
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
