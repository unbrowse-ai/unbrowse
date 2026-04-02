/**
 * Kuri HTTP client — thin wrapper over Kuri's browser automation API.
 *
 * Kuri is a Zig-native CDP broker (464KB binary, 3ms cold start).
 * This client replaces agent-browser (Playwright, 80-150MB, 1-3s cold start).
 *
 * Lifecycle: start() launches kuri + Chrome, stop() tears them down.
 * All browser ops go through HTTP — no Playwright, no Node CDP bindings.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { getPackageRoot } from "../runtime/paths.js";

const KURI_DEFAULT_PORT = 7700;
const KURI_STARTUP_TIMEOUT_MS = 10_000;
const KURI_REQUEST_TIMEOUT_MS = 30_000;
const KURI_SPAWN_RETRIES = 3;
const KURI_SPAWN_RETRY_DELAY_MS = 1_000;

export interface KuriTab {
  id: string;
  url: string;
  title?: string;
}

export interface KuriCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}


/** Action types supported by Kuri's /action endpoint. */
export type KuriActionType =
  | "click" | "dblclick" | "fill" | "type" | "select"
  | "check" | "uncheck" | "hover" | "focus" | "blur"
  | "scroll" | "press";

export interface KuriWaitResult {
  status: "found" | "ready" | "timeout";
  selector?: string;
  readyState?: string;
  polls?: number;
  timeout_ms?: number;
}

export interface KuriDomQueryResult {
  nodeId?: number;
  nodeIds?: number[];
}
export interface KuriHarEntry {
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    postData?: { text: string };
  };
  response: {
    status: number;
    headers: Array<{ name: string; value: string }>;
    content?: { text?: string; mimeType?: string };
  };
  startedDateTime: string;
}

let kuriProcess: ChildProcess | null = null;
let kuriPort = KURI_DEFAULT_PORT;
let kuriCdpPort: number | null = null;
let kuriReady = false;

function kuriBinaryName(): string {
  return process.platform === "win32" ? "kuri.exe" : "kuri";
}

function currentBundledKuriTarget(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  return null;
}

function resolveBinaryOnPath(name: string): string | null {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    const output = execFileSync(checker, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return match || null;
  } catch {
    return null;
  }
}

function addCandidate(candidates: string[], candidate?: string | null): void {
  if (!candidate) return;
  if (!candidates.includes(candidate)) candidates.push(candidate);
}

export function getKuriSourceCandidates(): string[] {
  const packageRoot = getPackageRoot(import.meta.url);
  const candidates: string[] = [];
  addCandidate(candidates, path.join(packageRoot, "vendor", "kuri-src"));
  addCandidate(candidates, path.join(packageRoot, "submodules", "kuri"));
  if (process.env.KURI_PATH) addCandidate(candidates, process.env.KURI_PATH);
  if (process.env.HOME) addCandidate(candidates, path.join(process.env.HOME, "kuri"));
  return candidates;
}

export function getKuriBinaryCandidates(): string[] {
  const packageRoot = getPackageRoot(import.meta.url);
  const binaryName = kuriBinaryName();
  const target = currentBundledKuriTarget();
  const candidates: string[] = [];

  if (target) addCandidate(candidates, path.join(packageRoot, "vendor", "kuri", target, binaryName));
  if (target) addCandidate(candidates, path.join(packageRoot, "packages", "skill", "vendor", "kuri", target, binaryName));
  for (const sourceDir of getKuriSourceCandidates()) {
    addCandidate(candidates, path.join(sourceDir, "zig-out", "bin", binaryName));
  }
  addCandidate(candidates, resolveBinaryOnPath("kuri"));
  return candidates;
}

/** Try common CDP ports to find where Chrome is listening. */
async function discoverCdpPort(): Promise<void> {
  const portsToTry = [9222, 9223, 9224, 9225];
  for (const port of portsToTry) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        kuriCdpPort = port;
        log("kuri", `found Chrome CDP on port ${port}`);
        return;
      }
    } catch {
      // Not on this port
    }
  }
  log("kuri", "could not discover CDP port — tab discovery may fail");
}

/** Find a free port for CDP starting from 9222. */
async function findFreeCdpPort(): Promise<number> {
  for (let port = 9222; port < 9230; port++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(300),
      });
      // Port is in use, try next
    } catch {
      return port; // Not in use
    }
  }
  return 9222; // Fallback
}

