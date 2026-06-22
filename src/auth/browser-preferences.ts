/**
 * Browser preferences — pick the user's most-recently-used browser (by recency
 * of activity) and surface its BOOKMARKS + recent HISTORY as preference signals
 * (which eTLD+1 domains the user cares about), so resolve/ranking can personalize.
 *
 * Privacy (same redaction as browser-history.ts): eTLD+1 domains ONLY — never a
 * subdomain, path, query, or bookmark title. Bookmarks are explicit preference
 * (the user saved them); recent history is weak preference (the user visited them).
 */
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { listRecentDomains } from "./browser-history.js";

// Chromium-family browsers (same set as browser-history.ts). Safari (plist
// bookmarks) is a named follow-on — Chromium covers Chrome/Arc/Brave/Edge/Dia.
const CHROMIUM_BROWSERS: Array<{ name: string; macPath: string }> = [
  { name: "Chrome", macPath: "Google/Chrome" },
  { name: "Arc", macPath: "Arc/User Data" },
  { name: "Brave", macPath: "BraveSoftware/Brave-Browser" },
  { name: "Edge", macPath: "Microsoft Edge" },
  { name: "Vivaldi", macPath: "Vivaldi" },
  { name: "Opera", macPath: "com.operasoftware.Opera" },
  { name: "Dia", macPath: "Dia/User Data" },
  { name: "Chromium", macPath: "Chromium" },
];

function userDataDirFor(macPath: string): string {
  return join(homedir(), "Library", "Application Support", macPath);
}

function profileFile(userDataDir: string, file: string): string | null {
  for (const prof of ["Default", "Profile 1"]) {
    const p = join(userDataDir, prof, file);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface BrowserPick {
  name: string;
  userDataDir: string;
  lastActiveMs: number;
}

/**
 * Pick the most-recently-ACTIVE installed Chromium browser by the History DB's
 * mtime — the History file is rewritten on every page visit, so its mtime is the
 * cheapest reliable "which browser is the user actually using" signal.
 */
export function pickMostRecentBrowser(): BrowserPick | null {
  let best: BrowserPick | null = null;
  for (const b of CHROMIUM_BROWSERS) {
    const udd = userDataDirFor(b.macPath);
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
