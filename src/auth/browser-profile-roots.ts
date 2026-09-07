/**
 * ONE resolver for browser profile roots — native, Flatpak, Snap.
 *
 * Why this file exists: Linux discovery used to be hardcoded to
 * `~/.mozilla/firefox` and `~/.config/<userData>` in four separate places
 * (cookie extraction, the multi-browser sweep, the domain scanner, the
 * auth-inventory sources). A Firefox or Chromium installed as a Flatpak or a
 * Snap — SteamOS, Fedora Silverblue, Ubuntu, Bazzite — was therefore never
 * discovered, `act go` silently returned logged-out pages, and
 * `eval auth-inventory` reported `sources_scanned: []` on a machine with
 * cookies for a hundred domains.
 *
 * The duplication is the actual defect: fixing two of the four call sites made
 * `act go` work while auth-inventory still returned nothing, because it goes
 * through a different one. Every site now asks THIS function, so the next
 * layout that needs adding is added once and every path sees it.
 *
 * Two rules hold everywhere in here:
 *   1. The native path is ALWAYS the first candidate. A machine with a
 *      conventional install resolves to exactly the path it resolved to
 *      before this file existed.
 *   2. Nothing here touches the filesystem except through `exists`, which is
 *      injectable — the candidate list is a pure function of (home, platform,
 *      target) and can be asserted without a real profile on disk.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { configuredRootsForFamily } from "./browser-path-config.js";

export type BrowserFamily = "firefox" | "chromium";

export interface BrowserProfileTarget {
  /** Which on-disk layout the browser uses. */
  readonly family: BrowserFamily;
  /** Leaf under `~/Library/Application Support` (macOS), e.g. "Google/Chrome". */
  readonly macPath?: string;
  /**
   * Leaf(s) under `~/.config` (Linux), canonical FIRST, e.g. "google-chrome"
   * or "BraveSoftware/Brave-Browser". Extra entries are compatibility aliases:
   * they are searched, but only the canonical one derives the Flatpak app id.
   */
  readonly linuxUserData?: string | readonly string[];
  /** Leaf under `%LOCALAPPDATA%` (Windows) when it differs from `macPath`. */
  readonly winPath?: string;
  /** Flatpak application id; defaults to the canonical leaf's entry in `LINUX_FLATPAK_APP_IDS`. */
  readonly flatpakAppId?: string;
  /** Snap package name; defaults to the canonical leaf's entry in `LINUX_SNAP_NAMES`. */
  readonly snapName?: string;
}

export interface ResolveProfileRootsOptions {
  /** Home directory override (tests). Defaults to `os.homedir()`. */
  readonly home?: string;
  /** Platform override (tests). Defaults to `os.platform()`. */
  readonly platform?: string;
  /** Environment override (tests). Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Existence predicate (tests). Defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
}

export interface ListProfileArtifactsOptions extends ResolveProfileRootsOptions {
  /** Subdirectory lister (tests). Defaults to `fs.readdirSync` (directories only). */
  readonly readdir?: (dir: string) => string[];
  /** Artifact mtime in ms (tests). Defaults to `fs.statSync().mtimeMs`, 0 on error. */
  readonly mtimeMs?: (path: string) => number;
}

/** One profile-scoped file (cookie jar, history DB, …) that actually exists. */
export interface BrowserProfileArtifact {
  /** The profile root it was found under. */
  readonly root: string;
  /** Profile directory name, or "" when the artifact sits at the root itself. */
  readonly profile: string;
  /** Absolute path to the artifact. */
  readonly path: string;
  /** Artifact mtime (ms); 0 when unreadable. Recency == the profile in use. */
  readonly mtimeMs: number;
}

/**
 * Linux `~/.config` leaf → Flatpak application id. This is the table the bug
 * report calls for: without it a Flatpak install has no discoverable profile
 * directory at all. Keyed by the canonical leaf so the same map serves both
 * the resolver and the "is anything sandboxed installed?" probe.
 */
export const LINUX_FLATPAK_APP_IDS: Readonly<Record<string, string>> = {
  firefox: "org.mozilla.firefox",
  "google-chrome": "com.google.Chrome",
  chromium: "org.chromium.Chromium",
  "BraveSoftware/Brave-Browser": "com.brave.Browser",
  "microsoft-edge": "com.microsoft.Edge",
  vivaldi: "com.vivaldi.Vivaldi",
  opera: "com.opera.Opera",
};

/** Linux `~/.config` leaf → Snap package name (the snap name is not the leaf). */
export const LINUX_SNAP_NAMES: Readonly<Record<string, string>> = {
  firefox: "firefox",
  chromium: "chromium",
  "BraveSoftware/Brave-Browser": "brave",
  "microsoft-edge": "microsoft-edge",
  vivaldi: "vivaldi",
  opera: "opera",
};