/** Launch the user's real Chrome with CDP debugging if no Chrome is running.
 *  This gives Kuri access to all the user's existing cookies/sessions. */
async function ensureUserChromeRunning(): Promise<void> {
  // Check if Chrome already has CDP
  for (const port of [9222, 9223, 9224, 9225]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return; // Already running
    } catch { /* not on this port */ }
  }

  // No CDP-enabled Chrome found — launch the user's real Chrome with debugging
  const chromePaths: Record<string, string> = {
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    linux: "google-chrome",
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  };
  const chromeBin = chromePaths[process.platform];
  if (!chromeBin) return;

  const port = await findFreeCdpPort();
  log("kuri", `launching user Chrome with CDP on port ${port}`);

  try {
    const child = spawn(chromeBin, [
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
    ], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    // Wait for CDP to become available
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          log("kuri", `user Chrome ready with CDP on port ${port}`);
          return;
        }
      } catch { /* not ready */ }
      await new Promise(r => setTimeout(r, 300));
    }
    log("kuri", "user Chrome launched but CDP not responding — Kuri will launch managed Chrome");
  } catch (err) {
    log("kuri", `failed to launch user Chrome: ${err instanceof Error ? err.message : err}`);
  }
}

function kuriUrl(path: string, params?: Record<string, string>): string {
  const base = `http://127.0.0.1:${kuriPort}${path}`;
  if (!params || Object.keys(params).length === 0) return base;
  // Build query string manually — URLSearchParams encodes values which breaks
  // URL parameters (Kuri's getQueryParam doesn't decode percent-encoding).
  // We must still encode # and & in values to avoid breaking URL structure.
  const parts = Object.entries(params).map(([k, v]) => `${k}=${v.replace(/#/g, "%23").replace(/&/g, "%26")}`);
  return `${base}?${parts.join("&")}`;
}

async function kuriGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = kuriUrl(path, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KURI_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timeout);
  }
}

async function kuriPost(path: string, params: Record<string, string>, body: unknown): Promise<unknown> {
  const url = kuriUrl(path, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KURI_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timeout);
  }
}

/** Find the kuri binary — check env, then common build locations. */
export function findKuriBinary(): string {
  if (process.env.KURI_BIN) return process.env.KURI_BIN;
  const candidates = getKuriBinaryCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? kuriBinaryName();
}

async function waitForChildExit(child: ChildProcess | null | undefined, timeoutMs = 2_000): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}


/**
 * Start Kuri server + managed Chrome.
 * Idempotent — returns immediately if already running.
 */
