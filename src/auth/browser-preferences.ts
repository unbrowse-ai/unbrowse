/**
 * Browser preferences — pick the user's most-recently-used browser (by recency
 * of activity) and surface its BOOKMARKS + recent HISTORY as preference signals
 * (which eTLD+1 domains the user cares about), so resolve/ranking can personalize.
 *
 * Privacy (same redaction as browser-history.ts): eTLD+1 domains ONLY — never a
 * subdomain, path, query, or bookmark title. Bookmarks are explicit preference
 * (the user saved them); recent history is weak preference (the user visited them).
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRecentDomains } from "./browser-history.js";
import {
  type BrowserProfileTarget,
  FIREFOX_PROFILE_TARGET,
  existingBrowserProfileRoots,
  listProfileArtifactsInRoot,
} from "./browser-profile-roots.js";

/**
 * Chromium-family browsers (same set as browser-history.ts). Safari (plist
 * bookmarks) is a named follow-on — Chromium covers Chrome/Arc/Brave/Edge/Dia.
 *
 * The SIXTH hand-rolled profile path, and the only one with no platform branch
 * at all: `userDataDirFor` built `~/Library/Application Support/<macPath>`
 * unconditionally, so on Linux and on Windows `pickMostRecentBrowser` returned
 * null for every browser and the whole preference signal — bookmarks AND recent
 * history — was dead rather than degraded on two of three platforms.
 *
 * `linuxUserData` is named EXPLICITLY per browser, never derived from `macPath`.
 * Deriving it is what broke `browser-history.ts` for most of this same list:
 * Chrome lives at `~/.config/google-chrome`, not `google/chrome`; Edge at
 * `microsoft-edge`, not `microsoft edge`; Brave keeps its capitals on a
 * case-sensitive filesystem. Routing through the one resolver is what picks up
 * Flatpak and Snap for free.
 *
 * `winPath` is likewise named wherever `%LOCALAPPDATA%/<macPath>/User Data`
 * would be wrong — Edge is `Microsoft/Edge`, and the three macOS leaves that
 * already end in "User Data" would otherwise double it. Opera is the one
 * remaining gap and it is stated rather than papered over: its Windows profile
 * lives under `%APPDATA%` (roaming), which the shared resolver's Chromium
 * branch does not model, so Opera stays undiscovered on Windows.
 *
 * macOS is unchanged by construction: the resolver's darwin branch is the same
 * `join(home, "Library", "Application Support", macPath)` this file inlined.
 */