export const FIREFOX_PROFILE_TARGET: BrowserProfileTarget = {
  family: "firefox",
  macPath: "Firefox/Profiles",
  linuxUserData: "firefox",
};

export const CHROME_PROFILE_TARGET: BrowserProfileTarget = {
  family: "chromium",
  macPath: "Google/Chrome",
  linuxUserData: "google-chrome",
};

export const CHROMIUM_PROFILE_TARGET: BrowserProfileTarget = {
  family: "chromium",
  macPath: "Chromium",
  linuxUserData: "chromium",
};

/** Flatpak's own launcher, tried in order. See `resolveBrowserExecutable`. */
export const FLATPAK_LAUNCHERS: readonly string[] = [
  "/usr/bin/flatpak",
  "/var/lib/flatpak/exports/bin/flatpak",
];

function linuxLeaves(target: BrowserProfileTarget): string[] {
  const raw = target.linuxUserData;
  if (!raw) return [];
  const list = typeof raw === "string" ? [raw] : [...raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const leaf of list) {
    if (typeof leaf !== "string" || leaf.length === 0 || seen.has(leaf)) continue;
    seen.add(leaf);
    out.push(leaf);
  }
  return out;
}

function segments(leaf: string): string[] {
  return leaf.split("/").filter((s) => s.length > 0);
}

function firefoxLinuxRoots(home: string, target: BrowserProfileTarget): string[] {
  // Native first — an existing ~/.mozilla/firefox always wins.
  const roots = [join(home, ".mozilla", "firefox")];
  const appId = target.flatpakAppId ?? LINUX_FLATPAK_APP_IDS.firefox;
  if (appId) {
    // BOTH Flatpak layouts exist in the wild and neither is a typo: older
    // builds keep `.mozilla` inside the per-app home, newer ones follow
    // XDG_CONFIG_HOME=~/.var/app/<id>/config.
    roots.push(join(home, ".var", "app", appId, ".mozilla", "firefox"));
    roots.push(join(home, ".var", "app", appId, "config", "mozilla", "firefox"));
  }
  const snapName = target.snapName ?? LINUX_SNAP_NAMES.firefox;
  if (snapName) roots.push(join(home, "snap", snapName, "common", ".mozilla", "firefox"));
  return roots;
}

function chromiumLinuxRoots(home: string, target: BrowserProfileTarget): string[] {
  const leaves = linuxLeaves(target);
  const roots: string[] = [];
  // Native first, canonical leaf before any compatibility alias.
  for (const leaf of leaves) roots.push(join(home, ".config", ...segments(leaf)));

  const canonical = leaves[0];
  if (!canonical) return roots;

  const appId = target.flatpakAppId ?? LINUX_FLATPAK_APP_IDS[canonical];
  if (appId) {
    // Inside the sandbox XDG_CONFIG_HOME is ~/.var/app/<id>/config, so the
    // browser writes the SAME relative leaf it writes under ~/.config
    // natively (Brave really is .../config/BraveSoftware/Brave-Browser).
    // Some builds land on a literal `.config` instead; both are cheap to try.
    roots.push(join(home, ".var", "app", appId, "config", ...segments(canonical)));
    roots.push(join(home, ".var", "app", appId, ".config", ...segments(canonical)));
  }

  const snapName = target.snapName ?? LINUX_SNAP_NAMES[canonical];
  if (snapName) {
    roots.push(join(home, "snap", snapName, "common", ...segments(canonical)));
    roots.push(join(home, "snap", snapName, "common", ".config", ...segments(canonical)));
  }
  return roots;
}

function darwinRoots(home: string, target: BrowserProfileTarget): string[] {
  const macPath = target.macPath ?? (target.family === "firefox" ? "Firefox/Profiles" : undefined);
  if (!macPath) return [];
  return [join(home, "Library", "Application Support", ...segments(macPath))];
}

function win32Roots(
  home: string,
  target: BrowserProfileTarget,
  env: Record<string, string | undefined>,
): string[] {
  if (target.family === "firefox") {
    const appData = env.APPDATA;
    if (!appData) return [];
    return [join(appData, "Mozilla", "Firefox", "Profiles")];
  }
  const leaf = target.winPath ?? target.macPath;
  if (!leaf) return [];
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [join(localAppData, ...segments(leaf), "User Data")];
}

/**
 * Every profile root this browser could plausibly use on this platform, in
 * priority order, NATIVE FIRST. Pure: no filesystem access, nothing is
 * filtered — callers decide whether they want the existing ones only.
 */