export async function start(port?: number): Promise<void> {
  if (kuriReady) return;
  kuriPort = port ?? KURI_DEFAULT_PORT;

  // Check if kuri is already running on this port
  try {
    const health = await fetch(`http://127.0.0.1:${kuriPort}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (health.ok) {
      log("kuri", `already running on port ${kuriPort}`);
      kuriReady = true;
      await discoverCdpPort();
      await ensureTabsDiscovered();
      return;
    }
  } catch {
    // Not running — we'll start it
  }

  const binary = findKuriBinary();
  log("kuri", `starting: ${binary} on port ${kuriPort}`);
  if (!existsSync(binary)) {
    throw new Error(`Kuri binary not found at ${binary}`);
  }

  // Discover existing Chrome CDP if available
  await discoverCdpPort();

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(kuriPort),
    HOST: "127.0.0.1",
  };
  if (kuriCdpPort) {
    env.CDP_URL = `ws://127.0.0.1:${kuriCdpPort}`;
    log("kuri", `connecting to existing Chrome on port ${kuriCdpPort}`);
  } else {
    log("kuri", "no existing Chrome found — Kuri will launch managed Chrome");
  }

  const maxAttempts = KURI_SPAWN_RETRIES + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      log("kuri", `spawn retry ${attempt}/${maxAttempts} after ${KURI_SPAWN_RETRY_DELAY_MS}ms`);
      await new Promise((r) => setTimeout(r, KURI_SPAWN_RETRY_DELAY_MS));
    }

    let exitedBeforeReady = false;
    kuriProcess = spawn(binary, [], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Parse CDP port from stderr output
    kuriProcess.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) log("kuri", `[stderr] ${line}`);
      const cdpMatch = line.match(/CDP port:\s*(\d+)/);
      if (cdpMatch) {
        kuriCdpPort = parseInt(cdpMatch[1], 10);
        log("kuri", `discovered CDP port: ${kuriCdpPort}`);
      }
    });

    kuriProcess.on("exit", (code) => {
      if (!kuriReady) exitedBeforeReady = true;
      log("kuri", `process exited with code ${code}`);
      kuriReady = false;
      kuriProcess = null;
    });

    // Wait for health endpoint; break early if process died
    const deadline = Date.now() + KURI_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exitedBeforeReady) break;
      try {
        const res = await fetch(`http://127.0.0.1:${kuriPort}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          kuriReady = true;
          log("kuri", `ready on port ${kuriPort}`);
          await new Promise((r) => setTimeout(r, 300));
          if (!kuriCdpPort) await discoverCdpPort();
          // Auto-discover tabs so they're registered for immediate use
          await ensureTabsDiscovered();
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (kuriReady) return;

    // Kill any lingering process before next attempt
    if (kuriProcess) {
      kuriProcess.kill();
      await waitForChildExit(kuriProcess);
    }
  }
  throw new Error(`Kuri failed to start after ${maxAttempts} attempts`);
}

/** Stop Kuri and managed Chrome. */
export async function stop(): Promise<void> {
  if (kuriProcess) {
    kuriProcess.kill("SIGTERM");
    kuriProcess = null;
  }
  kuriReady = false;
  kuriCdpPort = null;
}

/** List discovered Chrome tabs. */
export async function discoverTabs(): Promise<KuriTab[]> {
  // Trigger Kuri's /discover to sync Chrome tabs
  await ensureTabsDiscovered();

  // List registered tabs
  try {
    const tabs = (await kuriGet("/tabs")) as Array<{ id: string; url: string; title?: string }>;
    if (Array.isArray(tabs) && tabs.length > 0) return tabs;
  } catch { /* empty */ }

  return [];
}

/** Get or discover the first usable tab. */
export async function getDefaultTab(): Promise<string> {
  // Ensure Kuri's /discover works by triggering it (it registers tabs from Chrome)
  await ensureTabsDiscovered();

  // Now list Kuri's registered tabs
  try {
    const tabs = (await kuriGet("/tabs")) as Array<{ id: string; url: string }>;
    if (Array.isArray(tabs) && tabs.length > 0) return tabs[0].id;
  } catch { /* no tabs registered */ }

  // Create a new tab via Chrome CDP and re-discover
  if (kuriCdpPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${kuriCdpPort}/json/new?about:blank`, {
        method: "PUT",
        signal: AbortSignal.timeout(5000),
      });
      const target = (await res.json()) as { id: string };
      if (target?.id) {
        log("kuri", `created new Chrome tab: ${target.id}`);
        // Re-discover to register it with Kuri
        await new Promise((r) => setTimeout(r, 300));
        await ensureTabsDiscovered();
        return target.id;
      }
    } catch (err) {
      log("kuri", `Chrome tab creation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new Error("No tabs available and failed to create one");
}

/** Trigger Kuri's /discover to sync Chrome tabs into Kuri's registry. */
/** Trigger Kuri's /discover to sync Chrome tabs into Kuri's registry. */
async function ensureTabsDiscovered(): Promise<void> {
  try {
    // Pass CDP URL as query param so /discover works even if Kuri was started without CDP_URL env
    const params: Record<string, string> = {};
    if (kuriCdpPort) params.cdp_url = `ws://127.0.0.1:${kuriCdpPort}`;
    await kuriGet("/discover", params);
  } catch {
    // /discover may fail if no Chrome running — that's OK
  }
}