const CHROMIUM_BROWSERS: Array<{ name: string; target: BrowserProfileTarget }> = [
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
 * A profile-scoped file under this user-data dir, most recently used first.
 * Discovery (not a `Default` / `Profile 1` name list) so a browser whose only
 * signed-in profile is `Profile 3` still reports as having cookies/history.
 */
function profileFile(userDataDir: string, file: string): string | null {
  return listProfileArtifactsInRoot(userDataDir, file)[0]?.path ?? null;
}

export interface BrowserPick {
  name: string;
  userDataDir: string;
  lastActiveMs: number;
}

export interface InstalledBrowserOption {
  /** Display name (Chrome, Firefox, Brave, …). */
  name: string;
  family: "chromium" | "firefox";
  userDataDir: string;
  /** Max mtime of History / cookies.sqlite under this root (0 if unknown). */
  lastActiveMs: number;
  last_active: string | null;
  has_cookies_db: boolean;
  has_history_db: boolean;
  has_bookmarks: boolean;
}

/**
 * Enumerate every installed browser profile root as a selectable option.
 * Metadata only — never cookie values, never full history URLs.
 * Sorted by lastActiveMs descending (most recently used first).
 */
export function listInstalledBrowsers(): InstalledBrowserOption[] {
  const out: InstalledBrowserOption[] = [];

  for (const b of CHROMIUM_BROWSERS) {
    for (const udd of existingBrowserProfileRoots(b.target)) {
      const hist = profileFile(udd, "History");
      const cookies =
        profileFile(udd, join("Network", "Cookies")) ?? profileFile(udd, "Cookies");
      const bookmarks = profileFile(udd, "Bookmarks");
      let mt = 0;
      for (const p of [hist, cookies, bookmarks]) {
        if (!p) continue;
        try {
          const t = statSync(p).mtimeMs;
          if (t > mt) mt = t;
        } catch {
          /* skip */
        }
      }
      out.push({
        name: b.name,
        family: "chromium",
        userDataDir: udd,
        lastActiveMs: mt,
        last_active: mt > 0 ? new Date(mt).toISOString() : null,
        has_cookies_db: Boolean(cookies),
        has_history_db: Boolean(hist),
        has_bookmarks: Boolean(bookmarks),
      });
    }
  }

  // Firefox roots (native + Flatpak + Snap via shared resolver).
  for (const root of existingBrowserProfileRoots(FIREFOX_PROFILE_TARGET)) {
    if (!existsSync(root)) continue;
    // Profile dirs under the root; use root-level activity for the option.
    let mt = 0;
    let hasCookies = false;
    let hasPlaces = false;
    try {
      for (const ent of readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const cookies = join(root, ent.name, "cookies.sqlite");
        const places = join(root, ent.name, "places.sqlite");
        if (existsSync(cookies)) {
          hasCookies = true;
          try {
            mt = Math.max(mt, statSync(cookies).mtimeMs);
          } catch {
            /* */
          }
        }
        if (existsSync(places)) {
          hasPlaces = true;
          try {
            mt = Math.max(mt, statSync(places).mtimeMs);
          } catch {
            /* */
          }
        }
      }
    } catch {
      /* unreadable root */
    }
    out.push({
      name: "Firefox",
      family: "firefox",
      userDataDir: root,
      lastActiveMs: mt,
      last_active: mt > 0 ? new Date(mt).toISOString() : null,
      has_cookies_db: hasCookies,
      has_history_db: hasPlaces,
      has_bookmarks: hasPlaces,
    });
  }

  out.sort((a, b) => {
    if (b.lastActiveMs !== a.lastActiveMs) return b.lastActiveMs - a.lastActiveMs;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Pick the most-recently-ACTIVE installed Chromium browser by the History DB's
 * mtime — the History file is rewritten on every page visit, so its mtime is the
 * cheapest reliable "which browser is the user actually using" signal.
 */
export function pickMostRecentBrowser(): BrowserPick | null {
  let best: BrowserPick | null = null;
  for (const b of CHROMIUM_BROWSERS) {
    // A machine can run a native Chrome AND a Flatpak one; consider EVERY root
    // that exists rather than stopping at the first. Which one is live is
    // exactly the question mtime answers, so short-circuiting on the native
    // root would hand a stale answer to a user whose session is in the sandbox.
    for (const udd of existingBrowserProfileRoots(b.target)) {
      const hist = profileFile(udd, "History");
      if (!hist) continue;
      let mt = 0;
      try {
        mt = statSync(hist).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mt > best.lastActiveMs) best = { name: b.name, userDataDir: udd, lastActiveMs: mt };
    }
  }
  return best;
}

function etld1(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const parts = h.split(".").filter(Boolean);
    if (parts.length < 2) return h || null;
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

/** Flatten a Chromium Bookmarks JSON tree to its eTLD+1 domains (deduped). */
export function bookmarkDomainsFromJson(json: unknown): string[] {
  const out = new Set<string>();
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "url" && typeof node.url === "string") {
      const d = etld1(node.url);
      if (d) out.add(d);
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  const roots = (json as any)?.roots ?? {};
  for (const k of ["bookmark_bar", "other", "synced"]) walk(roots[k]);
  return [...out];
}

/** Read bookmark eTLD+1 domains from a browser's Chromium Bookmarks JSON file. */
export function readBookmarkDomains(userDataDir: string): string[] {
  const bm = profileFile(userDataDir, "Bookmarks");
  if (!bm) return [];
  try {
    return bookmarkDomainsFromJson(JSON.parse(readFileSync(bm, "utf8")));
  } catch {
    return [];
  }
}

export interface BrowserPreferences {
  /** the most-recently-active browser, or null if none installed. */
  browser: string | null;
  /** ISO timestamp of that browser's last activity (History mtime). */
  last_active: string | null;
  /** strong preference — domains the user explicitly bookmarked. */
  bookmark_domains: string[];
  /** weak preference — domains visited recently (eTLD+1, redacted). */
  recent_domains: string[];
  redacted: true;
}

/**
 * The user's browser preferences: the most-recent browser's bookmarks (strong)
 * + its recent history domains (weak), all eTLD+1-redacted. Resolve/ranking can
 * weight a candidate higher when its domain is bookmarked or recently visited.
 */
export function browserPreferences(opts?: { sinceDaysAgo?: number }): BrowserPreferences {
  const pick = pickMostRecentBrowser();
  if (!pick) {
    return { browser: null, last_active: null, bookmark_domains: [], recent_domains: [], redacted: true };
  }
  const bookmark_domains = readBookmarkDomains(pick.userDataDir);
  let recent_domains: string[] = [];
  try {
    const hist = listRecentDomains({ sinceDaysAgo: opts?.sinceDaysAgo ?? 14 });
    recent_domains = (hist.domains ?? []).map((d) => d.etld_plus_one).filter(Boolean).slice(0, 50);
  } catch {
    // history is optional — bookmarks alone are still a valid preference signal
  }
  return {
    browser: pick.name,
    last_active: new Date(pick.lastActiveMs).toISOString(),
    bookmark_domains,
    recent_domains,
    redacted: true,
  };
}
