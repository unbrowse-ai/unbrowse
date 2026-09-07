/**
 * Artifact bridge — copy relevant auth artifacts from the local browser
 * into the capture/replay path so an auth-walled `unbrowse "X feed" --url`
 * can succeed without the user hand-passing cookies.
 *
 * This IS the harness: `unbrowse "<task>" --url` itself copies cookies +
 * storage from the user's real browser into the obscura persist dir and
 * reuses that dir on every future call — no `harness` verb.
 *
 * Persistent layout (mirrors `obscura --storage-dir ./obscura-data` from
 * `Persist-cookies-and-storage.md`):
 *   ~/.unbrowse/obscura/<domain>/cookies.json   (CookieInfo[], camelCase, 0600)
 *   ~/.unbrowse/obscura/<domain>/localStorage/<origin>.json
 * `captureAndIndexViaObscura` receives `storageDir` for this domain so the
 * sidecar loads it on every run and writes it back. Next call starts logged
 * in without re-ripping Firefox. Ephemeral `/tmp` j ars are still supported
 * via the optional `cookiesDir` override for tests/sandboxes.
 *
 * Two artifact kinds:
 *  - Cookie jar (always): best `findBestBrowserSession(domain)` session
 *    -> header (`a=b; c=d`), jar file, `hasAuthenticatedSession`.
 *  - LocalStorage (when obscura writes it): restored from the same storageDir
 *    on the next run. Sealed yields (`page_metadata.localStorage`) on the
 *    graph remain the replay path; here we just persist the dir so the next
 *    capture starts authenticated.
 *
 * PURE + FS-only: no network, no remote, never leaks values past the local
 * machine. Jar is 0600 in the persist dir. `UNBROWSE_IMPORT_BROWSER_COOKIES=0`
 * disables the whole bridge; `disallowedStorageOrigins` keeps sensitive
 * origins out.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getUnbrowseHome } from "../runtime/paths.js";
import {
  findBestBrowserSession,
  hasAuthenticatedSession,
  type BrowserSessionResult,
} from "./browser-cookies.js";
import { writeObscuraJar } from "./obscura-jar.js";

export interface AuthArtifact {
  /** "x.com" etc */
  domain: string;
  /** Best local session for that domain, if any. */
  session: BrowserSessionResult;
  /** `a=b; c=d` header for direct fetch probes. */
  header: string;
  /** Whether the cookie set itself looks like a real login (httpOnly|secure + auth name). */
  authenticated: boolean;
  /** Persisted obscura cookie jar file path (inside storageDir). */
  jarFile?: string;
  /** Dir owning jarFile, passed as --storage-dir to the sidecar. */
  storageDir?: string;
}

/** Resolve a domain from a URL-ish context string. */
export function domainFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return null; }
}

/** Where the persistent per-domain storage lives. */
export function obscuraStorageDir(domain: string): string {
  return join(getUnbrowseHome(), "obscura", domain.replace(/^\./, ""));
}

/** The cheapest probe: is there any plausible artifact at all for this domain? */
export function hasAuthArtifact(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const persist = join(obscuraStorageDir(domain), "cookies.json");
  if (existsSync(persist)) {
    try { const raw = readFileSync(persist, "utf8"); const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length > 0) return true; } catch { /* fall through to browser scan */ }
  }
  const _ambi = authChoices(domain);
  if (_ambi.length >= 2) return false;
  const s = findBestBrowserSession(domain);
  return !!s && s.cookies.length > 0;
}

/** Merge browser cookies into an existing persisted jar (update, don't clobber localStorage dir). */
function seedPersistedJar(persistDir: string, cookies: import("./browser-cookies.js").BrowserCookie[]): string {
  mkdirSync(persistDir, { recursive: true });
  const cookiesFile = join(persistDir, "cookies.json");
  if (existsSync(cookiesFile)) {
    try {
      const existing = JSON.parse(readFileSync(cookiesFile, "utf8")) as unknown;
      if (Array.isArray(existing) && existing.length > 0) {
        writeObscuraJar(persistDir, cookies);
        return cookiesFile;
      }
    } catch { /* fall through to fresh write */ }
  }
  writeObscuraJar(persistDir, cookies);
  return cookiesFile;
}


