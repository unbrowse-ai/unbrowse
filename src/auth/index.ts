import * as kuri from "../kuri/client.js";
import { storeCredential, getCredential, deleteCredential } from "../vault/index.js";
import { nanoid } from "nanoid";
import { isDomainMatch, getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";
import path from "node:path";
import os from "node:os";
import {
  findChromiumBrowserCandidate,
  getSupportedChromiumBrowserCandidates,
  getMacDefaultBrowserBundleId,
} from "./browser-cookies.js";
import type {
  BrowserAuthSourceMeta,
  BrowserSource,
  ExtractBrowserCookiesOptions,
} from "./browser-cookies.js";

const LOGIN_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;
const MIN_WAIT_MS = 15_000;
const FIREFOX_BUNDLE_ID = "org.mozilla.firefox";
const SUPPORTED_INTERACTIVE_BROWSERS = ["auto", "chrome", "arc", "dia", "brave", "edge", "vivaldi", "chromium", "firefox"] as const;

type InteractiveBrowser = typeof SUPPORTED_INTERACTIVE_BROWSERS[number];

const MAC_BROWSER_NAME_BY_BUNDLE_ID: Record<string, string> = {
  "com.apple.Safari": "Safari",
  "org.mozilla.firefox": "Firefox",
  "com.google.chrome": "Chrome",
  "company.thebrowser.Browser": "Arc",
  "company.thebrowser.dia": "Dia",
  "com.brave.Browser": "Brave",
  "com.microsoft.edgemac": "Edge",
  "com.vivaldi.Vivaldi": "Vivaldi",
  "org.chromium.Chromium": "Chromium",
};

const LINUX_BROWSER_COMMANDS: Partial<Record<Exclude<InteractiveBrowser, "auto">, string>> = {
  firefox: "firefox",
  chrome: "google-chrome",
  arc: "arc",
  dia: "dia",
  brave: "brave-browser",
  edge: "microsoft-edge",
  vivaldi: "vivaldi",
  chromium: "chromium",
};

export interface InteractiveLoginPlan {
  browser: InteractiveBrowser;
  browserLabel: string;
  openCommand: string;
  openArgs: string[];
  extractOptions: ExtractBrowserCookiesOptions;
}

const DARWIN_APPLESCRIPT_NAMES: Partial<Record<Exclude<InteractiveBrowser, "auto" | "firefox">, string>> = {
  chrome: "Google Chrome",
  arc: "Arc",
  dia: "Dia",
  brave: "Brave Browser",
  edge: "Microsoft Edge",
  vivaldi: "Vivaldi",
  chromium: "Chromium",
};

const DARWIN_BROWSER_BY_BUNDLE_ID: Partial<Record<string, Exclude<InteractiveBrowser, "auto">>> = {
  "org.mozilla.firefox": "firefox",
  "com.google.chrome": "chrome",
  "company.thebrowser.Browser": "arc",
  "company.thebrowser.dia": "dia",
  "com.brave.Browser": "brave",
  "com.microsoft.edgemac": "edge",
  "com.vivaldi.Vivaldi": "vivaldi",
  "org.chromium.Chromium": "chromium",
};

function buildDarwinChromiumOpenPlan(
  browser: Exclude<InteractiveBrowser, "auto" | "firefox">,
  url: string,
  candidate: NonNullable<ReturnType<typeof findChromiumBrowserCandidate>>,
): InteractiveLoginPlan {
  const appName = DARWIN_APPLESCRIPT_NAMES[browser] ?? candidate.name;
  const script = [
    `tell application "${appName}"`,
    "activate",
    "if (count of windows) = 0 then",
    "make new window",
    "end if",
    `set URL of active tab of front window to "${url.replaceAll("\"", "\\\"")}"`,
    "end tell",
  ].join("\n");
  return {
    browser,
    browserLabel: candidate.name,
    openCommand: "osascript",
    openArgs: ["-e", script],
    extractOptions: {
      browser: "chromium",
      chromium: {
        userDataDir: candidate.userDataDir,
        browserName: candidate.name,
        safeStorageService: candidate.safeStorageService,
      },
    },
  };
}

/**
 * Returns the persistent profile directory for a given domain.
 * Stored under ~/.unbrowse/profiles/<registrableDomain>.
 */
export function getProfilePath(domain: string): string {
  return path.join(os.homedir(), ".unbrowse", "profiles", getRegistrableDomain(domain));
}

export interface LoginResult {
  success: boolean;
  domain: string;
  cookies_stored: number;
  browser_label?: string;
  error?: string;
}

export interface StoredAuthBundle {
  cookies: AuthCookie[];
  headers: Record<string, string>;
  source_keys: string[];
  source_meta?: BrowserAuthSourceMeta | null;
}

export function storedAuthNeedsBrowserRefresh(bundle: StoredAuthBundle | null | undefined): boolean {
  if (!bundle) return true;
  if (bundle.cookies.length === 0 && Object.keys(bundle.headers).length === 0) return true;
  const sourceMeta = bundle.source_meta;
  if (!sourceMeta) return true;
  if (sourceMeta.family === "chromium" && !sourceMeta.userDataDir && !sourceMeta.cookieDbPath) {
    return true;
  }
  return false;
}

function normalizeInteractiveBrowser(browser?: string): InteractiveBrowser {
  const normalized = (browser ?? "auto").trim().toLowerCase();
  if ((SUPPORTED_INTERACTIVE_BROWSERS as readonly string[]).includes(normalized)) {
    return normalized as InteractiveBrowser;
  }
  throw new Error(`Unsupported browser "${browser}". Use one of: ${SUPPORTED_INTERACTIVE_BROWSERS.join(", ")}`);
}

export function resolveInteractiveLoginPlan(
  url: string,
  browser?: string,
  opts?: { platform?: NodeJS.Platform; defaultBundleId?: string | null },
): InteractiveLoginPlan {
  const requested = normalizeInteractiveBrowser(browser);
  const runtimePlatform = opts?.platform ?? process.platform;

  if (requested === "auto") {
    if (runtimePlatform === "darwin") {
      const defaultBundleId = opts?.defaultBundleId ?? getMacDefaultBrowserBundleId();
      const supportedChromiumBundles = new Set(
        getSupportedChromiumBrowserCandidates("darwin")
          .map((candidate) => candidate.bundleId)
          .filter((value): value is string => !!value),
      );
      const defaultBrowser = defaultBundleId ? DARWIN_BROWSER_BY_BUNDLE_ID[defaultBundleId] : undefined;
      if (defaultBrowser === "firefox") {
        return resolveInteractiveLoginPlan(url, "firefox", { platform: runtimePlatform, defaultBundleId });
      }
      if (defaultBrowser && defaultBrowser !== "firefox") {
        return resolveInteractiveLoginPlan(url, defaultBrowser, { platform: runtimePlatform, defaultBundleId });
      }
      if (defaultBundleId && defaultBundleId !== FIREFOX_BUNDLE_ID && !supportedChromiumBundles.has(defaultBundleId)) {
        const label = MAC_BROWSER_NAME_BY_BUNDLE_ID[defaultBundleId] ?? defaultBundleId;
        throw new Error(`Default browser ${label} is not supported for cookie extraction. Re-run with --browser chrome, arc, dia, brave, edge, vivaldi, chromium, or firefox.`);
      }
    }

    if (runtimePlatform === "darwin") {
      return {
        browser: requested,
        browserLabel: "default browser",
        openCommand: "open",
        openArgs: [url],
        extractOptions: { browser: "auto" },
      };
    }
    if (runtimePlatform === "linux") {
      return {
        browser: requested,
        browserLabel: "default browser",
        openCommand: "xdg-open",
        openArgs: [url],
        extractOptions: { browser: "auto" },
      };
    }
    return {
      browser: requested,
      browserLabel: "default browser",
      openCommand: "cmd",
      openArgs: ["/c", "start", "", url],
      extractOptions: { browser: "auto" },
    };
  }

  if (requested === "firefox") {
    if (runtimePlatform === "darwin") {
      return {
        browser: requested,
        browserLabel: "Firefox",
        openCommand: "open",
        openArgs: ["-b", FIREFOX_BUNDLE_ID, url],
        extractOptions: { browser: "firefox" },
      };
    }
    const command = runtimePlatform === "linux" ? LINUX_BROWSER_COMMANDS.firefox ?? "firefox" : "cmd";
    return {
      browser: requested,
      browserLabel: "Firefox",
      openCommand: command,
      openArgs: runtimePlatform === "linux" ? [url] : ["/c", "start", "", "firefox", url],
      extractOptions: { browser: "firefox" },
    };
  }

  const candidate = findChromiumBrowserCandidate(requested, runtimePlatform);
  if (!candidate) {
    throw new Error(`Browser "${requested}" is not available on ${runtimePlatform}.`);
  }

  if (runtimePlatform === "darwin") {
    return buildDarwinChromiumOpenPlan(requested, url, candidate);
  }

  const command = LINUX_BROWSER_COMMANDS[requested];
  if (runtimePlatform === "linux" && command) {
    return {
      browser: requested,
      browserLabel: candidate.name,
      openCommand: command,
      openArgs: [url],
      extractOptions: {
        browser: "chromium",
        chromium: {
          userDataDir: candidate.userDataDir,
          browserName: candidate.name,
          safeStorageService: candidate.safeStorageService,
        },
      },
    };
  }

  throw new Error(`Explicit browser selection is not supported on ${runtimePlatform}.`);
}

async function launchInteractiveBrowser(plan: InteractiveLoginPlan): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.openCommand, plan.openArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Open a visible browser for the user to complete login, then poll the chosen
 * local browser profile until fresh cookies are detected.
 */
export async function interactiveLogin(
  url: string,
  domain?: string,
  opts?: { browser?: string },
): Promise<LoginResult> {
  const targetDomain = domain ?? new URL(url).hostname;
  const plan = resolveInteractiveLoginPlan(url, opts?.browser);

  log("auth", `interactiveLogin — url: ${url}, domain: ${targetDomain}, browser: ${plan.browserLabel}`);
  await launchInteractiveBrowser(plan);
  log("auth", `opened ${url} in ${plan.browserLabel}`);

  // Poll extractBrowserAuth until cookies appear or timeout
  const startTime = Date.now();
  while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const result = await extractBrowserAuth(targetDomain, plan.extractOptions);
      if (result.success && result.cookies_stored > 0) {
        log("auth", `login detected — ${result.cookies_stored} cookies captured for ${targetDomain}`);
        return { ...result, browser_label: plan.browserLabel };
      }
    } catch (err) {
      log("auth", `poll error: ${err instanceof Error ? err.message : err}`);
    }

    // Log progress every 10s
    const elapsed = Date.now() - startTime;
    if (elapsed % 10_000 < POLL_INTERVAL_MS) {
      log("auth", `waiting for login... ${Math.round(elapsed / 1000)}s elapsed`);
    }
  }

  return {
    success: false,
    domain: targetDomain,
    cookies_stored: 0,
    browser_label: plan.browserLabel,
    error: `Login timed out after ${LOGIN_TIMEOUT_MS / 1000}s — no cookies detected in ${plan.browserLabel}`,
  };
}

