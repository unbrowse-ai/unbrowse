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
import net from "node:net";
import path from "node:path";
import { log } from "../logger.js";
import { getPackageRoot } from "../runtime/paths.js";

const KURI_DEFAULT_PORT = 7700;
const KURI_STARTUP_TIMEOUT_MS = 10_000;
const KURI_REQUEST_TIMEOUT_MS = 30_000;
const KURI_SPAWN_RETRIES = 3;
const KURI_SPAWN_RETRY_DELAY_MS = 1_000;
const KURI_PORT_SEARCH_LIMIT = 10;
const KURI_CDP_READY_TIMEOUT_MS = 5_000;
const KURI_CDP_POLL_INTERVAL_MS = 200;
const KURI_TAB_CREATE_RETRIES = 5;
let kuriCdpPort: number | null = null;

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

export interface KuriPluginRehydrateResult {
  attempted: boolean;
  loaded: boolean;
  nooped?: boolean;
  reason?: string;
  modules: string[];
  config_loaded?: boolean;
}

export interface KuriLaunchConfig {
  headless: boolean;
  attachToExistingChrome: boolean;
}

type BrokerState = {
  process: ChildProcess | null;
  port: number;
  cdpPort: number | null;
  managedChrome: boolean;
  ready: boolean;
  startPromise: Promise<void> | null;
  requestedPort: number;
};

export interface KuriClient {
  start(port?: number): Promise<void>;
  stop(): Promise<void>;
  discoverTabs(): Promise<KuriTab[]>;
  getDefaultTab(): Promise<string>;
  navigate(tabId: string, url: string): Promise<void>;
  evaluate(tabId: string, expression: string): Promise<unknown>;
  getCookies(tabId: string): Promise<KuriCookie[]>;
  setCookie(tabId: string, cookie: KuriCookie): Promise<void>;
  setCookies(tabId: string, cookies: KuriCookie[]): Promise<void>;
  setHeaders(tabId: string, headers: Record<string, string>): Promise<void>;
  harStart(tabId: string): Promise<void>;
  harStop(tabId: string): Promise<{ entries: KuriHarEntry[]; raw: unknown }>;
  networkEnable(tabId: string): Promise<void>;
  interceptStart(tabId: string): Promise<void>;
  getText(tabId: string): Promise<string>;
  getMarkdown(tabId: string): Promise<string>;
  screenshot(tabId: string): Promise<string>;
  snapshot(tabId: string, filter?: string): Promise<string>;
  closeTab(tabId: string): Promise<void>;
  newTab(url?: string): Promise<string>;
  getCurrentUrl(tabId: string): Promise<string>;
  getPageHtml(tabId: string): Promise<string>;
  bestEffortRehydratePlugins(tabId: string): Promise<KuriPluginRehydrateResult>;
  hasCloudflareChallenge(tabId: string): Promise<boolean>;
  waitForCloudflare(tabId: string, maxWaitMs?: number): Promise<boolean>;
  executeInPageFetch(
    tabId: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }>;
  health(): Promise<{ ok: boolean; tabs?: number }>;
  getPort(): number;
  isReady(): boolean;
  action(tabId: string, actionType: KuriActionType, ref: string, value?: string): Promise<unknown>;
  click(tabId: string, ref: string): Promise<unknown>;
  fill(tabId: string, ref: string, value: string): Promise<unknown>;
  select(tabId: string, ref: string, value: string): Promise<unknown>;
  scroll(tabId: string, direction?: "up" | "down" | "left" | "right", amount?: number): Promise<unknown>;
  press(tabId: string, key: string, ref?: string): Promise<unknown>;
  waitForSelector(tabId: string, selector?: string, timeoutMs?: number): Promise<KuriWaitResult>;
  waitForLoad(tabId: string, timeoutMs?: number): Promise<KuriWaitResult>;
  keyboardType(tabId: string, text: string): Promise<unknown>;
  keyboardInsertText(tabId: string, text: string): Promise<unknown>;
  keyDown(tabId: string, key: string): Promise<unknown>;
  keyUp(tabId: string, key: string): Promise<unknown>;
  scrollIntoView(tabId: string, ref: string): Promise<unknown>;
  drag(tabId: string, sourceRef: string, targetRef: string): Promise<unknown>;
  domQuery(tabId: string, selector: string, all?: boolean): Promise<KuriDomQueryResult>;
  domHtml(tabId: string, nodeId: number): Promise<unknown>;
  domAttributes(tabId: string, opts: { ref?: string; selector?: string }): Promise<unknown>;
  scriptInject(tabId: string, source: string): Promise<unknown>;
  setCredentials(tabId: string, username: string, password: string): Promise<unknown>;
  setViewport(tabId: string, width: number, height: number): Promise<unknown>;
  setUserAgent(tabId: string, ua: string): Promise<unknown>;
  sessionSave(): Promise<unknown>;
  sessionLoad(state: unknown): Promise<{ imported: number }>;
  sessionList(): Promise<unknown>;
  goBack(tabId: string): Promise<unknown>;
  goForward(tabId: string): Promise<unknown>;
  reload(tabId: string): Promise<unknown>;
  getNetworkEvents(tabId: string): Promise<unknown>;
  getPerfLcp(tabId: string): Promise<unknown>;
  findText(tabId: string, query: string): Promise<unknown>;
  getLinks(tabId: string): Promise<unknown>;
  getConsole(tabId: string): Promise<unknown>;
  getErrors(tabId: string): Promise<unknown>;
  authProfileSave(tabId: string, name: string): Promise<unknown>;
  authProfileLoad(tabId: string, name: string): Promise<unknown>;
  authProfileList(tabId: string): Promise<unknown>;
  authProfileDelete(name: string): Promise<unknown>;
}

function createBrokerState(port = KURI_DEFAULT_PORT): BrokerState {
  return {
    process: null,
    port,
    cdpPort: null,
    managedChrome: false,
    ready: false,
    startPromise: null,
    requestedPort: port,
  };
}

const defaultBrokerState = createBrokerState();
const brokerClients = new Map<string, KuriClient>();

function brokerCacheKey(port?: number): string {
  return port === undefined ? "default" : `port:${port}`;
}