async function waitForTabRegistration(tabId: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await ensureTabsDiscovered();
    try {
      const tabs = (await kuriGet("/tabs")) as Array<{ id?: string }>;
      if (Array.isArray(tabs) && tabs.some((tab) => tab?.id === tabId)) return;
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Navigate tab to URL. */
export async function navigate(tabId: string, url: string): Promise<void> {
  await kuriGet("/navigate", { tab_id: tabId, url });
}

/** Evaluate JavaScript in tab context. */
/** Evaluate JavaScript in tab context. */
/** Evaluate JavaScript in tab context. */
/** Evaluate JavaScript in tab context. */
export async function evaluate(tabId: string, expression: string): Promise<unknown> {
  let raw: {
    id?: number;
    result?: { result?: { type?: string; value?: unknown; description?: string }; exceptionDetails?: unknown };
  };
  if (expression.length > 2000) {
    // Use POST with raw text body for large expressions to avoid URL length limits
    const url = kuriUrl("/evaluate", { tab_id: tabId });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KURI_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: expression,
        signal: controller.signal,
      });
      const text = await res.text();
      try { raw = JSON.parse(text); } catch { raw = text as never; }
    } finally {
      clearTimeout(timeout);
    }
  } else {
    raw = (await kuriGet("/evaluate", { tab_id: tabId, expression })) as typeof raw;
  }
  // CDP Runtime.evaluate response: { id, result: { result: { type, value } } }
  const inner = raw?.result?.result;
  if (!inner) return raw;
  if (inner.type === "undefined") return undefined;
  if ("value" in inner) return inner.value;
  return inner.description ?? raw;
}

/** Get all cookies for a tab. */
export async function getCookies(tabId: string): Promise<KuriCookie[]> {
  const raw = (await kuriGet("/cookies", { tab_id: tabId })) as {
    id?: number;
    result?: { cookies?: KuriCookie[] };
  };
  return raw?.result?.cookies ?? [];
}

/** Set a single cookie. */
export async function setCookie(tabId: string, cookie: KuriCookie): Promise<void> {
  await kuriGet("/cookies", {
    tab_id: tabId,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    ...(cookie.path ? { path: cookie.path } : {}),
  });
}

/** Set multiple cookies. */
export async function setCookies(tabId: string, cookies: KuriCookie[]): Promise<void> {
  for (const cookie of cookies) {
    await setCookie(tabId, cookie);
  }
}

/** Set extra HTTP headers for a tab. */
export async function setHeaders(tabId: string, headers: Record<string, string>): Promise<void> {
  await kuriPost("/headers", { tab_id: tabId }, headers);
}

/** Start HAR recording for a tab. */
export async function harStart(tabId: string): Promise<void> {
  await kuriGet("/har/start", { tab_id: tabId });
}

/** Stop HAR recording and return entries. */
export async function harStop(tabId: string): Promise<{ entries: KuriHarEntry[]; raw: unknown }> {
  const result = (await kuriGet("/har/stop", { tab_id: tabId })) as {
    entries?: number;
    har?: { log?: { entries?: KuriHarEntry[] } };
  };
  return {
    entries: result?.har?.log?.entries ?? [],
    raw: result,
  };
}

/** Enable Network domain (needed for cookies/interception). */
export async function networkEnable(tabId: string): Promise<void> {
  await kuriGet("/network", { tab_id: tabId, mode: "enable" });
}

/** Start Fetch interception. */
export async function interceptStart(tabId: string): Promise<void> {
  await kuriGet("/intercept/start", { tab_id: tabId });
}

/** Get page text content. */
export async function getText(tabId: string): Promise<string> {
  const result = (await kuriGet("/text", { tab_id: tabId })) as { text?: string };
  return result?.text ?? "";
}

/** Get page as markdown. */
export async function getMarkdown(tabId: string): Promise<string> {
  const result = (await kuriGet("/markdown", { tab_id: tabId })) as { markdown?: string };
  return result?.markdown ?? "";
}

/** Take screenshot (returns base64 PNG). */
export async function screenshot(tabId: string): Promise<string> {
  const result = (await kuriGet("/screenshot", { tab_id: tabId })) as { data?: string; screenshot?: string };
  return result?.data ?? result?.screenshot ?? "";
}

/** Get accessibility tree snapshot. */
export async function snapshot(tabId: string, filter?: string): Promise<string> {
  const params: Record<string, string> = { tab_id: tabId };
  if (filter) params.filter = filter;
  params.format = "text";
  const result = await kuriGet("/snapshot", params);
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "snapshot" in result && typeof (result as { snapshot?: unknown }).snapshot === "string") {
    return (result as { snapshot: string }).snapshot;
  }
  return "";
}

/** Close a tab. */
export async function closeTab(tabId: string): Promise<void> {
  await kuriGet("/close", { tab_id: tabId });
}

