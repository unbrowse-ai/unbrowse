/**
 * Firefox browser-profile metadata reader.
 *
 * Mirror of chrome.ts but against Firefox's schema:
 *   - cookies.sqlite / moz_cookies (host, name, expiry [unix seconds])
 *   - places.sqlite / moz_places (url, visit_count, last_visit_date [microseconds])
 *   - places.sqlite / moz_bookmarks JOIN moz_places (bookmark URLs)
 *
 * Same lock-handling strategy as Chrome: immutable=1 first, copy-to-tmp
 * fallback. Same security invariants: cookie VALUES never read; history
 * and bookmark URL paths never returned (hostnames only).
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { hostnameFromUrl } from "./chrome.js";

export interface FirefoxCookieRow {
  readonly host_key: string;
  readonly name: string;
  readonly expires_utc_unix: number;
  readonly is_httponly: boolean;
  readonly is_secure: boolean;
}

export interface FirefoxHistoryRow {
  readonly hostname: string;
  readonly visit_count: number;
  readonly last_visit_unix: number;
}

export interface FirefoxBookmarkRow {
  readonly hostname: string;
}

export interface FirefoxProfileResult {
  readonly profile_path: string;
  readonly cookies: FirefoxCookieRow[];
  readonly history: FirefoxHistoryRow[];
  readonly bookmarks: FirefoxBookmarkRow[];
  readonly locks: {
    readonly cookies: "open" | "locked" | "missing";
    readonly places: "open" | "locked" | "missing";
  };
}

/** Firefox profiles root for the host platform. */
export function defaultFirefoxRoot(): string | null {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Firefox", "Profiles");
  }
  if (process.platform === "linux") {
    return join(home, ".mozilla", "firefox");
  }
  return null;
}

/** Enumerate `*.default*` profile directories under a Firefox root. */
export async function listFirefoxProfiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (!n.includes(".default")) continue;
    const p = join(root, n);
    try {
      if (statSync(p).isDirectory()) out.push(p);
    } catch {
      // ignore
    }
  }
  return out;
}

function openRoSqlite(path: string): { db: Database; cleanup: () => void } | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(`file:${path}?mode=ro&immutable=1`, { readonly: true });
    db.query("SELECT 1").get();
    return { db, cleanup: () => db.close() };
  } catch {
    // fall through
  }
  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "unbrowse-auth-inventory-ff-"));
    const tmpPath = join(tmpDir, "db.sqlite");
    copyFileSync(path, tmpPath);
    const db = new Database(`file:${tmpPath}?mode=ro`, { readonly: true });
    db.query("SELECT 1").get();
    const dirToClean = tmpDir;
    return {
      db,
      cleanup: () => {
        try {
          db.close();
        } catch {}
        try {
          rmSync(dirToClean, { recursive: true, force: true });
        } catch {}
      },
    };
  } catch {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    return null;
  }
}

function readFirefoxCookies(profilePath: string): {
  rows: FirefoxCookieRow[];
  status: "open" | "locked" | "missing";
} {
  const dbPath = join(profilePath, "cookies.sqlite");
  if (!existsSync(dbPath)) return { rows: [], status: "missing" };
  const opened = openRoSqlite(dbPath);
  if (!opened) return { rows: [], status: "locked" };
  try {
    // Allow-list of safe columns. `value` is NEVER named.
    type Row = {
      host: string;
      name: string;
      expiry: number;
      isHttpOnly: number;
      isSecure: number;
    };
    const stmt = opened.db.query<Row, []>(
      "SELECT host, name, expiry, isHttpOnly, isSecure FROM moz_cookies",
    );
    const raw = stmt.all();
    const rows: FirefoxCookieRow[] = raw.map((r) => ({
      host_key: String(r.host ?? ""),
      name: String(r.name ?? ""),
      expires_utc_unix: Number(r.expiry ?? 0), // firefox stores unix seconds directly
      is_httponly: Number(r.isHttpOnly ?? 0) === 1,
      is_secure: Number(r.isSecure ?? 0) === 1,
    }));
    return { rows, status: "open" };
  } catch {
    return { rows: [], status: "locked" };
  } finally {
    opened.cleanup();
  }
}

/**
 * Read history + bookmarks from places.sqlite. Both live in the same
 * DB so we open it once. Hostnames only — URLs are parsed inside this
 * function and the path/query are discarded.
 *
 * moz_places columns: id, url, visit_count, last_visit_date (microseconds)
 * moz_bookmarks columns: type=1 means URL bookmark, fk → moz_places.id
 */
function readFirefoxPlaces(profilePath: string): {
  history: FirefoxHistoryRow[];
  bookmarks: FirefoxBookmarkRow[];
  status: "open" | "locked" | "missing";
} {
  const dbPath = join(profilePath, "places.sqlite");
  if (!existsSync(dbPath)) return { history: [], bookmarks: [], status: "missing" };
  const opened = openRoSqlite(dbPath);
  if (!opened) return { history: [], bookmarks: [], status: "locked" };
  try {
    // History.
    type HistoryRow = { url: string; visit_count: number; last_visit_date: number };
    const histStmt = opened.db.query<HistoryRow, []>(
      "SELECT url, visit_count, last_visit_date FROM moz_places WHERE visit_count > 5",
    );
    const histRaw = histStmt.all();
    const histAgg = new Map<string, { visit_count: number; last_visit_unix: number }>();
    for (const r of histRaw) {
      const hostname = hostnameFromUrl(String(r.url ?? ""));
      if (!hostname) continue;
      // last_visit_date is microseconds since unix epoch in modern Firefox.
      const lvUs = Number(r.last_visit_date ?? 0);
      const last_visit_unix = lvUs > 1_000_000_000_000 ? Math.floor(lvUs / 1_000_000) : lvUs;
      const visit_count = Number(r.visit_count ?? 0);
      const prev = histAgg.get(hostname);
      if (prev) {
        prev.visit_count += visit_count;
        if (last_visit_unix > prev.last_visit_unix) prev.last_visit_unix = last_visit_unix;
      } else {
        histAgg.set(hostname, { visit_count, last_visit_unix });
      }
    }
    const history: FirefoxHistoryRow[] = [];
    for (const [hostname, v] of histAgg.entries()) {
      history.push({ hostname, visit_count: v.visit_count, last_visit_unix: v.last_visit_unix });
    }

    // Bookmarks: join URL bookmarks with their backing places row.
    type BmRow = { url: string };
    const bmStmt = opened.db.query<BmRow, []>(
      "SELECT p.url FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id WHERE b.type = 1 AND p.url IS NOT NULL",
    );
    const bmRaw = bmStmt.all();
    const bmSet = new Set<string>();
    for (const r of bmRaw) {
      const host = hostnameFromUrl(String(r.url ?? ""));
      if (host) bmSet.add(host);
    }
    const bookmarks: FirefoxBookmarkRow[] = [...bmSet].map((hostname) => ({ hostname }));

    return { history, bookmarks, status: "open" };
  } catch {
    return { history: [], bookmarks: [], status: "locked" };
  } finally {
    opened.cleanup();
  }
}

export async function readFirefoxProfile(profilePath: string): Promise<FirefoxProfileResult> {
  const ck = readFirefoxCookies(profilePath);
  const pl = readFirefoxPlaces(profilePath);
  return {
    profile_path: profilePath,
    cookies: ck.rows,
    history: pl.history,
    bookmarks: pl.bookmarks,
    locks: {
      cookies: ck.status,
      places: pl.status,
    },
  };
}