function rememberBrokerClient(client: KuriClient, state: BrokerState): void {
  brokerClients.set(brokerCacheKey(state.requestedPort), client);
  brokerClients.set(brokerCacheKey(state.port), client);
}

function forgetBrokerClient(state: BrokerState): void {
  brokerClients.delete(brokerCacheKey(state.requestedPort));
  brokerClients.delete(brokerCacheKey(state.port));
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function resolveKuriLaunchConfig(env: NodeJS.ProcessEnv = process.env): KuriLaunchConfig {
  const headless = envFlag(env.KURI_HEADLESS ?? env.HEADLESS);
  const disableCdpAttach = envFlag(env.KURI_DISABLE_CDP_ATTACH);
  return {
    headless,
    attachToExistingChrome: !headless && !disableCdpAttach,
  };
}

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
async function discoverCdpPort(state: BrokerState): Promise<void> {
  const portsToTry = [9222, 9223, 9224, 9225];
  for (const port of portsToTry) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        state.cdpPort = port;
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

async function isKuriHealthyOnPort(port: number): Promise<boolean> {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return health.ok;
  } catch {
    return false;
  }
}

async function isChromeCdpAvailable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForChromeCdpReady(
  state: Pick<BrokerState, "cdpPort">,
  timeoutMs = KURI_CDP_READY_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof state.cdpPort !== "number") return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isChromeCdpAvailable(state.cdpPort)) return true;
    await new Promise((resolve) => setTimeout(resolve, KURI_CDP_POLL_INTERVAL_MS));
  }
  return false;
}

export function shouldReuseManagedChrome(
  launchConfig: KuriLaunchConfig,
  state: Pick<BrokerState, "cdpPort" | "managedChrome">,
  managedChromeAvailable: boolean,
): boolean {
  return !launchConfig.attachToExistingChrome
    && state.managedChrome === true
    && typeof state.cdpPort === "number"
    && managedChromeAvailable;
}

async function isTcpPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function resolveKuriPort(
  preferredPort: number,
  deps: {
    isHealthyPort?: (port: number) => Promise<boolean>;
    isPortOpen?: (port: number) => Promise<boolean>;
    searchLimit?: number;
  } = {},
): Promise<number> {
  const isHealthyPort = deps.isHealthyPort ?? isKuriHealthyOnPort;
  const isPortOpen = deps.isPortOpen ?? isTcpPortOpen;
  const searchLimit = deps.searchLimit ?? KURI_PORT_SEARCH_LIMIT;

  if (await isHealthyPort(preferredPort)) return preferredPort;
  if (!await isPortOpen(preferredPort)) return preferredPort;

  for (let candidate = preferredPort + 1; candidate <= preferredPort + searchLimit; candidate++) {
    if (await isHealthyPort(candidate)) return candidate;
    if (!await isPortOpen(candidate)) return candidate;
  }

  return preferredPort;
}

/** Launch the user's real Chrome with CDP debugging if no Chrome is running.
 *  This gives Kuri access to all the user's existing cookies/sessions. */
