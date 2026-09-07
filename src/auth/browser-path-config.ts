/**
 * Durable browser path memory — which profile roots the user wants unbrowse
 * to use for cookie import / inventory.
 *
 * Stored at ~/.unbrowse/browser-paths.json (mode 0600). Separate from
 * config.json (agent keys) so path memory is not mixed with credentials.
 *
 * Never stores cookie values — only browser name → userDataDir / profile.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getUnbrowseHome } from "../runtime/paths.js";

export interface BrowserPathEntry {
  /** Absolute path to Chromium user-data dir or Firefox profiles root. */
  userDataDir: string;
  /** Optional profile leaf (e.g. "Default", "Profile 1", or Firefox profile id). */
  profile?: string;
  /** When this entry was last written (ISO). */
  updated_at?: string;
}

export interface BrowserPathConfig {
  /** Preferred browser name for auto cookie import (e.g. "chromium", "firefox"). */
  prefer?: string;
  /** Map of browser key (lowercase) → path entry. */
  browsers: Record<string, BrowserPathEntry>;
}

const EMPTY: BrowserPathConfig = { browsers: {} };

function configPath(): string {
  return join(getUnbrowseHome(), "browser-paths.json");
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export function loadBrowserPathConfig(): BrowserPathConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...EMPTY, browsers: {} };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<BrowserPathConfig>;
    const browsers: Record<string, BrowserPathEntry> = {};
    if (raw.browsers && typeof raw.browsers === "object") {
      for (const [k, v] of Object.entries(raw.browsers)) {
        if (!v || typeof v !== "object") continue;
        const userDataDir = typeof v.userDataDir === "string" ? v.userDataDir.trim() : "";
        if (!userDataDir) continue;
        browsers[normalizeKey(k)] = {
          userDataDir,
          ...(typeof v.profile === "string" && v.profile.trim()
            ? { profile: v.profile.trim() }
            : {}),
          ...(typeof v.updated_at === "string" ? { updated_at: v.updated_at } : {}),
        };
      }
    }
    const prefer =
      typeof raw.prefer === "string" && raw.prefer.trim()
        ? normalizeKey(raw.prefer)
        : undefined;
    return { prefer, browsers };
  } catch {
    return { ...EMPTY, browsers: {} };
  }
}

export function saveBrowserPathConfig(cfg: BrowserPathConfig): string {
  const home = getUnbrowseHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const path = configPath();
  const clean: BrowserPathConfig = {
    ...(cfg.prefer ? { prefer: normalizeKey(cfg.prefer) } : {}),
    browsers: {},
  };
  for (const [k, v] of Object.entries(cfg.browsers ?? {})) {
    if (!v?.userDataDir) continue;
    clean.browsers[normalizeKey(k)] = {
      userDataDir: v.userDataDir,
      ...(v.profile ? { profile: v.profile } : {}),
      updated_at: v.updated_at ?? new Date().toISOString(),
    };
  }
  writeFileSync(path, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
  return path;
}

/** Set or replace one browser path entry; optional prefer switch. */
export function setBrowserPath(
  name: string,
  userDataDir: string,
  opts?: { profile?: string; prefer?: boolean },
): BrowserPathConfig {
  const cfg = loadBrowserPathConfig();
  const key = normalizeKey(name);
  cfg.browsers[key] = {
    userDataDir: userDataDir.replace(/^~\//, `${process.env.HOME ?? ""}/`),
    ...(opts?.profile ? { profile: opts.profile } : {}),
    updated_at: new Date().toISOString(),
  };
  if (opts?.prefer) cfg.prefer = key;
  saveBrowserPathConfig(cfg);
  return loadBrowserPathConfig();
}

export function setPreferredBrowser(name: string): BrowserPathConfig {
  const cfg = loadBrowserPathConfig();
  cfg.prefer = normalizeKey(name);
  saveBrowserPathConfig(cfg);
  return loadBrowserPathConfig();
}

/**
 * Configured userDataDir for a browser name, if any and path still exists.
 */
export function configuredUserDataDir(name: string): string | null {
  const key = normalizeKey(name);
  const entry = loadBrowserPathConfig().browsers[key];
  if (!entry?.userDataDir) return null;
  return existsSync(entry.userDataDir) ? entry.userDataDir : null;
}

/**
 * Extra profile roots from memory — prepended ahead of auto-discovered roots
 * so configured paths win.
 */
export function configuredRootsForFamily(family: "chromium" | "firefox"): string[] {
  const cfg = loadBrowserPathConfig();
  const chromiumKeys = new Set([
    "chrome",
    "chromium",
    "brave",
    "edge",
    "vivaldi",
    "opera",
    "arc",
    "dia",
  ]);
  const out: string[] = [];
  for (const [key, entry] of Object.entries(cfg.browsers)) {
    if (!entry?.userDataDir || !existsSync(entry.userDataDir)) continue;
    const isFf = key === "firefox" || key === "ff";
    if (family === "firefox" && isFf) out.push(entry.userDataDir);
    if (family === "chromium" && !isFf && (chromiumKeys.has(key) || key.includes("chrom"))) {
      out.push(entry.userDataDir);
    }
  }
  return out;
}

export function preferredBrowserName(): string | null {
  const p = loadBrowserPathConfig().prefer?.trim();
  return p || null;
}

export function browserPathConfigFile(): string {
  return configPath();
}
