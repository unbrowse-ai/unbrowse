/**
 * Chromium-compatible browser-profile metadata reader.
 *
 * Reads {Cookies, History, Bookmarks} from a Chromium profile directory
 * in READ-ONLY mode and returns per-domain metadata. Cookie VALUES
 * are NEVER read (encrypted_value column is never selected). History
 * URL paths are NEVER returned (only hostnames). Bookmark URL paths
 * are NEVER returned (only hostnames).
 *
 * Lock handling (load-bearing): Chromium browsers hold an exclusive write-lock
 * on Cookies/History when running. Strategy:
 *   1. First try `?mode=ro&immutable=1` — passes the lock by promising
 *      we won't observe concurrent writes; safe for metadata sampling.
 *   2. On `SQLITE_BUSY` / locked error, copy the DB file to /tmp and
 *      open the copy. The copy survives subsequent SIGKILL via the
 *      `finally` cleanup.
 *   3. If both fail, return `{ locked: true }` for that DB and skip
 *      the per-domain rows it would have contributed.
 */
import { Database } from "../../../compat/sqlite.js";
import { existsSync, statSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";

// Chrome stores timestamps as microseconds since 1601-01-01.
const CHROME_TIME_EPOCH_OFFSET_S = 11644473600;
const CHROME_EPOCH_US_TO_UNIX_S = (us: number): number =>
  us > 0 ? Math.floor(us / 1_000_000) - CHROME_TIME_EPOCH_OFFSET_S : 0;

export interface ChromeCookieRow {
  readonly host_key: string;
  readonly name: string;
  readonly expires_utc_unix: number; // unix seconds
  readonly is_httponly: boolean;
  readonly is_secure: boolean;
}

export interface ChromeHistoryRow {
  readonly hostname: string;
  readonly visit_count: number;
  readonly last_visit_unix: number; // unix seconds
}

export interface ChromeBookmarkRow {
  readonly hostname: string;
}

export interface ChromeProfileResult {
  readonly profile_path: string;
  readonly cookies: ChromeCookieRow[];
  readonly history: ChromeHistoryRow[];
  readonly bookmarks: ChromeBookmarkRow[];
  readonly locks: {
    readonly cookies: "open" | "locked" | "missing";
    readonly history: "open" | "locked" | "missing";
    readonly bookmarks: "open" | "missing";
  };
}

/** Default Chrome profile root for the host platform. */
export function defaultChromeRoot(): string | null {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (process.platform === "linux") {
    return join(home, ".config", "google-chrome");
  }
  // Windows out of scope per W21 spec.
  return null;
}

/** Default Dia profile roots for the host platform. */
export function defaultDiaRoots(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "Dia", "User Data"),
      // Some Dia builds have written a nested user-data root during migration.
      join(home, "Library", "Application Support", "Dia", "User Data", "User Data"),
    ];
  }
  if (process.platform === "linux") {
    return [join(home, ".config", "Dia"), join(home, ".config", "dia")];
  }
  return [];
}

/** Enumerate "Default" + "Profile *" directories under a Chromium root. */
export async function listChromeProfiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (n === "Default" || n.startsWith("Profile ")) {
      const p = join(root, n);
      try {
        if (statSync(p).isDirectory()) out.push(p);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

/**
 * Open a sqlite DB in read-only mode, handling Chrome's exclusive lock.
 * Returns { db, cleanup } or null if neither immutable nor copy works.
 *
 * IMPORTANT: cleanup MUST be called in a `finally`. The temp copy file
 * is up to ~10MB (cookies) / ~100MB (history) — leaking it is a real
 * disk-usage bug.
 */
function openRoSqlite(path: string): { db: Database; cleanup: () => void } | null {
  if (!existsSync(path)) return null;

  // Try immutable=1 first — fastest, no copy.
  try {
    const db = new Database(`file:${path}?mode=ro&immutable=1`, { readonly: true });
    // touch-test the connection with a trivial query so we surface
    // SQLITE_BUSY here rather than at the first real query.
    db.query("SELECT 1").get();
    return { db, cleanup: () => db.close() };
  } catch {
    // fall through to copy-fallback
  }

  // Copy fallback. Use a unique temp dir per call so concurrent callers
  // don't stomp each other.
  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "unbrowse-auth-inventory-"));
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
    // Last-resort cleanup of partial temp dir.
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    return null;
  }
}

/**
 * Pull cookie metadata. NEVER selects `value` or `encrypted_value`.
 */