async function ensureUserChromeRunning(state: BrokerState): Promise<void> {
  // Check if Chrome already has CDP
  for (const port of [9222, 9223, 9224, 9225]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        state.cdpPort = port;
        return;
      }
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
  state.cdpPort = port;
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

function kuriUrl(state: BrokerState, path: string, params?: Record<string, string>): string {
  const base = `http://127.0.0.1:${state.port}${path}`;
  if (!params || Object.keys(params).length === 0) return base;
  // Build query string manually — URLSearchParams encodes values which breaks
  // URL parameters (Kuri's getQueryParam doesn't decode percent-encoding).
  // We must still encode # and & in values to avoid breaking URL structure.
  const parts = Object.entries(params).map(([k, v]) => `${k}=${v.replace(/#/g, "%23").replace(/&/g, "%26")}`);
  return `${base}?${parts.join("&")}`;
}

async function kuriGet(state: BrokerState, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = kuriUrl(state, path, params);
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

async function kuriPost(state: BrokerState, path: string, params: Record<string, string>, body: unknown): Promise<unknown> {
  const url = kuriUrl(state, path, params);
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
async function startOn(state: BrokerState, port?: number): Promise<void> {
  if (state.ready) return;
  if (state.startPromise) return state.startPromise;

  const startPromise = (async () => {
    const launchConfig = resolveKuriLaunchConfig();
    const requestedPort = port ?? Number(process.env.KURI_PORT || KURI_DEFAULT_PORT);
    state.requestedPort = requestedPort;
    state.port = await resolveKuriPort(requestedPort);
    const existingClient = brokerClients.get(brokerCacheKey(requestedPort));
    if (existingClient) rememberBrokerClient(existingClient, state);
    if (state.port !== requestedPort) {
      log("kuri", `preferred port ${requestedPort} is occupied but unhealthy; falling back to ${state.port}`);
    }

    // Check if kuri is already running on this port
    if (await isKuriHealthyOnPort(state.port)) {
      log("kuri", `already running on port ${state.port}`);
      state.ready = true;
      await discoverCdpPort(state);
      await ensureTabsDiscovered(state);
      return;
    }

    const binary = findKuriBinary();
    log("kuri", `starting: ${binary} on port ${state.port}`);
    if (!existsSync(binary)) {
      throw new Error(`Kuri binary not found at ${binary}`);
    }

    const reusableManagedChrome = shouldReuseManagedChrome(
      launchConfig,
      state,
      typeof state.cdpPort === "number" && await isChromeCdpAvailable(state.cdpPort),
    );

    if (launchConfig.attachToExistingChrome) {
      // Discover existing Chrome CDP if available
      await discoverCdpPort(state);
      state.managedChrome = false;
    } else if (reusableManagedChrome) {
      log("kuri", `reconnecting to surviving managed Chrome on port ${state.cdpPort}`);
    } else {
      state.cdpPort = null;
      state.managedChrome = false;
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(state.port),
      HOST: "127.0.0.1",
      HEADLESS: launchConfig.headless ? "true" : "false",
    };
    if (state.cdpPort && (launchConfig.attachToExistingChrome || reusableManagedChrome)) {
      env.CDP_URL = `ws://127.0.0.1:${state.cdpPort}`;
      log("kuri", reusableManagedChrome
        ? `connecting to surviving managed Chrome on port ${state.cdpPort}`
        : `connecting to existing Chrome on port ${state.cdpPort}`);
    } else if (launchConfig.headless) {
      log("kuri", "starting in headless mode with managed Chrome");
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
      state.process = spawn(binary, [], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const childPid = state.process.pid;
      log("kuri", `spawned pid ${childPid ?? "unknown"} on broker port ${state.port}`);

      // Parse CDP port from stderr output
      state.process.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) log("kuri", `[stderr] ${line}`);
        const cdpMatch = line.match(/CDP port:\s*(\d+)/);
        if (cdpMatch) {
          state.cdpPort = parseInt(cdpMatch[1], 10);
          log("kuri", `discovered CDP port: ${state.cdpPort}`);
        }
        if (/launched Chrome \(pid=\d+\) on CDP port/i.test(line) || /launching managed Chrome instance/i.test(line)) {
          state.managedChrome = true;
        }
      });

      state.process.on("exit", (code, signal) => {
        if (!state.ready) exitedBeforeReady = true;
        log(
          "kuri",
          `process exited pid=${childPid ?? "unknown"} code=${code === null ? "null" : code} signal=${signal ?? "none"} broker_port=${state.port} cdp_port=${state.cdpPort ?? "unknown"}`,
        );
        state.ready = false;
        state.process = null;
        forgetBrokerClient(state);
      });

      // Wait for health endpoint; break early if process died
      const deadline = Date.now() + KURI_STARTUP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (exitedBeforeReady) break;
        try {
          const res = await fetch(`http://127.0.0.1:${state.port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (res.ok) {
            state.ready = true;
            log("kuri", `ready on port ${state.port}`);
            await new Promise((r) => setTimeout(r, 300));
            if (!state.cdpPort) await discoverCdpPort(state);
            await waitForChromeCdpReady(state).catch(() => false);
            // Auto-discover tabs so they're registered for immediate use
            await ensureTabsDiscovered(state);
            return;
          }
        } catch {
          // Not ready yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      if (state.ready) return;

      // Kill any lingering process before next attempt
      if (state.process) {
        state.process.kill();
        await waitForChildExit(state.process);
      }
      // Also kill any orphaned Chrome processes on the CDP port
      try {
        execFileSync("pkill", ["-f", `remote-debugging-port=${state.cdpPort ?? 9222}`], { stdio: "ignore" });
        await new Promise((r) => setTimeout(r, 1000));
      } catch { /* no matching process — fine */ }
    }
    throw new Error(`Kuri failed to start after ${maxAttempts} attempts`);
  })();

  state.startPromise = startPromise.finally(() => {
    if (state.startPromise === startPromise) {
      state.startPromise = null;
    }
  });
  return state.startPromise;
}

/** Stop Kuri and managed Chrome. */
async function stopOn(state: BrokerState): Promise<void> {
  if (state.startPromise) {
    await state.startPromise.catch(() => {});
  }
  if (state.process) {
    state.process.kill("SIGTERM");
    state.process = null;
  }
  state.ready = false;
  state.cdpPort = null;
  state.managedChrome = false;
  state.startPromise = null;
  forgetBrokerClient(state);
}

/** List discovered Chrome tabs. */
async function discoverTabsOn(state: BrokerState): Promise<KuriTab[]> {
  // Trigger Kuri's /discover to sync Chrome tabs
  await ensureTabsDiscovered(state);

  // List registered tabs
  try {
    const tabs = (await kuriGet(state, "/tabs")) as Array<{ id: string; url: string; title?: string }>;
    if (Array.isArray(tabs) && tabs.length > 0) return tabs;
  } catch { /* empty */ }

  return [];
}

/** Get or discover the first usable tab. */
async function getDefaultTabOn(state: BrokerState): Promise<string> {
  // Ensure Kuri's /discover works by triggering it (it registers tabs from Chrome)
  await ensureTabsDiscovered(state);

  // Now list Kuri's registered tabs
  try {
    const tabs = (await kuriGet(state, "/tabs")) as Array<{ id: string; url: string }>;
    if (Array.isArray(tabs) && tabs.length > 0) return tabs[0].id;
  } catch { /* no tabs registered */ }

  // Create a new tab via Chrome CDP and re-discover
  if (state.cdpPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${state.cdpPort}/json/new?about:blank`, {
        method: "PUT",
        signal: AbortSignal.timeout(5000),
      });
      const target = (await res.json()) as { id: string };
      if (target?.id) {
        log("kuri", `created new Chrome tab: ${target.id}`);
        // Re-discover to register it with Kuri
        await new Promise((r) => setTimeout(r, 300));
        await ensureTabsDiscovered(state);
        return target.id;
      }
    } catch (err) {
      log("kuri", `Chrome tab creation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new Error("No tabs available and failed to create one");
}

export async function start(port?: number, state: BrokerState = defaultBrokerState): Promise<void> {
  return startOn(state, port);
}

export async function stop(state: BrokerState = defaultBrokerState): Promise<void> {
  return stopOn(state);
}

export async function discoverTabs(state: BrokerState = defaultBrokerState): Promise<KuriTab[]> {
  return discoverTabsOn(state);
}

export async function getDefaultTab(state: BrokerState = defaultBrokerState): Promise<string> {
  return getDefaultTabOn(state);
}

/** Trigger Kuri's /discover to sync Chrome tabs into Kuri's registry. */
/** Trigger Kuri's /discover to sync Chrome tabs into Kuri's registry. */
async function ensureTabsDiscovered(state: BrokerState): Promise<void> {
  try {
    if (state.cdpPort) await waitForChromeCdpReady(state).catch(() => false);
    // Pass CDP URL as query param so /discover works even if Kuri was started without CDP_URL env
    const params: Record<string, string> = {};
    if (state.cdpPort) params.cdp_url = `ws://127.0.0.1:${state.cdpPort}`;
    await kuriGet(state, "/discover", params);
  } catch {
    // /discover may fail if no Chrome running — that's OK
  }
}

async function waitForTabRegistration(state: BrokerState, tabId: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await ensureTabsDiscovered(state);
    try {
      const tabs = (await kuriGet(state, "/tabs")) as Array<{ id?: string }>;
      if (Array.isArray(tabs) && tabs.some((tab) => tab?.id === tabId)) return;
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createTabViaChromeCdp(url = "about:blank", state: BrokerState = defaultBrokerState): Promise<string> {
  if (!state.cdpPort) return "";
  for (let attempt = 0; attempt < KURI_TAB_CREATE_RETRIES; attempt += 1) {
    await waitForChromeCdpReady(state).catch(() => false);
    try {
      const res = await fetch(`http://127.0.0.1:${state.cdpPort}/json/new?${url}`, {
        method: "PUT",
        signal: AbortSignal.timeout(5000),
      });
      const target = await res.json() as { id?: string; targetId?: string };
      const tabId = target?.id ?? target?.targetId ?? "";
      if (tabId) return tabId;
    } catch (err) {
      if (attempt === KURI_TAB_CREATE_RETRIES - 1) {
        log("kuri", `Chrome tab creation failed: ${err instanceof Error ? err.message : err}`);
        return "";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, KURI_CDP_POLL_INTERVAL_MS));
  }
  return "";
}

async function findReusableIdleTab(state: BrokerState = defaultBrokerState): Promise<string> {
  await ensureTabsDiscovered(state);
  try {
    const tabs = (await kuriGet(state, "/tabs")) as Array<{ id?: string; url?: string }>;
    const candidate = tabs.find((tab) => /^(about:blank|chrome:\/\/newtab\/?)$/i.test(tab?.url ?? ""));
    return candidate?.id ?? "";
  } catch {
    return "";
  }
}

/** Navigate tab to URL. */
export async function navigate(tabId: string, url: string, state: BrokerState = defaultBrokerState): Promise<void> {
  await kuriGet(state, "/navigate", { tab_id: tabId, url });
}

/** Evaluate JavaScript in tab context. */
/** Evaluate JavaScript in tab context. */
/** Evaluate JavaScript in tab context. */
/** Evaluate JavaScript in tab context. */
export async function evaluate(tabId: string, expression: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  let raw: {
    id?: number;
    result?: { result?: { type?: string; value?: unknown; description?: string }; exceptionDetails?: unknown };
  };
  if (expression.length > 2000) {
    // Use POST with raw text body for large expressions to avoid URL length limits
    const url = kuriUrl(state, "/evaluate", { tab_id: tabId });
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
    raw = (await kuriGet(state, "/evaluate", { tab_id: tabId, expression })) as typeof raw;
  }
  // CDP Runtime.evaluate response: { id, result: { result: { type, value } } }
  const inner = raw?.result?.result;
  if (!inner) return raw;
  if (inner.type === "undefined") return undefined;
  if ("value" in inner) return inner.value;
  return inner.description ?? raw;
}

export function getKuriErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return null;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (typeof record.message === "string") return record.message;
  if (record.result && typeof record.result === "object") {
    const nested = record.result as Record<string, unknown>;
    if (typeof nested.error === "string") return nested.error;
    if (typeof nested.message === "string") return nested.message;
  }
  return null;
}

/** Get all cookies for a tab. */
export async function getCookies(tabId: string, state: BrokerState = defaultBrokerState): Promise<KuriCookie[]> {
  const raw = (await kuriGet(state, "/cookies", { tab_id: tabId })) as {
    id?: number;
    result?: { cookies?: KuriCookie[] };
  };
  return raw?.result?.cookies ?? [];
}

/** Set a cookie via raw CDP WebSocket — supports all cookie attributes (secure, httpOnly, sameSite, expires). */
async function setCookieViaCDP(wsUrl: string, cookie: {
  name: string; value: string; domain: string; path: string;
  secure: boolean; httpOnly: boolean; sameSite: string; expires?: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, 3000);
    try {
      const ws = new (require("ws") as typeof import("ws"))(wsUrl);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          id: 1,
          method: "Network.setCookie",
          params: {
            ...cookie,
            url: `https://${cookie.domain.replace(/^\./, "")}/`,
          },
        }));
      });
      ws.on("message", (data: Buffer) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1) {
            ws.close();
            resolve(msg.result?.success ?? false);
          }
        } catch { ws.close(); resolve(false); }
      });
      ws.on("error", () => { clearTimeout(timer); resolve(false); });
    } catch { clearTimeout(timer); resolve(false); }
  });
}