export function resolveBrowserProfileRoots(
  target: BrowserProfileTarget,
  opts?: ResolveProfileRootsOptions,
): string[] {
  const plat = opts?.platform ?? osPlatform();
  const home = opts?.home ?? homedir();
  const env = opts?.env ?? process.env;

  const raw =
    plat === "darwin"
      ? darwinRoots(home, target)
      : plat === "win32"
        ? win32Roots(home, target, env)
        : target.family === "firefox"
          ? firefoxLinuxRoots(home, target)
          : chromiumLinuxRoots(home, target);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of raw) {
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/**
 * The candidate roots that actually exist, native first. An inventory walker
 * wants ALL of them: a machine can run a native Firefox and a Flatpak one, and
 * the logged-in session may live in either.
 */
export function existingBrowserProfileRoots(
  target: BrowserProfileTarget,
  opts?: ResolveProfileRootsOptions,
): string[] {
  const exists = opts?.exists ?? existsSync;
  const discovered = resolveBrowserProfileRoots(target, opts).filter((root) => exists(root));
  // Prepend user-configured paths from ~/.unbrowse/browser-paths.json so memory
  // wins over auto-discovery when both exist.
  const family = target.family === "firefox" ? "firefox" : "chromium";
  // Explicit discovery overrides make this a hermetic probe (tests, sandboxed
  // callers, alternate HOME scans). Do not mix paths remembered under the
  // process's real ~/.unbrowse into that synthetic filesystem.
  const hasDiscoveryOverride = opts?.home !== undefined
    || opts?.platform !== undefined
    || opts?.env !== undefined
    || opts?.exists !== undefined;
  const configured = hasDiscoveryOverride
    ? []
    : configuredRootsForFamily(family).filter((root) => exists(root));
  if (configured.length === 0) return discovered;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of [...configured, ...discovered]) {
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

/**
 * The single root to use, native first. Falls back to the native candidate
 * when nothing exists so error messages still name the conventional location
 * rather than a Flatpak path the user has never heard of.
 */
export function resolveBrowserProfileRoot(
  target: BrowserProfileTarget,
  opts?: ResolveProfileRootsOptions,
): string | null {
  const candidates = resolveBrowserProfileRoots(target, opts);
  const exists = opts?.exists ?? existsSync;
  return candidates.find((root) => exists(root)) ?? candidates[0] ?? null;
}

function defaultReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // Unreadable root (permissions, a stale Flatpak dir) is a miss, not a throw:
    // the next candidate root still deserves a look.
    return [];
  }
}

function defaultMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Every profile — under every existing root — that ACTUALLY CONTAINS one of
 * `artifacts`, most-recently-written first.
 *
 * Why this exists: root discovery was unified above, but picking a profile
 * *inside* a root stayed hand-rolled in four places, each keyed on a NAME —
 * `default-release` for Firefox, `Default` / `Profile 1` for Chromium. Real
 * profile directories are user-chosen (`ij8zicoh.stream`) and a signed-in
 * Chromium user can be on `Profile 3`, so a name match silently reads a
 * different, logged-out jar and the caller reports "no session" on a machine
 * that is logged in. That is not a missing name in a list — enumerating names
 * can never be finished — so a profile is a candidate here because it HOLDS
 * the file. Recency then orders them: the profile being used is the one whose
 * jar was written last.
 *
 * `artifacts` are root-relative and may contain separators
 * ("Network/Cookies"); each is probed at the root itself (some layouts hand us
 * a profile dir as the root) and one level down. Callers that need a
 * *semantic* winner rather than a recent one rank the candidates themselves —
 * cookie extraction scores jars by auth-shape via `sessionQuality`.
 */
export function listBrowserProfileArtifacts(
  target: BrowserProfileTarget,
  artifacts: string | readonly string[],
  opts?: ListProfileArtifactsOptions,
): BrowserProfileArtifact[] {
  const found = existingBrowserProfileRoots(target, opts).flatMap((root) =>
    listProfileArtifactsInRoot(root, artifacts, opts),
  );
  return sortArtifacts(found);
}

/**
 * The same discovery for ONE already-resolved root. Callers that were handed a
 * user-data directory (a browser sweep, the history reader) use this so root
 * discovery and profile discovery stay one implementation each, never two.
 */