/** Create a new tab. */
export async function newTab(url?: string): Promise<string> {
  const params: Record<string, string> = {};
  if (url) params.url = url;
  const result = (await kuriGet("/tab/new", params)) as { tab_id?: string };
  const tabId = result?.tab_id ?? "";
  if (tabId) {
    await waitForTabRegistration(tabId).catch(() => {});
  }
  return tabId;
}

/** Get current page URL via evaluate. */
export async function getCurrentUrl(tabId: string): Promise<string> {
  const result = await evaluate(tabId, "window.location.href");
  return String(result ?? "");
}

/** Get page HTML content via evaluate. */
export async function getPageHtml(tabId: string): Promise<string> {
  const result = await evaluate(tabId, "document.documentElement.outerHTML");
  return String(result ?? "");
}

/** Check if page has Cloudflare challenge. */
export async function hasCloudflareChallenge(tabId: string): Promise<boolean> {
  const result = await evaluate(tabId, `(function() {
    var html = document.documentElement.innerHTML;
    return html.indexOf('challenge-platform') !== -1 ||
           html.indexOf('cf_chl_opt') !== -1 ||
           html.indexOf('cf-error-details') !== -1 ||
           html.indexOf('cf.errors.css') !== -1 ||
           document.title === 'Just a moment...' ||
           /Attention Required.*Cloudflare/.test(document.title) ||
           !!document.querySelector('#challenge-running, #challenge-form, .cf-browser-verification');
  })()`);
  return result === true;
}