async function resolveCdpDebuggerUrlForTab(tabId: string): Promise<string | null> {
  const portsToTry = Array.from(new Set(
    [kuriCdpPort, 9222, 9223, 9224, 9225].filter((port): port is number => typeof port === "number"),
  ));

  for (const port of portsToTry) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) continue;
      const pages = await res.json() as Array<{ id: string; webSocketDebuggerUrl?: string }>;
      const page = pages.find((candidate) => candidate.id === tabId);
      if (page?.webSocketDebuggerUrl) {
        if (kuriCdpPort !== port) {
          kuriCdpPort = port;
          log("kuri", `updated CDP port from tab discovery: ${port}`);
        }
        return page.webSocketDebuggerUrl;
      }
    } catch {
      // Try the next candidate port.
    }
  }

  return null;
}

/** Set a single cookie via raw CDP (Chrome debug port) for full attribute support.
 *  Falls back to Kuri's /cookies endpoint if CDP is unavailable. */
/** Set a single cookie via raw CDP (Chrome debug port) for full attribute support.
 *  Falls back to Kuri's /cookies endpoint if CDP is unavailable. */
export async function setCookie(tabId: string, cookie: KuriCookie, state: BrokerState = defaultBrokerState): Promise<void> {
  // Strip wrapping quotes from cookie values (Chrome stores some values like JSESSIONID with literal quotes)
  const value = cookie.value.replace(/^"|"$/g, "");

  // Try raw CDP first — Kuri's /cookies endpoint doesn't pass secure/httpOnly/sameSite/expires
  // which causes auth failures on sites like LinkedIn that require secure cookies.
  if (cookie.secure || cookie.httpOnly) {
    try {
      const debuggerUrl = await resolveCdpDebuggerUrlForTab(tabId);
      if (debuggerUrl) {
        const success = await setCookieViaCDP(debuggerUrl, {
          name: cookie.name,
          value,
          domain: cookie.domain,
          path: cookie.path || "/",
          secure: cookie.secure ?? false,
          httpOnly: cookie.httpOnly ?? false,
          sameSite: cookie.sameSite || "Lax",
          ...(cookie.expires && cookie.expires > 0 ? { expires: cookie.expires } : {}),
        });
        if (success) return;
        log("kuri", `CDP cookie set failed for ${cookie.name} on ${cookie.domain}; falling back to /cookies`);
      } else {
        log("kuri", `no CDP websocket for tab ${tabId}; falling back to /cookies for secure cookie ${cookie.name}`);
      }
    } catch { /* CDP unavailable, fall through to Kuri */ }
  }

  // Fallback: Kuri's /cookies endpoint (no secure/httpOnly support)
  await kuriGet(state, "/cookies", {
    tab_id: tabId,
    name: cookie.name,
    value,
    domain: cookie.domain,
    ...(cookie.path ? { path: cookie.path } : {}),
  });
}