/**
 * Extract cookies directly from Chrome/Firefox SQLite databases.
 * No browser launch needed, Chrome can stay open.
 */
export async function extractBrowserAuth(
  domain: string,
  opts?: ExtractBrowserCookiesOptions
): Promise<LoginResult> {
  const { extractBrowserCookies } = await import("./browser-cookies.js");

  const result = extractBrowserCookies(domain, opts);

  if (result.cookies.length === 0) {
    return {
      success: false,
      domain,
      cookies_stored: 0,
      error: result.warnings.join("; ") || "No cookies found in any browser",
    };
  }

  const storableCookies = result.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expires: c.expires,
  }));

  const vaultKey = `auth:${getRegistrableDomain(domain)}`;
  await storeCredential(
    vaultKey,
    JSON.stringify({ cookies: storableCookies, source_meta: result.sourceMeta ?? null })
  );

  log("auth", `stored ${storableCookies.length} cookies for ${domain} (key: ${vaultKey}) from ${result.source}`);
  return { success: true, domain, cookies_stored: storableCookies.length };
}

type AuthCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
};

function getStoredAuthKeys(domain: string): string[] {
  const regDomain = getRegistrableDomain(domain);
  const keys = [`${regDomain}-session`];
  if (domain !== regDomain) keys.push(`${domain}-session`);
  keys.push(`auth:${regDomain}`);
  if (domain !== regDomain) keys.push(`auth:${domain}`);
  return keys;
}