/** Wait for Cloudflare challenge to clear. */
export async function waitForCloudflare(tabId: string, maxWaitMs = 15000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const blocked = await hasCloudflareChallenge(tabId);
    if (!blocked) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Execute fetch() inside the browser page context.
 * Runs from the page's origin, inheriting cookies/CSRF.
 */
export async function executeInPageFetch(
  tabId: string,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const fetchScript = `(async function() {
    try {
      var res = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: ${JSON.stringify(headers)},
        ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ""}
      });
      var text = await res.text();
      var data;
      try { data = JSON.parse(text); } catch(e) { data = text; }
      return JSON.stringify({ status: res.status, data: data });
    } catch(e) {
      return JSON.stringify({ status: 0, data: { error: e.message } });
    }
  })()`;

  const result = await evaluate(tabId, fetchScript);
  try {
    return JSON.parse(String(result)) as { status: number; data: unknown };
  } catch {
    return { status: 0, data: result };
  }
}

/** Health check. */
export async function health(): Promise<{ ok: boolean; tabs?: number }> {
  try {
    const result = (await kuriGet("/health")) as { ok?: boolean; status?: string; tabs?: number };
    return { ok: result?.ok === true || result?.status === "ok", tabs: result?.tabs };
  } catch {
    return { ok: false };
  }
}

/** Get the currently configured port. */
export function getPort(): number {
  return kuriPort;
}

/** Check if kuri is ready. */
export function isReady(): boolean {
  return kuriReady;
}

// ---------------------------------------------------------------------------
// Action primitives (new in Kuri v0.3+)
// ---------------------------------------------------------------------------

/**
 * Perform a browser action on an element by ref (from /snapshot a11y tree).
 * Requires a prior /snapshot call to populate refs.
 */
export async function action(
  tabId: string,
  actionType: KuriActionType,
  ref: string,
  value?: string,
): Promise<unknown> {
  const params: Record<string, string> = { tab_id: tabId, action: actionType, ref };
  if (value !== undefined) params.value = value;
  return kuriGet("/action", params);
}

/** Click an element by ref (scrolls into view first). */
export async function click(tabId: string, ref: string): Promise<unknown> {
  await scrollIntoView(tabId, ref);
  return action(tabId, "click", ref);
}

/** Fill an input element by ref (focuses first). */
export async function fill(tabId: string, ref: string, value: string): Promise<unknown> {
  await click(tabId, ref);
  const result = await action(tabId, "fill", ref, value);
  const currentValue = await evaluate(tabId, `(() => {
    const active = document.activeElement;
    return active && "value" in active ? active.value : undefined;
  })()`);
  if (currentValue !== value) {
    return evaluate(tabId, `(function() {
      const active = document.activeElement;
      if (!active || !("value" in active)) return false;
      active.value = ${JSON.stringify(value)};
      active.dispatchEvent(new Event("input", { bubbles: true }));
      active.dispatchEvent(new Event("change", { bubbles: true }));
      return active.value;
    })()`);
  }
  return result;
}

/** Select a value in a dropdown by ref. */
export async function select(tabId: string, ref: string, value: string): Promise<unknown> {
  await click(tabId, ref);
  const result = await action(tabId, "select", ref, value);
  const currentValue = await evaluate(tabId, `(() => {
    const active = document.activeElement;
    return active && "value" in active ? active.value : undefined;
  })()`);
  if (currentValue !== value) {
    return evaluate(tabId, `(function() {
      const active = document.activeElement;
      if (!active || !("value" in active)) return false;
      active.value = ${JSON.stringify(value)};
      active.dispatchEvent(new Event("input", { bubbles: true }));
      active.dispatchEvent(new Event("change", { bubbles: true }));
      return active.value;
    })()`);
  }
  return result;
}

/** Scroll the page (no ref needed, pass any ref value). */
export async function scroll(tabId: string): Promise<unknown> {
  return kuriGet("/action", { tab_id: tabId, action: "scroll", ref: "_" });
}

/** Press a key on a target element (focuses first if ref provided). */
export async function press(tabId: string, key: string, ref?: string): Promise<unknown> {
  if (ref && ref !== "_") {
    await click(tabId, ref);
  }
  return kuriGet("/action", { tab_id: tabId, action: "press", ref: ref ?? "_", value: key });
}

// ---------------------------------------------------------------------------
// Wait primitives
// ---------------------------------------------------------------------------

/** Wait for a CSS selector to appear, or for page load if no selector given. */
export async function waitForSelector(
  tabId: string,
  selector?: string,
  timeoutMs?: number,
): Promise<KuriWaitResult> {
  const params: Record<string, string> = { tab_id: tabId };
  if (selector) params.selector = selector;
  if (timeoutMs !== undefined) params.timeout = String(timeoutMs);
  return (await kuriGet("/wait", params)) as KuriWaitResult;
}

/** Wait for page load (document.readyState === "complete"). */
export async function waitForLoad(tabId: string, timeoutMs?: number): Promise<KuriWaitResult> {
  return waitForSelector(tabId, undefined, timeoutMs);
}

// ---------------------------------------------------------------------------
// Keyboard input
// ---------------------------------------------------------------------------

/** Type text character by character via CDP Input.dispatchKeyEvent. */
export async function keyboardType(tabId: string, text: string): Promise<unknown> {
  return kuriGet("/keyboard/type", { tab_id: tabId, text });
}

/** Insert text at cursor (single CDP call, faster than keyboardType). */
export async function keyboardInsertText(tabId: string, text: string): Promise<unknown> {
  return kuriGet("/keyboard/inserttext", { tab_id: tabId, text });
}

/** Dispatch a keydown event. */
export async function keyDown(tabId: string, key: string): Promise<unknown> {
  return kuriGet("/keydown", { tab_id: tabId, key });
}

/** Dispatch a keyup event. */
export async function keyUp(tabId: string, key: string): Promise<unknown> {
  return kuriGet("/keyup", { tab_id: tabId, key });
}

// ---------------------------------------------------------------------------
// Scroll / drag
// ---------------------------------------------------------------------------

/** Scroll an element into view by ref. */
export async function scrollIntoView(tabId: string, ref: string): Promise<unknown> {
  return kuriGet("/scrollintoview", { tab_id: tabId, ref });
}

/** Drag from one element to another by ref. */
export async function drag(
  tabId: string,
  sourceRef: string,
  targetRef: string,
): Promise<unknown> {
  return kuriGet("/drag", { tab_id: tabId, source: sourceRef, target: targetRef });
}

// ---------------------------------------------------------------------------
// DOM inspection
// ---------------------------------------------------------------------------

/** Query DOM by CSS selector. Set all=true to match all elements. */
export async function domQuery(
  tabId: string,
  selector: string,
  all = false,
): Promise<KuriDomQueryResult> {
  const params: Record<string, string> = { tab_id: tabId, selector };
  if (all) params.all = "true";
  return (await kuriGet("/dom/query", params)) as KuriDomQueryResult;
}

/** Get outer HTML of a DOM node by nodeId. */
export async function domHtml(tabId: string, nodeId: number): Promise<unknown> {
  return kuriGet("/dom/html", { tab_id: tabId, node_id: String(nodeId) });
}

/** Get attributes of an element by ref or selector. */
export async function domAttributes(
  tabId: string,
  opts: { ref?: string; selector?: string },
): Promise<unknown> {
  const params: Record<string, string> = { tab_id: tabId };
  if (opts.ref) params.ref = opts.ref;
  if (opts.selector) params.selector = opts.selector;
  return kuriGet("/dom/attributes", params);
}

// ---------------------------------------------------------------------------
// Script injection
// ---------------------------------------------------------------------------

/** Inject a JavaScript source that runs on every page load (Page.addScriptToEvaluateOnNewDocument). */
export async function scriptInject(tabId: string, source: string): Promise<unknown> {
  return kuriPost("/script/inject", { tab_id: tabId }, { source });
}

// ---------------------------------------------------------------------------
// Auth / credentials
// ---------------------------------------------------------------------------

/** Set HTTP Basic auth credentials for a tab (auto-responds to auth challenges). */
export async function setCredentials(
  tabId: string,
  username: string,
  password: string,
): Promise<unknown> {
  return kuriGet("/set/credentials", { tab_id: tabId, username, password });
}

/** Set browser viewport size. */
export async function setViewport(
  tabId: string,
  width: number,
  height: number,
): Promise<unknown> {
  return kuriGet("/set/viewport", { tab_id: tabId, width: String(width), height: String(height) });
}

/** Set user agent string. */
export async function setUserAgent(tabId: string, ua: string): Promise<unknown> {
  return kuriGet("/set/useragent", { tab_id: tabId, ua });
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

/** Export Kuri's current state (tabs, cookies, snapshot cache) as JSON. */
export async function sessionSave(): Promise<unknown> {
  return kuriGet("/session/save");
}

/** Import a previously saved session state. */
export async function sessionLoad(state: unknown): Promise<{ imported: number }> {
  return kuriPost("/session/load", {}, state) as Promise<{ imported: number }>;
}

/** List saved sessions. */
export async function sessionList(): Promise<unknown> {
  return kuriGet("/session/list");
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** Go back in browser history. */
export async function goBack(tabId: string): Promise<unknown> {
  return kuriGet("/back", { tab_id: tabId });
}

/** Go forward in browser history. */
export async function goForward(tabId: string): Promise<unknown> {
  return kuriGet("/forward", { tab_id: tabId });
}

/** Reload the current page. */
export async function reload(tabId: string): Promise<unknown> {
  return kuriGet("/reload", { tab_id: tabId });
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/** Get network events for a tab (requires prior /network?mode=enable). */
export async function getNetworkEvents(tabId: string): Promise<unknown> {
  return kuriGet("/network", { tab_id: tabId });
}

/** Get Largest Contentful Paint metrics. */
export async function getPerfLcp(tabId: string): Promise<unknown> {
  return kuriGet("/perf/lcp", { tab_id: tabId });
}

/** Find text on the page (like Ctrl+F). */
export async function findText(tabId: string, query: string): Promise<unknown> {
  return kuriGet("/find", { tab_id: tabId, query });
}

/** Get page links. */
export async function getLinks(tabId: string): Promise<unknown> {
  return kuriGet("/links", { tab_id: tabId });
}

/** Get console log messages. */
export async function getConsole(tabId: string): Promise<unknown> {
  return kuriGet("/console", { tab_id: tabId });
}

/** Get JavaScript errors from the page. */
export async function getErrors(tabId: string): Promise<unknown> {
  return kuriGet("/errors", { tab_id: tabId });
}

// ── Auth Profiles ─────────────────────────────────────────────────────

/** Save cookies + storage as a named auth profile (persisted in Keychain on macOS). */
export async function authProfileSave(tabId: string, name: string): Promise<unknown> {
  return kuriGet("/auth/profile/save", { tab_id: tabId, name });
}

/** Load a named auth profile into a tab (restores cookies + storage). */
export async function authProfileLoad(tabId: string, name: string): Promise<unknown> {
  return kuriGet("/auth/profile/load", { tab_id: tabId, name });
}

/** List saved auth profiles. */
export async function authProfileList(tabId: string): Promise<unknown> {
  return kuriGet("/auth/profile/list", { tab_id: tabId });
}

/** Delete a saved auth profile. */
export async function authProfileDelete(name: string): Promise<unknown> {
  return kuriGet("/auth/profile/delete", { name });
}