/** Set multiple cookies. */
export async function setCookies(tabId: string, cookies: KuriCookie[], state: BrokerState = defaultBrokerState): Promise<void> {
  for (const cookie of cookies) {
    await setCookie(tabId, cookie, state);
  }
}

/** Set extra HTTP headers for a tab. */
export async function setHeaders(tabId: string, headers: Record<string, string>, state: BrokerState = defaultBrokerState): Promise<void> {
  await kuriPost(state, "/headers", { tab_id: tabId }, headers);
}

/** Start HAR recording for a tab. */
export async function harStart(tabId: string, state: BrokerState = defaultBrokerState): Promise<void> {
  await kuriGet(state, "/har/start", { tab_id: tabId });
}

/** Stop HAR recording and return entries. */
export async function harStop(tabId: string, state: BrokerState = defaultBrokerState): Promise<{ entries: KuriHarEntry[]; raw: unknown }> {
  const result = (await kuriGet(state, "/har/stop", { tab_id: tabId })) as {
    entries?: number;
    har?: { log?: { entries?: KuriHarEntry[] } };
  };
  return {
    entries: result?.har?.log?.entries ?? [],
    raw: result,
  };
}

/** Enable Network domain (needed for cookies/interception). */
export async function networkEnable(tabId: string, state: BrokerState = defaultBrokerState): Promise<void> {
  await kuriGet(state, "/network", { tab_id: tabId, mode: "enable" });
}

/** Start Fetch interception. */
export async function interceptStart(tabId: string, state: BrokerState = defaultBrokerState): Promise<void> {
  await kuriGet(state, "/intercept/start", { tab_id: tabId });
}

/** Get page text content. */
export async function getText(tabId: string, state: BrokerState = defaultBrokerState): Promise<string> {
  const result = (await kuriGet(state, "/text", { tab_id: tabId })) as { text?: string };
  return result?.text ?? "";
}

/** Get page as markdown. */
export async function getMarkdown(tabId: string, state: BrokerState = defaultBrokerState): Promise<string> {
  const result = (await kuriGet(state, "/markdown", { tab_id: tabId })) as { markdown?: string };
  return result?.markdown ?? "";
}

/** Take screenshot (returns base64 PNG). */
export async function screenshot(tabId: string, state: BrokerState = defaultBrokerState): Promise<string> {
  const result = (await kuriGet(state, "/screenshot", { tab_id: tabId })) as { data?: string; screenshot?: string };
  return result?.data ?? result?.screenshot ?? "";
}

/** Get accessibility tree snapshot. */
export async function snapshot(tabId: string, filter?: string, state: BrokerState = defaultBrokerState): Promise<string> {
  const params: Record<string, string> = { tab_id: tabId };
  if (filter) params.filter = filter;
  params.format = "text";
  const result = await kuriGet(state, "/snapshot", params);
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "snapshot" in result && typeof (result as { snapshot?: unknown }).snapshot === "string") {
    return (result as { snapshot: string }).snapshot;
  }
  return "";
}

/** Close a tab. */
export async function closeTab(tabId: string, state: BrokerState = defaultBrokerState): Promise<void> {
  await kuriGet(state, "/close", { tab_id: tabId });
}

/** Create a new tab. */
export async function newTab(url?: string, state: BrokerState = defaultBrokerState): Promise<string> {
  if (state.cdpPort) await waitForChromeCdpReady(state).catch(() => false);
  const params: Record<string, string> = {};
  if (url) params.url = url;
  let tabId = "";
  try {
    const result = (await kuriGet(state, "/tab/new", params)) as { tab_id?: string; id?: string; targetId?: string };
    tabId = result?.tab_id ?? result?.id ?? result?.targetId ?? "";
  } catch {
    tabId = "";
  }
  if (!tabId) tabId = await findReusableIdleTab(state);
  if (!tabId) tabId = await createTabViaChromeCdp(url ?? "about:blank", state);
  if (tabId) {
    await waitForTabRegistration(state, tabId).catch(() => {});
  }
  return tabId;
}

/** Get current page URL via evaluate. */
export async function getCurrentUrl(tabId: string, state: BrokerState = defaultBrokerState): Promise<string> {
  const result = await evaluate(tabId, "window.location.href", state);
  return typeof result === "string" ? result : "";
}

/** Get page HTML content via evaluate. */
export async function getPageHtml(tabId: string, state: BrokerState = defaultBrokerState): Promise<string> {
  const result = await evaluate(tabId, "document.documentElement.outerHTML", state);
  return String(result ?? "");
}

export function extractLoadPlugins(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return Array.from(new Set(
    value
      .split(/[\s,;]+/)
      .map((part) => part.trim())
      .filter(Boolean),
  ));
}