/** Filter out expired cookies. Session cookies (expires <= 0) are kept. */
function filterExpired(cookies: AuthCookie[]): AuthCookie[] {
  const now = Math.floor(Date.now() / 1000);
  return cookies.filter((c) => {
    if (c.expires == null || c.expires <= 0) return true;
    return c.expires > now;
  });
}

function mergeCookies(target: AuthCookie[], incoming: AuthCookie[]): void {
  const seen = new Set(
    target.map((cookie) => `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path ?? "/"}`),
  );
  for (const cookie of incoming) {
    const key = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path ?? "/"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(cookie);
  }
}

export async function getStoredAuthBundle(
  domain: string
): Promise<StoredAuthBundle | null> {
  const cookies: AuthCookie[] = [];
  const headers: Record<string, string> = {};
  const source_keys: string[] = [];
  let source_meta: BrowserAuthSourceMeta | null = null;

  for (const key of getStoredAuthKeys(domain)) {
    const stored = await getCredential(key);
    if (!stored) continue;
    try {
      const parsed = JSON.parse(stored) as {
        cookies?: AuthCookie[];
        headers?: Record<string, string>;
        source_meta?: BrowserAuthSourceMeta | null;
      };
      const rawCookies = parsed.cookies ?? [];
      const validCookies = filterExpired(rawCookies);
      const parsedHeaders = parsed.headers ?? {};
      if (rawCookies.length > 0 && validCookies.length === 0 && Object.keys(parsedHeaders).length === 0) {
        log("auth", `all ${rawCookies.length} cookies for ${domain} (key: ${key}) are expired — deleting`);
        await deleteCredential(key);
        continue;
      }
      if (validCookies.length < rawCookies.length) {
        log("auth", `filtered ${rawCookies.length - validCookies.length} expired cookies for ${domain}`);
      }
      mergeCookies(cookies, validCookies);
      for (const [header, value] of Object.entries(parsedHeaders)) {
        if (headers[header] == null) headers[header] = value;
      }
      if ((validCookies.length > 0 || Object.keys(parsedHeaders).length > 0) && !source_keys.includes(key)) {
        source_keys.push(key);
        if (!source_meta && parsed.source_meta) source_meta = parsed.source_meta;
      }
    } catch {
      continue;
    }
  }

  if (cookies.length === 0 && Object.keys(headers).length === 0) return null;
  return { cookies, headers, source_keys, source_meta };
}