export function listProfileArtifactsInRoot(
  root: string,
  artifacts: string | readonly string[],
  opts?: ListProfileArtifactsOptions,
): BrowserProfileArtifact[] {
  const exists = opts?.exists ?? existsSync;
  const readdir = opts?.readdir ?? defaultReaddir;
  const mtimeMs = opts?.mtimeMs ?? defaultMtimeMs;
  const names = (typeof artifacts === "string" ? [artifacts] : [...artifacts]).filter(
    (n) => typeof n === "string" && n.length > 0,
  );
  if (names.length === 0) return [];

  const out: BrowserProfileArtifact[] = [];
  const seen = new Set<string>();
  const consider = (profile: string): void => {
    for (const name of names) {
      const path = profile
        ? join(root, profile, ...segments(name))
        : join(root, ...segments(name));
      if (seen.has(path) || !exists(path)) continue;
      seen.add(path);
      out.push({ root, profile, path, mtimeMs: mtimeMs(path) });
    }
  };

  // The root itself first — some layouts hand us a profile dir as the root.
  consider("");
  for (const dir of readdir(root)) consider(dir);
  return sortArtifacts(out);
}

/** Most-recently-written first; path breaks ties so the order is stable. */
function sortArtifacts(artifacts: BrowserProfileArtifact[]): BrowserProfileArtifact[] {
  return [...artifacts].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

/**
 * The single best profile-scoped artifact path, or null. Convenience over
 * `listBrowserProfileArtifacts` for callers that read one file (history DB,
 * preferences) and have no semantic ranking of their own.
 */
export function findBrowserProfileArtifact(
  target: BrowserProfileTarget,
  artifacts: string | readonly string[],
  opts?: ListProfileArtifactsOptions,
): string | null {
  return listBrowserProfileArtifacts(target, artifacts, opts)[0]?.path ?? null;
}

/** Is this profile path inside a Flatpak per-app home? */
export function isFlatpakProfilePath(path: string): boolean {
  return path.includes("/.var/app/");
}

/** Is this profile path inside a Flatpak or Snap per-app home? */
export function isSandboxedProfilePath(path: string): boolean {
  return isFlatpakProfilePath(path) || path.includes("/snap/");
}

export interface ResolveExecutableOptions extends ResolveProfileRootsOptions {
  /** Flatpak launcher candidates, in order. Defaults to `FLATPAK_LAUNCHERS`. */
  readonly launchers?: readonly string[];
}

/**
 * Pick the executable for a browser whose profile lives at `userDataDir`.
 *
 * A Flatpak install has no `/usr/bin/chromium` — the launcher is
 * `flatpak run <app-id>`. Install detection that insists on a native binary
 * reports the browser as not installed even after the userDataDir is resolved
 * correctly, which is the second, independent half of the Flatpak bug: the
 * profile is found and then thrown away.
 *
 * Native binaries still win; the launcher is only accepted for a profile that
 * is demonstrably inside a Flatpak per-app home.
 */
export function resolveBrowserExecutable(
  candidates: readonly string[],
  userDataDir: string | null | undefined,
  opts?: ResolveExecutableOptions,
): string | null {
  const exists = opts?.exists ?? existsSync;
  const native = candidates.find((candidate) => exists(candidate));
  if (native) return native;

  const plat = opts?.platform ?? osPlatform();
  if (plat !== "linux") return null;
  if (!userDataDir || !isFlatpakProfilePath(userDataDir) || !exists(userDataDir)) return null;

  return (opts?.launchers ?? FLATPAK_LAUNCHERS).find((launcher) => exists(launcher)) ?? null;
}

/** Firefox + every Chromium-family browser we know a Flatpak app id for. */
const SANDBOX_AWARE_TARGETS: BrowserProfileTarget[] = Object.keys(LINUX_FLATPAK_APP_IDS).map(
  (leaf): BrowserProfileTarget =>
    leaf === "firefox" ? FIREFOX_PROFILE_TARGET : { family: "chromium", linuxUserData: leaf },
);

/**
 * Does this machine hold at least one Flatpak/Snap browser profile?
 *
 * Consumers use this to know when a native-only probe is BLIND rather than
 * authoritative: `scripts/check_cookie_freshness.py` globs `~/.mozilla/firefox`
 * and `~/.config/<browser>` only, so on a Flatpak-only machine its "no cookie
 * for this host" is absence of evidence, not evidence of absence.
 */
export function hasSandboxedBrowserProfileRoots(opts?: ResolveProfileRootsOptions): boolean {
  const plat = opts?.platform ?? osPlatform();
  if (plat !== "linux") return false;
  const exists = opts?.exists ?? existsSync;
  for (const target of SANDBOX_AWARE_TARGETS) {
    for (const root of resolveBrowserProfileRoots(target, opts)) {
      if (isSandboxedProfilePath(root) && exists(root)) return true;
    }
  }
  return false;
}