export function extractLoadPluginsFromHtml(html: string): string[] {
  const modules: string[] = [];
  const pattern = /data-load-plugins=(["'])(.*?)\1/gi;
  for (const match of html.matchAll(pattern)) {
    modules.push(...extractLoadPlugins(match[2]));
  }
  return Array.from(new Set(modules));
}

export async function bestEffortRehydratePlugins(tabId: string, state: BrokerState = defaultBrokerState): Promise<KuriPluginRehydrateResult> {
  const result = await evaluate(tabId, `(async function() {
    function splitPlugins(value) {
      return String(value || "")
        .split(/[\\s,;]+/)
        .map(function(part) { return part.trim(); })
        .filter(Boolean);
    }
    function pluginPath(name) {
      if (/^https?:\\/\\//i.test(name) || name.startsWith("/")) return name;
      return "/etc/designs/wrs/footLibs/js/plugins/" + (name.endsWith(".js") ? name : name + ".js");
    }
    var modules = Array.from(new Set(
      Array.from(document.querySelectorAll("[data-load-plugins]"))
        .flatMap(function(node) { return splitPlugins(node.getAttribute("data-load-plugins")); })
    ));
    if (modules.length === 0) {
      return JSON.stringify({ attempted: false, loaded: false, nooped: true, reason: "no_plugins", modules: [] });
    }
    if (!window.WRS || typeof window.WRS.require !== "function") {
      return JSON.stringify({ attempted: false, loaded: false, nooped: true, reason: "missing_wrs_require", modules: modules });
    }
    var requireWrs = window.WRS.require.bind(window.WRS);
    async function loadModules(paths) {
      return await new Promise(function(resolve) {
        var done = false;
        var timer = setTimeout(function() {
          if (done) return;
          done = true;
          resolve({ ok: false, reason: "timeout" });
        }, 1500);
        try {
          requireWrs(paths, function() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ ok: true });
          });
        } catch (error) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: error && error.message ? error.message : String(error) });
        }
      });
    }
    var configResult = await loadModules(["/etc/designs/wrs/footLibs/js/config.js"]);
    var pluginResult = await loadModules(modules.map(pluginPath));
    for (var i = 0; i < 6; i++) {
      await new Promise(function(resolve) { return setTimeout(resolve, 100); });
    }
    return JSON.stringify({
      attempted: true,
      loaded: !!pluginResult.ok,
      nooped: false,
      reason: pluginResult.ok ? undefined : pluginResult.reason,
      config_loaded: !!configResult.ok,
      modules: modules,
    });
  })()`, state);

  if (typeof result !== "string") {
    return {
      attempted: false,
      loaded: false,
      nooped: true,
      reason: "invalid_rehydrate_result",
      modules: [],
    };
  }

  try {
    return JSON.parse(result) as KuriPluginRehydrateResult;
  } catch {
    return {
      attempted: false,
      loaded: false,
      nooped: true,
      reason: "invalid_rehydrate_result",
      modules: [],
    };
  }
}

/** Check if page has Cloudflare challenge. */
export async function hasCloudflareChallenge(tabId: string, state: BrokerState = defaultBrokerState): Promise<boolean> {
  const result = await evaluate(tabId, `(function() {
    var html = document.documentElement.innerHTML;
    return html.indexOf('challenge-platform') !== -1 ||
           html.indexOf('cf_chl_opt') !== -1 ||
           html.indexOf('cf-error-details') !== -1 ||
           html.indexOf('cf.errors.css') !== -1 ||
           document.title === 'Just a moment...' ||
           /Attention Required.*Cloudflare/.test(document.title) ||
           !!document.querySelector('#challenge-running, #challenge-form, .cf-browser-verification');
  })()`, state);
  return result === true;
}

/** Wait for Cloudflare challenge to clear. */
export async function waitForCloudflare(tabId: string, maxWaitMs = 15000, state: BrokerState = defaultBrokerState): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const blocked = await hasCloudflareChallenge(tabId, state);
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
  state: BrokerState = defaultBrokerState,
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

  const result = await evaluate(tabId, fetchScript, state);
  try {
    return JSON.parse(String(result)) as { status: number; data: unknown };
  } catch {
    return { status: 0, data: result };
  }
}

/** Health check. */
export async function health(state: BrokerState = defaultBrokerState): Promise<{ ok: boolean; tabs?: number }> {
  try {
    const result = (await kuriGet(state, "/health")) as { ok?: boolean; status?: string; tabs?: number };
    return { ok: result?.ok === true || result?.status === "ok", tabs: result?.tabs };
  } catch {
    return { ok: false };
  }
}

/** Get the currently configured port. */
export function getPort(state: BrokerState = defaultBrokerState): number {
  return state.port;
}

export function getCdpPort(): number | null {
  return kuriCdpPort;
}

export function setCdpPortForTests(port: number | null): void {
  kuriCdpPort = port;
}

/** Check if kuri is ready. */
export function isReady(state: BrokerState = defaultBrokerState): boolean {
  return state.ready;
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
  state: BrokerState = defaultBrokerState,
): Promise<unknown> {
  const params: Record<string, string> = { tab_id: tabId, action: actionType, ref };
  if (value !== undefined) params.value = value;
  return kuriGet(state, "/action", params);
}

/** Click an element by ref (scrolls into view first). */
export async function click(tabId: string, ref: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  await scrollIntoView(tabId, ref, state);
  return action(tabId, "click", ref, undefined, state);
}

/** Fill an input element by ref (focuses first). */
export async function fill(tabId: string, ref: string, value: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  await click(tabId, ref, state);
  const result = await action(tabId, "fill", ref, value, state);
  const currentValue = await evaluate(tabId, `(() => {
    const active = document.activeElement;
    return active && "value" in active ? active.value : undefined;
  })()`, state);
  if (currentValue !== value) {
    return evaluate(tabId, `(function() {
      const active = document.activeElement;
      if (!active || !("value" in active)) return false;
      active.value = ${JSON.stringify(value)};
      active.dispatchEvent(new Event("input", { bubbles: true }));
      active.dispatchEvent(new Event("change", { bubbles: true }));
      return active.value;
    })()`, state);
  }
  return result;
}

/** Select a value in a dropdown by ref. */
export async function select(tabId: string, ref: string, value: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  await click(tabId, ref, state);
  const result = await action(tabId, "select", ref, value, state);
  const currentValue = await evaluate(tabId, `(() => {
    const active = document.activeElement;
    return active && "value" in active ? active.value : undefined;
  })()`, state);
  if (currentValue !== value) {
    return evaluate(tabId, `(function() {
      const active = document.activeElement;
      if (!active || !("value" in active)) return false;
      active.value = ${JSON.stringify(value)};
      active.dispatchEvent(new Event("input", { bubbles: true }));
      active.dispatchEvent(new Event("change", { bubbles: true }));
      return active.value;
    })()`, state);
  }
  return result;
}

/**
 * Scroll the page.
 * Direction/amount are accepted for caller compatibility; current Kuri HTTP
 * action only exposes generic page scroll.
 */
export async function scroll(
  tabId: string,
  _direction: "up" | "down" | "left" | "right" = "down",
  _amount?: number,
  state: BrokerState = defaultBrokerState,
): Promise<unknown> {
  return kuriGet(state, "/action", { tab_id: tabId, action: "scroll", ref: "_" });
}

/** Press a key on a target element (focuses first if ref provided). */
export async function press(tabId: string, key: string, ref?: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  if (ref && ref !== "_") {
    await click(tabId, ref, state);
  }
  return kuriGet(state, "/action", { tab_id: tabId, action: "press", ref: ref ?? "_", value: key });
}

// ---------------------------------------------------------------------------
// Wait primitives
// ---------------------------------------------------------------------------

/** Wait for a CSS selector to appear, or for page load if no selector given. */
export async function waitForSelector(
  tabId: string,
  selector?: string,
  timeoutMs?: number,
  state: BrokerState = defaultBrokerState,
): Promise<KuriWaitResult> {
  const params: Record<string, string> = { tab_id: tabId };
  if (selector) params.selector = selector;
  if (timeoutMs !== undefined) params.timeout = String(timeoutMs);
  return (await kuriGet(state, "/wait", params)) as KuriWaitResult;
}

/** Wait for page load (document.readyState === "complete"). */
export async function waitForLoad(tabId: string, timeoutMs?: number, state: BrokerState = defaultBrokerState): Promise<KuriWaitResult> {
  return waitForSelector(tabId, undefined, timeoutMs, state);
}

// ---------------------------------------------------------------------------
// Keyboard input
// ---------------------------------------------------------------------------

/** Type text character by character via CDP Input.dispatchKeyEvent. */
export async function keyboardType(tabId: string, text: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/keyboard/type", { tab_id: tabId, text });
}

/** Insert text at cursor (single CDP call, faster than keyboardType). */
export async function keyboardInsertText(tabId: string, text: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/keyboard/inserttext", { tab_id: tabId, text });
}

/** Dispatch a keydown event. */
export async function keyDown(tabId: string, key: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/keydown", { tab_id: tabId, key });
}

/** Dispatch a keyup event. */
export async function keyUp(tabId: string, key: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/keyup", { tab_id: tabId, key });
}

// ---------------------------------------------------------------------------
// Scroll / drag
// ---------------------------------------------------------------------------

/** Scroll an element into view by ref. */
export async function scrollIntoView(tabId: string, ref: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/scrollintoview", { tab_id: tabId, ref });
}

/** Drag from one element to another by ref. */
export async function drag(
  tabId: string,
  sourceRef: string,
  targetRef: string,
  state: BrokerState = defaultBrokerState,
): Promise<unknown> {
  return kuriGet(state, "/drag", { tab_id: tabId, source: sourceRef, target: targetRef });
}

// ---------------------------------------------------------------------------
// DOM inspection
// ---------------------------------------------------------------------------

/** Query DOM by CSS selector. Set all=true to match all elements. */
export async function domQuery(
  tabId: string,
  selector: string,
  all = false,
  state: BrokerState = defaultBrokerState,
): Promise<KuriDomQueryResult> {
  const params: Record<string, string> = { tab_id: tabId, selector };
  if (all) params.all = "true";
  return (await kuriGet(state, "/dom/query", params)) as KuriDomQueryResult;
}

/** Get outer HTML of a DOM node by nodeId. */
export async function domHtml(tabId: string, nodeId: number, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/dom/html", { tab_id: tabId, node_id: String(nodeId) });
}

/** Get attributes of an element by ref or selector. */
export async function domAttributes(
  tabId: string,
  opts: { ref?: string; selector?: string },
  state: BrokerState = defaultBrokerState,
): Promise<unknown> {
  const params: Record<string, string> = { tab_id: tabId };
  if (opts.ref) params.ref = opts.ref;
  if (opts.selector) params.selector = opts.selector;
  return kuriGet(state, "/dom/attributes", params);
}

// ---------------------------------------------------------------------------
// Script injection
// ---------------------------------------------------------------------------

/** Inject a JavaScript source that runs on every page load (Page.addScriptToEvaluateOnNewDocument). */
export async function scriptInject(tabId: string, source: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriPost(state, "/script/inject", { tab_id: tabId }, { source });
}

// ---------------------------------------------------------------------------
// Auth / credentials
// ---------------------------------------------------------------------------

/** Set HTTP Basic auth credentials for a tab (auto-responds to auth challenges). */
export async function setCredentials(
  tabId: string,
  username: string,
  password: string,
  state: BrokerState = defaultBrokerState,
): Promise<unknown> {
  return kuriGet(state, "/set/credentials", { tab_id: tabId, username, password });
}

/** Set browser viewport size. */
export async function setViewport(
  tabId: string,
  width: number,
  height: number,
  state: BrokerState = defaultBrokerState,
): Promise<unknown> {
  return kuriGet(state, "/set/viewport", { tab_id: tabId, width: String(width), height: String(height) });
}

/** Set user agent string. */
export async function setUserAgent(tabId: string, ua: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/set/useragent", { tab_id: tabId, ua });
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

/** Export Kuri's current state (tabs, cookies, snapshot cache) as JSON. */
export async function sessionSave(state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/session/save");
}

/** Import a previously saved session state. */
export async function sessionLoad(value: unknown, state: BrokerState = defaultBrokerState): Promise<{ imported: number }> {
  return kuriPost(state, "/session/load", {}, value) as Promise<{ imported: number }>;
}

/** List saved sessions. */
export async function sessionList(state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/session/list");
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** Go back in browser history. */
export async function goBack(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/back", { tab_id: tabId });
}

/** Go forward in browser history. */
export async function goForward(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/forward", { tab_id: tabId });
}

/** Reload the current page. */
export async function reload(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/reload", { tab_id: tabId });
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/** Get network events for a tab (requires prior /network?mode=enable). */
export async function getNetworkEvents(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/network", { tab_id: tabId });
}

/** Get Largest Contentful Paint metrics. */
export async function getPerfLcp(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/perf/lcp", { tab_id: tabId });
}

/** Find text on the page (like Ctrl+F). */
export async function findText(tabId: string, query: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/find", { tab_id: tabId, query });
}

/** Get page links. */
export async function getLinks(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/links", { tab_id: tabId });
}

/** Get console log messages. */
export async function getConsole(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/console", { tab_id: tabId });
}

/** Get JavaScript errors from the page. */
export async function getErrors(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/errors", { tab_id: tabId });
}

// ── Auth Profiles ─────────────────────────────────────────────────────

/** Save cookies + storage as a named auth profile (persisted in Keychain on macOS). */
export async function authProfileSave(tabId: string, name: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/auth/profile/save", { tab_id: tabId, name });
}

/** Load a named auth profile into a tab (restores cookies + storage). */
export async function authProfileLoad(tabId: string, name: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/auth/profile/load", { tab_id: tabId, name });
}

/** List saved auth profiles. */
export async function authProfileList(tabId: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/auth/profile/list", { tab_id: tabId });
}

/** Delete a saved auth profile. */
export async function authProfileDelete(name: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriGet(state, "/auth/profile/delete", { name });
}

export function getKuriClient(port?: number): KuriClient {
  const cached = brokerClients.get(brokerCacheKey(port));
  if (cached) return cached;

  const state = port === undefined ? defaultBrokerState : createBrokerState(port);
  const client: KuriClient = {
    start: (requestedPort?: number) => start(requestedPort ?? state.requestedPort, state),
    stop: () => stop(state),
    discoverTabs: () => discoverTabs(state),
    getDefaultTab: () => getDefaultTab(state),
    navigate: (tabId, url) => navigate(tabId, url, state),
    evaluate: (tabId, expression) => evaluate(tabId, expression, state),
    getCookies: (tabId) => getCookies(tabId, state),
    setCookie: (tabId, cookie) => setCookie(tabId, cookie, state),
    setCookies: (tabId, cookies) => setCookies(tabId, cookies, state),
    setHeaders: (tabId, headers) => setHeaders(tabId, headers, state),
    harStart: (tabId) => harStart(tabId, state),
    harStop: (tabId) => harStop(tabId, state),
    networkEnable: (tabId) => networkEnable(tabId, state),
    interceptStart: (tabId) => interceptStart(tabId, state),
    getText: (tabId) => getText(tabId, state),
    getMarkdown: (tabId) => getMarkdown(tabId, state),
    screenshot: (tabId) => screenshot(tabId, state),
    snapshot: (tabId, filter) => snapshot(tabId, filter, state),
    closeTab: (tabId) => closeTab(tabId, state),
    newTab: (url?: string) => newTab(url, state),
    getCurrentUrl: (tabId) => getCurrentUrl(tabId, state),
    getPageHtml: (tabId) => getPageHtml(tabId, state),
    bestEffortRehydratePlugins: (tabId) => bestEffortRehydratePlugins(tabId, state),
    hasCloudflareChallenge: (tabId) => hasCloudflareChallenge(tabId, state),
    waitForCloudflare: (tabId, maxWaitMs) => waitForCloudflare(tabId, maxWaitMs, state),
    executeInPageFetch: (tabId, url, method, headers, body) => executeInPageFetch(tabId, url, method, headers, body, state),
    health: () => health(state),
    getPort: () => getPort(state),
    isReady: () => isReady(state),
    action: (tabId, actionType, ref, value) => action(tabId, actionType, ref, value, state),
    click: (tabId, ref) => click(tabId, ref, state),
    fill: (tabId, ref, value) => fill(tabId, ref, value, state),
    select: (tabId, ref, value) => select(tabId, ref, value, state),
    scroll: (tabId, direction, amount) => scroll(tabId, direction, amount, state),
    press: (tabId, key, ref) => press(tabId, key, ref, state),
    waitForSelector: (tabId, selector, timeoutMs) => waitForSelector(tabId, selector, timeoutMs, state),
    waitForLoad: (tabId, timeoutMs) => waitForLoad(tabId, timeoutMs, state),
    keyboardType: (tabId, text) => keyboardType(tabId, text, state),
    keyboardInsertText: (tabId, text) => keyboardInsertText(tabId, text, state),
    keyDown: (tabId, key) => keyDown(tabId, key, state),
    keyUp: (tabId, key) => keyUp(tabId, key, state),
    scrollIntoView: (tabId, ref) => scrollIntoView(tabId, ref, state),
    drag: (tabId, sourceRef, targetRef) => drag(tabId, sourceRef, targetRef, state),
    domQuery: (tabId, selector, all) => domQuery(tabId, selector, all, state),
    domHtml: (tabId, nodeId) => domHtml(tabId, nodeId, state),
    domAttributes: (tabId, opts) => domAttributes(tabId, opts, state),
    scriptInject: (tabId, source) => scriptInject(tabId, source, state),
    setCredentials: (tabId, username, password) => setCredentials(tabId, username, password, state),
    setViewport: (tabId, width, height) => setViewport(tabId, width, height, state),
    setUserAgent: (tabId, ua) => setUserAgent(tabId, ua, state),
    sessionSave: () => sessionSave(state),
    sessionLoad: (value) => sessionLoad(value, state),
    sessionList: () => sessionList(state),
    goBack: (tabId) => goBack(tabId, state),
    goForward: (tabId) => goForward(tabId, state),
    reload: (tabId) => reload(tabId, state),
    getNetworkEvents: (tabId) => getNetworkEvents(tabId, state),
    getPerfLcp: (tabId) => getPerfLcp(tabId, state),
    findText: (tabId, query) => findText(tabId, query, state),
    getLinks: (tabId) => getLinks(tabId, state),
    getConsole: (tabId) => getConsole(tabId, state),
    getErrors: (tabId) => getErrors(tabId, state),
    authProfileSave: (tabId, name) => authProfileSave(tabId, name, state),
    authProfileLoad: (tabId, name) => authProfileLoad(tabId, name, state),
    authProfileList: (tabId) => authProfileList(tabId, state),
    authProfileDelete: (name) => authProfileDelete(name, state),
  };
  rememberBrokerClient(client, state);
  return client;
}