export async function findStoredAuthReference(domain: string): Promise<string | null> {
  const bundle = await getStoredAuthBundle(domain);
  return bundle?.source_keys[0] ?? null;
}

/**
 * Retrieve stored auth cookies for a domain from the vault.
 * Filters out expired cookies automatically.
 */
export async function getStoredAuth(
  domain: string
): Promise<AuthCookie[] | null> {
  return (await getStoredAuthBundle(domain))?.cookies ?? null;
}

/**
 * Bird-style unified cookie resolution with auto-extract fallback.
 *
 * Fallback chain:
 *   1. Vault cookies (fast path)
 *   2. Auto-extract from Chrome/Firefox SQLite (bird pattern — always fresh)
 */
export async function getAuthCookies(
  domain: string,
  opts?: { autoExtract?: boolean }
): Promise<AuthCookie[] | null> {
  const bundle = await getStoredAuthBundle(domain);
  if (bundle && bundle.cookies.length > 0 && !storedAuthNeedsBrowserRefresh(bundle)) {
    return bundle.cookies;
  }

  if (opts?.autoExtract === false) return bundle?.cookies ?? null;

  log("auth", `${bundle ? "stored auth lacks usable browser source metadata" : "no vault cookies"} for ${domain} — auto-extracting from browser`);
  try {
    const result = await extractBrowserAuth(domain);
    if (result.success && result.cookies_stored > 0) {
      return getStoredAuth(domain);
    }
  } catch (err) {
    log("auth", `browser auto-extract failed for ${domain}: ${err instanceof Error ? err.message : err}`);
  }

  return bundle?.cookies ?? null;
}

/**
 * Refresh credentials from browser after a 401/403.
 * Returns true if fresh cookies were stored.
 */
export async function refreshAuthFromBrowser(domain: string): Promise<boolean> {
  log("auth", `401/403 received — attempting to refresh auth for ${domain} from browser`);
  try {
    const result = await extractBrowserAuth(domain);
    if (result.success && result.cookies_stored > 0) {
      log("auth", `refreshed ${result.cookies_stored} cookies for ${domain} from browser`);
      return true;
    }
  } catch (err) {
    log("auth", `browser refresh failed for ${domain}: ${err instanceof Error ? err.message : err}`);
  }
  return false;
}