function readChromeCookies(profilePath: string): {
  rows: ChromeCookieRow[];
  status: "open" | "locked" | "missing";
} {
  const dbPath = join(profilePath, "Cookies");
  if (!existsSync(dbPath)) {
    return { rows: [], status: "missing" };
  }
  const opened = openRoSqlite(dbPath);
  if (!opened) {
    return { rows: [], status: "locked" };
  }
  try {
    // Explicit allow-list of safe columns. encrypted_value / value are NEVER named.
    type Row = {
      host_key: string;
      name: string;
      expires_utc: number;
      is_httponly: number;
      is_secure: number;
    };
    const stmt = opened.db.query<Row, []>(
      "SELECT host_key, name, expires_utc, is_httponly, is_secure FROM cookies",
    );
    const raw = stmt.all();
    const rows: ChromeCookieRow[] = raw.map((r) => ({
      host_key: String(r.host_key ?? ""),
      name: String(r.name ?? ""),
      expires_utc_unix: CHROME_EPOCH_US_TO_UNIX_S(Number(r.expires_utc ?? 0)),
      is_httponly: Number(r.is_httponly ?? 0) === 1,
      is_secure: Number(r.is_secure ?? 0) === 1,
    }));
    return { rows, status: "open" };
  } catch {
    return { rows: [], status: "locked" };
  } finally {
    opened.cleanup();
  }
}

/**
 * Pull history metadata — HOSTNAMES ONLY.
 *
 * SECURITY INVARIANT: the `url` column may contain `?token=...&session=...`
 * query strings. We parse the URL inside this function and DISCARD the
 * full URL before any data crosses the function boundary.
 */
function readChromeHistory(profilePath: string): {
  rows: ChromeHistoryRow[];
  status: "open" | "locked" | "missing";
} {
  const dbPath = join(profilePath, "History");
  if (!existsSync(dbPath)) {
    return { rows: [], status: "missing" };
  }
  const opened = openRoSqlite(dbPath);
  if (!opened) {
    return { rows: [], status: "locked" };
  }
  try {
    type Row = { url: string; visit_count: number; last_visit_time: number };
    const stmt = opened.db.query<Row, []>(
      "SELECT url, visit_count, last_visit_time FROM urls WHERE visit_count > 5",
    );
    const raw = stmt.all();
    // Aggregate by hostname (a domain may have many distinct URLs).
    const agg = new Map<string, { visit_count: number; last_visit_unix: number }>();
    for (const r of raw) {
      const hostname = hostnameFromUrl(String(r.url ?? ""));
      if (!hostname) continue;
      const last_visit_unix = CHROME_EPOCH_US_TO_UNIX_S(Number(r.last_visit_time ?? 0));
      const prev = agg.get(hostname);
      const visit_count = Number(r.visit_count ?? 0);
      if (prev) {
        prev.visit_count += visit_count;
        if (last_visit_unix > prev.last_visit_unix) prev.last_visit_unix = last_visit_unix;
      } else {
        agg.set(hostname, { visit_count, last_visit_unix });
      }
    }
    const rows: ChromeHistoryRow[] = [];
    for (const [hostname, v] of agg.entries()) {
      rows.push({ hostname, visit_count: v.visit_count, last_visit_unix: v.last_visit_unix });
    }
    return { rows, status: "open" };
  } catch {
    return { rows: [], status: "locked" };
  } finally {
    opened.cleanup();
  }
}

/**
 * Walk the Chrome Bookmarks JSON file. HOSTNAMES ONLY — paths and
 * query strings (`?api_key=...`) are stripped before output.
 */
async function readChromeBookmarks(profilePath: string): Promise<{
  rows: ChromeBookmarkRow[];
  status: "open" | "missing";
}> {
  const bmPath = join(profilePath, "Bookmarks");
  if (!existsSync(bmPath)) return { rows: [], status: "missing" };
  try {
    const raw = await readFile(bmPath, "utf8");
    const parsed = JSON.parse(raw) as { roots?: Record<string, unknown> };
    const hosts = new Set<string>();
    if (parsed.roots && typeof parsed.roots === "object") {
      for (const k of Object.keys(parsed.roots)) {
        walkBookmarkNode(parsed.roots[k], hosts);
      }
    }
    return { rows: [...hosts].map((hostname) => ({ hostname })), status: "open" };
  } catch {
    return { rows: [], status: "open" }; // unreadable → empty, not locked
  }
}

function walkBookmarkNode(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n.url === "string") {
    const host = hostnameFromUrl(n.url);
    if (host) out.add(host);
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) walkBookmarkNode(child, out);
  }
}

/**
 * Extract a normalised hostname from a URL string. Strips `www.` prefix
 * for de-duplication. Returns `""` on parse failure (caller should drop).
 *
 * NEVER returns or logs the full URL — that's the whole security point
 * of this helper.
 */
export function hostnameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return "";
  }
}

/** Top-level entry: read everything in a Chrome profile directory. */
export async function readChromeProfile(profilePath: string): Promise<ChromeProfileResult> {
  const ck = readChromeCookies(profilePath);
  const hi = readChromeHistory(profilePath);
  const bm = await readChromeBookmarks(profilePath);
  return {
    profile_path: profilePath,
    cookies: ck.rows,
    history: hi.rows,
    bookmarks: bm.rows,
    locks: {
      cookies: ck.status,
      history: hi.status,
      bookmarks: bm.status,
    },
  };
}