/** When multiple local browsers hold plausible sessions, the harness cannot choose silently — surface an ask. */
export interface AuthChoice {
  browser: string;
  cookies: number;
  quality: number;
  authenticated: boolean;
}
export function authChoices(domain: string): AuthChoice[] {
  try {
    const { scanAllBrowserSessions } = require("./browser-cookies.js") as typeof import("./browser-cookies.js");
    const all = scanAllBrowserSessions(domain);
    if (all.length < 2) return [];
    // Keep only those that look logged-in; guest-only browsers are not ambiguous on auth.
    const authed = all.filter((s) => s.cookies.length > 0 && hasAuthenticatedSession(s.cookies));
    if (authed.length < 2) return [];
    // Consider ambiguous when top-2 quality is within ~30% (not a clear winner).
    authed.sort((a, b) => b.quality - a.quality);
    if (authed[0].quality === 0) return [];
    if ((authed[0].quality - authed[1].quality) / authed[0].quality > 0.3) return [];
    return authed.slice(0, 4).map((s) => ({ browser: s.browser, cookies: s.cookies.length, quality: s.quality, authenticated: true }));
  } catch { return []; }
}

/** Build the bridge for `domain` or null if nothing exists / disabled. */
export function buildAuthArtifact(domain: string, opts?: { cookiesDir?: string }): AuthArtifact | null {
  const v = String(process.env.UNBROWSE_IMPORT_BROWSER_COOKIES ?? "").trim().toLowerCase();
  if (["0","false","no","off"].includes(v)) return null;
  const persistDir = opts?.cookiesDir ?? obscuraStorageDir(domain);
  const persistFile = join(persistDir, "cookies.json");
  if (existsSync(persistFile)) {
    try {
      const raw = readFileSync(persistFile, "utf8");
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.length > 0) {
        const header = (arr as Array<{ name: string; value: string }>).map((c) => `${c.name}=${c.value}`).join("; ");
        return { domain, session: { browser: "persisted", cookies: arr as unknown as BrowserSessionResult["cookies"], sessionCookies: arr.length, quality: arr.length, source: persistFile }, header, authenticated: true, jarFile: persistFile, storageDir: persistDir };
      }
    } catch { /* fall through to browser scan */ }
  }
  const _choices = authChoices(domain);
  if (_choices.length >= 2) return null;
  const session = findBestBrowserSession(domain);
  if (session && session.cookies.length > 0) {
    const header = session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const authenticated = hasAuthenticatedSession(session.cookies);
    let jarFile: string | undefined;
    let storageDir: string | undefined;
    try {
      mkdirSync(persistDir, { recursive: true });
      jarFile = seedPersistedJar(persistDir, session.cookies);
      storageDir = persistDir;
    } catch { /* header still works; jar is best-effort */ }
    return { domain, session, header, authenticated, jarFile, storageDir };
  }
  return null;
}

/** The pre-resolve "do we have something fresh?" helper — metadata only, no values. */
export function authArtifactStatus(domain: string | null | undefined): { hasArtifact: boolean; authenticated: boolean } {
  if (!domain) return { hasArtifact: false, authenticated: false };
  const hasPersist = existsSync(join(obscuraStorageDir(domain), "cookies.json"));
  if (hasPersist) return { hasArtifact: true, authenticated: true };
  const s = findBestBrowserSession(domain);
  if (!s || s.cookies.length === 0) return { hasArtifact: false, authenticated: false };
  return { hasArtifact: true, authenticated: hasAuthenticatedSession(s.cookies) };
}
