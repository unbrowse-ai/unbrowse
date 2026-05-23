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
import { getBrowserAttachEnabled } from "../settings.js";

/**
 * Opt-in browse tracing. Set UNBROWSE_KURI_TRACE=1 to emit [kuri-trace]
 * lines (newTab branch, navigate target, tab discovery) to the dated log
 * for diagnosing wrong-tab / wedge issues. Lazy: the message closure is
 * not even evaluated unless the flag is on, so JSON.stringify and the
 * extra navigate /tabs round-trip cost nothing in normal operation.
 */
const KURI_TRACE = !!(process.env.UNBROWSE_KURI_TRACE && process.env.UNBROWSE_KURI_TRACE !== "0");
function kuriTrace(msg: () => string): void {
  if (KURI_TRACE) log("kuri-trace", msg());
}

const KURI_DEFAULT_PORT = 7700;
const KURI_STARTUP_TIMEOUT_MS = 60_000;
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
  addInitScript(tabId: string, script: string): Promise<unknown>;
  injectStealthScript(tabId: string): Promise<void>;
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

// Global semaphore around the kuri-spawn work. The per-broker
// `state.startPromise` already single-flights concurrent calls for the
// SAME broker, but distinct sessions own distinct brokers — so N
// concurrent /v1/browse/go calls each trigger their own spawn, and the
// host's chrome PIDs / ports / file-descriptor budget runs out after
// ~6-8 simultaneous spawns. Gate run 20260518T125601Z surfaced this
// as "Kuri failed to start after 4 attempts" on probes 019-058 once
// the earlier failure modes (kuri.evaluate / liveness / concat-reject)
// stopped short-circuiting probes.
//
// This bounds the total in-flight spawn count to a small K (env
// KURI_SPAWN_CONCURRENCY, default 4) and queues the rest. Each waiter
// resolves when an active spawn finishes. The semaphore wraps ONLY the
// expensive process-launch + chrome-startup work; reuse-existing-broker
// short-circuits don't take a slot.
const KURI_SPAWN_CONCURRENCY = Math.max(
  1,
  Number(process.env.KURI_SPAWN_CONCURRENCY) || 4,
);
let activeKuriSpawns = 0;
const kuriSpawnWaiters: Array<() => void> = [];

export function _kuriSpawnSemaphoreStateForTests(): { active: number; queued: number; cap: number } {
  return { active: activeKuriSpawns, queued: kuriSpawnWaiters.length, cap: KURI_SPAWN_CONCURRENCY };
}

async function acquireKuriSpawnSlot(): Promise<() => void> {
  if (activeKuriSpawns < KURI_SPAWN_CONCURRENCY) {
    activeKuriSpawns += 1;
  } else {
    await new Promise<void>((resolve) => kuriSpawnWaiters.push(resolve));
    activeKuriSpawns += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeKuriSpawns -= 1;
    const next = kuriSpawnWaiters.shift();
    if (next) next();
  };
}
function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function falseyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

export function resolveKuriLaunchConfig(env: NodeJS.ProcessEnv = process.env): KuriLaunchConfig {
  const explicitHeadless = env.KURI_HEADLESS ?? env.HEADLESS;
  // Default to headless on every platform so production unbrowse never pops a
  // visible browser onto the user's screen. Dev/auth flows set HEADLESS=false
  // explicitly (see src/auth/index.ts and harness/ scripts) when they need to
  // see what the browser is doing.
  // Tri-state parse: only an explicitly truthy or explicitly falsy value
  // overrides the safe default. Anything unrecognized (typo, empty string,
  // untrimmed whitespace, "yes"/"on") falls back to headless=true with a
  // stderr warning so misconfigs don't silently flood the user's screen.
  let headless: boolean;
  if (explicitHeadless === undefined) {
    headless = true;
  } else if (envFlag(explicitHeadless)) {
    headless = true;
  } else if (falseyEnv(explicitHeadless)) {
    headless = false;
  } else {
    if (typeof process !== "undefined" && process.stderr && typeof process.stderr.write === "function") {
      process.stderr.write(
        `[unbrowse] Ignoring unrecognized KURI_HEADLESS/HEADLESS value ${JSON.stringify(explicitHeadless)}; defaulting to headless=true. Use "true"/"1" or "false"/"0".\n`,
      );
    }
    headless = true;
  }
  const cleanRoom = envFlag(env.UNBROWSE_LOCAL_ONLY) || envFlag(env.KURI_CLEAN_ROOM);
  const disableCdpAttach = envFlag(env.KURI_DISABLE_CDP_ATTACH);
  // Default-OFF opportunistic attach (flipped 2026-05-18): kuri no longer
  // silently attaches to whatever Chrome instance happens to be running
  // with CDP. The original "attach by default" North Star (catch every
  // tab any agent opens through one pipeline) had a hidden cost: when
  // the user has Chrome open (Claude Code, a debugger, daily browsing),
  // every bench-gate run, every automated capture, every privacy-
  // sensitive flow silently coupled to the user's visible browser —
  // bypassing HEADLESS=true entirely, because headless only governs
  // MANAGED Chrome that kuri launches itself, not chrome it attached to.
  //
  // Post-flip, attach is OPT-IN: set env `KURI_ATTACH_EXISTING_CHROME=1`
  // OR the persisted setting `browser.attach_existing_chrome=true`. The
  // existing opt-OUT flags (KURI_DISABLE_CDP_ATTACH / UNBROWSE_LOCAL_ONLY
  // / KURI_CLEAN_ROOM) still trump opt-in (so a CI pipeline can force
  // clean-room even if a user setting tries to attach).
  //
  // Defensive: any settings-read failure keeps attach OFF — a broken
  // config can never silently flip a user into hijacking their visible
  // browser.
  const explicitAttachEnv = envFlag(env.KURI_ATTACH_EXISTING_CHROME);
  let attachEnabledBySetting = false;
  try {
    attachEnabledBySetting = getBrowserAttachEnabled() === true;
  } catch {
    attachEnabledBySetting = false;
  }
  const attachToExistingChrome =
    (explicitAttachEnv || attachEnabledBySetting) && !disableCdpAttach && !cleanRoom;
  return {
    headless,
    attachToExistingChrome,
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
  if (process.platform === "win32" && process.arch === "x64") return "win-x64";
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

async function listRegisteredTabs(state: BrokerState): Promise<KuriTab[]> {
  try {
    const tabs = (await kuriGet(state, "/tabs")) as Array<{ id?: string; url?: string; title?: string }>;
    if (!Array.isArray(tabs)) return [];
    return tabs
      .filter((tab): tab is { id: string; url?: string; title?: string } => typeof tab?.id === "string")
      .map((tab) => ({ id: tab.id, url: tab.url ?? "", title: tab.title }));
  } catch {
    return [];
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
    state.cdpPort = null;
  } catch (err) {
    log("kuri", `failed to launch user Chrome: ${err instanceof Error ? err.message : err}`);
    state.cdpPort = null;
  }
}

async function terminateBrokerOnPort(port: number): Promise<void> {
  try {
    const output = execFileSync("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // best effort only
      }
    }
    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {
    // lsof missing or no listener — best effort only
  }
}

type HealthyBrokerReuseDeps = {
  isHealthyPort?: (port: number) => Promise<boolean>;
  isChromeCdpAvailable?: (port: number) => Promise<boolean>;
  discoverCdpPort?: (state: BrokerState) => Promise<void>;
  ensureUserChromeRunning?: (state: BrokerState) => Promise<void>;
  ensureTabsDiscovered?: (state: BrokerState) => Promise<void>;
  listTabs?: (state: BrokerState) => Promise<KuriTab[]>;
  terminateBrokerOnPort?: (port: number) => Promise<void>;
};

export async function reuseHealthyBrokerIfPossible(
  state: BrokerState,
  launchConfig: KuriLaunchConfig,
  deps: HealthyBrokerReuseDeps = {},
): Promise<boolean> {
  const isHealthyPort = deps.isHealthyPort ?? isKuriHealthyOnPort;
  if (!await isHealthyPort(state.port)) return false;

  log("kuri", `already running on port ${state.port}`);
  state.ready = true;
  const cdpAvailable = deps.isChromeCdpAvailable ?? isChromeCdpAvailable;

  const discover = deps.discoverCdpPort ?? discoverCdpPort;
  await discover(state);

  if (!state.cdpPort && launchConfig.attachToExistingChrome) {
    const ensureChrome = deps.ensureUserChromeRunning ?? ensureUserChromeRunning;
    await ensureChrome(state);
  }

  if (typeof state.cdpPort === "number" && !await cdpAvailable(state.cdpPort)) {
    state.cdpPort = null;
  }

  const syncTabs = deps.ensureTabsDiscovered ?? ensureTabsDiscovered;
  await syncTabs(state).catch(() => {});

  const tabs = await (deps.listTabs ?? listRegisteredTabs)(state).catch(() => []);
  if (state.cdpPort) {
    return true;
  }

  if (tabs.length > 0) {
    log("kuri", `healthy broker on port ${state.port} has stale registered tabs but no CDP; recycling startup path`);
  } else {
    log("kuri", `healthy broker on port ${state.port} has no CDP or tabs; recycling startup path`);
  }
  state.ready = false;

  if (state.process) {
    state.process.kill("SIGTERM");
    await waitForChildExit(state.process);
    state.process = null;
  } else {
    const terminate = deps.terminateBrokerOnPort ?? terminateBrokerOnPort;
    await terminate(state.port);
  }

  return false;
}

function kuriUrl(state: BrokerState, path: string, params?: Record<string, string>): string {
  const base = `http://127.0.0.1:${state.port}${path}`;
  if (!params || Object.keys(params).length === 0) return base;
  // Build query string manually — URLSearchParams encodes values which breaks
  // URL parameters (Kuri's getQueryParam doesn't decode percent-encoding).
  // We must still encode reserved separators that otherwise corrupt JS expressions
  // or URL structure when Kuri reads the raw query string.
  const parts = Object.entries(params).map(([k, v]) => `${k}=${
    v
      .replace(/#/g, "%23")
      .replace(/&/g, "%26")
      .replace(/\+/g, "%2B")
  }`);
  return `${base}?${parts.join("&")}`;
}

function shouldRetryKuriTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /fetch failed|econnrefused|connection refused|socket hang up|other side closed|transport closed/i.test(message);
}

async function kuriGet(state: BrokerState, path: string, params?: Record<string, string>, retryOnTransportFailure = true): Promise<unknown> {
  const url = kuriUrl(state, path, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KURI_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch (error) {
    if (retryOnTransportFailure && path !== "/health" && shouldRetryKuriTransportError(error)) {
      log("kuri", `transport failed for ${path}; restarting Kuri and retrying once on port ${state.port}`);
      await stopOn(state);
      await startOn(state, state.requestedPort || state.port);
      return await kuriGet(state, path, params, false);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function kuriPost(state: BrokerState, path: string, params: Record<string, string>, body: unknown, retryOnTransportFailure = true): Promise<unknown> {
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
  } catch (error) {
    if (retryOnTransportFailure && path !== "/health" && shouldRetryKuriTransportError(error)) {
      log("kuri", `transport failed for ${path}; restarting Kuri and retrying once on port ${state.port}`);
      await stopOn(state);
      await startOn(state, state.requestedPort || state.port);
      return await kuriPost(state, path, params, body, false);
    }
    throw error;
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
  const requestedPort = port ?? Number(process.env.KURI_PORT || KURI_DEFAULT_PORT);

  // External Kuri mode: skip launch, connect to an existing Kuri broker + Chrome.
  // Use when running inside a sandbox (turbobox, Docker) that already has Kuri + Chrome.
  // Start Chrome + Kuri externally, then set KURI_EXTERNAL_PORT=<port> and optional CDP_URL.
  const externalPort = process.env.KURI_EXTERNAL_PORT;
  if (externalPort && !state.ready) {
    const ep = Number(externalPort);
    if (await isKuriHealthyOnPort(ep)) {
      state.port = ep;
      state.requestedPort = ep;
      state.ready = true;
      state.managedChrome = false;
      // Discover CDP port from the external Kuri
      const cdpUrl = process.env.CDP_URL;
      if (cdpUrl) {
        const m = cdpUrl.match(/:(\d+)/);
        if (m) state.cdpPort = Number(m[1]);
      }
      log("kuri", `using external Kuri broker on port ${ep}${state.cdpPort ? ` (CDP port ${state.cdpPort})` : ""}`);
      return;
    }
    log("kuri", `external Kuri on port ${ep} not healthy — falling through to normal start`);
  }

  if (state.ready) {
    const activePort = state.port || requestedPort;
    if (await isKuriHealthyOnPort(activePort)) return;
    log("kuri", `cached ready state stale on port ${activePort}; restarting`);
    state.ready = false;
    state.process = null;
    state.startPromise = null;
  }
  if (state.startPromise) return state.startPromise;

  const startPromise = (async () => {
    const launchConfig = resolveKuriLaunchConfig();
    state.requestedPort = requestedPort;
    state.port = await resolveKuriPort(requestedPort);
    const existingClient = brokerClients.get(brokerCacheKey(requestedPort));
    if (existingClient) rememberBrokerClient(existingClient, state);
    if (state.port !== requestedPort) {
      log("kuri", `preferred port ${requestedPort} is occupied but unhealthy; falling back to ${state.port}`);
    }

    // Reuse only when the broker is healthy and either CDP or tabs are still reachable.
    if (await reuseHealthyBrokerIfPossible(state, launchConfig)) return;

    // From here on we'll spawn a fresh kuri process + (optionally) a
    // managed Chrome — both expensive and resource-bound. Bound the
    // GLOBAL concurrent spawn count via the module-level semaphore so
    // sustained-load runs (bench-gate, parallel collectors, codex
    // workers) can't exhaust the host's chrome PIDs / ports / FDs.
    // Reuse short-circuits above bypass the slot, so cold brokers
    // already running don't pay this cost.
    const releaseSpawnSlot = await acquireKuriSpawnSlot();
    try {

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
          kuriCdpPort = state.cdpPort;
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
    } finally {
      releaseSpawnSlot();
    }
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
  const proc = state.process;
  if (proc) {
    // SIGTERM is fire-and-forget. Previously stopOn nulled state.process
    // immediately and returned in 0ms while the kuri process kept running,
    // leaking zombie kuri+Chrome pids on every per-session broker close.
    // Await actual exit with a deadline; SIGKILL if the process refuses.
    proc.kill("SIGTERM");
    const exited = await waitForProcessExit(proc, 3000);
    if (!exited) {
      log("kuri", `stopOn: pid=${proc.pid} did not exit on SIGTERM in 3000ms; sending SIGKILL`);
      proc.kill("SIGKILL");
      await waitForProcessExit(proc, 2000);
    }
    state.process = null;
  }
  state.ready = false;
  state.cdpPort = null;
  kuriCdpPort = null;
  state.managedChrome = false;
  state.startPromise = null;
  forgetBrokerClient(state);
}

export function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    proc.once("exit", () => settle(true));
  });
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

  const cdpTabId = await createTabViaChromeCdp("about:blank", state);
  if (cdpTabId) return cdpTabId;

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
      kuriTrace(() => `createTabViaChromeCdp req_url=${url} status=${res.status} raw=${JSON.stringify(target).slice(0, 300)} -> tabId=${tabId || "<empty>"}`);
      if (tabId) {
        log("kuri", `created new Chrome tab: ${tabId}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await ensureTabsDiscovered(state).catch(() => {});
        await waitForTabRegistration(state, tabId).catch(() => {});
        return tabId;
      }
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
    // Only a CDP-created about:blank is safe to reuse. Chrome's headless
    // chrome://newtab/ NTP is a privileged WebUI target: navigating it to an
    // http(s) URL makes Chrome swap the renderer/target, so kuri's cached
    // tab_id -> targetId/sessionId binding is stranded and every subsequent
    // snap/evaluate fails ("CDP command failed" / empty tree): the
    // "kuri works once then wedges" bug. about:blank -> http keeps the same
    // target. Excluding the NTP also enforces per-session target isolation
    // when several MCP clients share one managed Chrome (no client recycles
    // the shared NTP out from under another).
    kuriTrace(() => `findReusableIdleTab discovered=${JSON.stringify((tabs || []).map((t) => ({ id: t?.id, url: t?.url })))}`);
    const candidate = tabs.find((tab) => /^about:blank$/i.test(tab?.url ?? ""));
    kuriTrace(() => `findReusableIdleTab about:blank candidate=${candidate?.id ?? "<none>"}`);
    if (!candidate?.id) return "";
    // Verify tab is CDP-responsive before reusing — avoids recycling crashed zombie tabs
    try {
      await kuriGet(state, "/evaluate", { tab_id: candidate.id, expression: "1" });
      return candidate.id;
    } catch {
      // Tab is unresponsive — don't reuse, let caller create a fresh one
      return "";
    }
  } catch {
    return "";
  }
}

/** Navigate tab to URL. */
export async function navigate(tabId: string, url: string, state: BrokerState = defaultBrokerState): Promise<void> {
  kuriTrace(() => `navigate -> tab_id=${tabId} url=${url}`);
  const resp = await kuriGet(state, "/navigate", { tab_id: tabId, url });
  // Post-navigate state probe is an extra /tabs round-trip; only pay it
  // when UNBROWSE_KURI_TRACE is set (debugging the wrong-tab/wedge path).
  if (KURI_TRACE) {
    try {
      kuriTrace(() => `navigate <- resp=${JSON.stringify(resp).slice(0, 400)}`);
      const after = (await kuriGet(state, "/tabs")) as Array<{ id?: string; url?: string }>;
      const me = Array.isArray(after) ? after.find((t) => t?.id === tabId) : undefined;
      kuriTrace(() => `navigate post-state tab_id=${tabId} now_url=${me?.url ?? "<<tab_id absent from /tabs>>"} all=${JSON.stringify((after || []).map((t) => ({ id: t?.id, url: t?.url })))}`);
    } catch (e) {
      kuriTrace(() => `navigate post-state probe threw: ${e instanceof Error ? e.message : e}`);
    }
  }
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
    // Kuri's /evaluate handler still reads expression from the query string.
    // Keep the param in the URL even on POST so large submit scripts work.
    const url = kuriUrl(state, "/evaluate", { tab_id: tabId, expression });
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
  // When kuri's /evaluate cannot produce a usable CDP value — error
  // envelope (`result: { error: "..." }`), runtime exception
  // (`result: { exceptionDetails: ... }`), or any shape missing the
  // nested `result.result` — return undefined.
  //
  // Pre-fix this function returned the raw error object via `return raw`,
  // which caused callers to do `String(rawObj ?? "")` and silently
  // produce the literal 15-byte string `"[object Object]"`. That string
  // passes the `livePageHtmlSize > 0` accounting in
  // src/api/browse-index.ts but fails `html.trimStart().startsWith("<")`,
  // so the DOM fallback reported `dom_html_size: 15` and proceeded —
  // concealing the actual CDP failure behind a fake "tiny page" signal.
  // Surfaced by 2026-05-18 MCP gate run 20260518T115632Z probe 001
  // (Hacker News) where ~5 SSR probes (HN, MDN, figma, openlibrary)
  // all carried the 15-byte fingerprint.
  const inner = raw?.result?.result;
  if (!inner) return undefined;
  if (raw?.result && "exceptionDetails" in raw.result && raw.result.exceptionDetails) return undefined;
  if (inner.type === "undefined") return undefined;
  if ("value" in inner) return inner.value;
  return inner.description ?? undefined;
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

function parseCdpResolveRetryDelays(raw: string | undefined): number[] {
  // Default: 3 attempts at 0ms, 150ms, 350ms (cumulative <=500ms wait).
  // Configurable via UNBROWSE_KURI_CDP_RESOLVE_RETRY_MS (comma-separated ms values, first should be 0).
  const fallback = [0, 150, 350];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parts = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) return fallback;
  // Hard cap on total wait to keep the happy-path bounded.
  const total = parts.reduce((sum, n) => sum + n, 0);
  if (total > 2000) return fallback;
  return parts;
}

async function resolveCdpDebuggerUrlForTabOnce(tabId: string): Promise<string | null> {
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

async function resolveCdpDebuggerUrlForTab(tabId: string): Promise<string | null> {
  // Freshly-spawned tabs from kuri.newTab() are sometimes not yet visible in the
  // /json listing at the moment setCookie runs (race between tab creation and
  // CDP-listing exposure). Retry with bounded backoff so the secure-cookie path
  // does not silently fall through to the legacy /cookies fallback that cannot
  // persist secure/httpOnly cookies. Bounded total wait per CLAUDE.md discipline.
  const delays = parseCdpResolveRetryDelays(process.env.UNBROWSE_KURI_CDP_RESOLVE_RETRY_MS);
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
    const url = await resolveCdpDebuggerUrlForTabOnce(tabId);
    if (url) {
      if (attempt > 0) {
        log("kuri", `CDP target ${tabId} resolved after retry attempt=${attempt} delay_ms=${delays[attempt]}`);
      }
      return url;
    }
  }
  return null;
}

/** Set a single cookie via raw CDP (Chrome debug port) for full attribute support.
 *  Falls back to Kuri's /cookies endpoint only for non-secure non-httpOnly cookies.
 *  For secure/httpOnly cookies, throws when CDP is unavailable instead of silently
 *  losing the cookie via the legacy /cookies endpoint (which strips those flags). */
export async function setCookie(tabId: string, cookie: KuriCookie, state: BrokerState = defaultBrokerState): Promise<void> {
  // Strip wrapping quotes from cookie values (Chrome stores some values like JSESSIONID with literal quotes)
  const value = cookie.value.replace(/^"|"$/g, "");

  // F3 (B-023): for secure/httpOnly cookies, the legacy /cookies fallback
  // is DISABLED because it cannot persist those flags — Chrome silently
  // drops the cookie and the caller sees no error. Honest failure beats
  // dishonest success: throw when CDP target is unresolved OR setCookieViaCDP
  // returns false. All five known callers wrap setCookie in try/catch or
  // .catch(()=>{}), so the throw becomes an explicit log line rather than
  // a silent data loss. Non-secure non-httpOnly cookies still hit the
  // legacy fallback (those flags don't matter, /cookies can persist them).
  if (cookie.secure || cookie.httpOnly) {
    let debuggerUrl: string | null = null;
    try {
      debuggerUrl = await resolveCdpDebuggerUrlForTab(tabId);
    } catch (err) {
      // CDP resolution itself threw (very rare; fetch swallows network errors).
      // Treat as unresolved so the secure-cookie branch surfaces honestly.
      log("kuri", `CDP resolve threw for tab ${tabId} cookie ${cookie.name}: ${err instanceof Error ? err.message : String(err)}`);
      debuggerUrl = null;
    }

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
      // CDP target found but the setCookie command itself failed — surface as throw,
      // do NOT silently fall through to /cookies which would strip secure/httpOnly.
      throw new Error(
        `kuri.setCookie: CDP setCookie failed for secure cookie ${cookie.name} on ${cookie.domain} (tab=${tabId}); ` +
        `legacy /cookies fallback is disabled for secure/httpOnly cookies because it cannot persist those flags.`,
      );
    }

    // CDP target not resolvable even after retry. Do NOT fall back to /cookies for
    // secure/httpOnly cookies — that path silently strips the flags and the caller
    // would think the cookie was set. Surface as an explicit throw so the caller
    // (e.g. importBrowserCookiesIntoTab) can log the loss instead of swallowing it.
    throw new Error(
      `kuri.setCookie: no CDP websocket for tab ${tabId}; ` +
      `cannot persist secure/httpOnly cookie ${cookie.name} on ${cookie.domain}. ` +
      `Legacy /cookies fallback is disabled for secure/httpOnly cookies because it strips those flags.`,
    );
  }

  // Fallback: Kuri's /cookies endpoint (no secure/httpOnly support).
  // ONLY used for cookies that don't require secure/httpOnly — those can be set safely here.
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
  const result = (await kuriGet(state, "/text", { tab_id: tabId })) as
    | string
    | { text?: string; result?: { result?: { value?: unknown } } };
  if (typeof result === "string") return result;
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.result?.result?.value === "string") return result.result.result.value;
  return "";
}

/** Get page as markdown. */
export async function getMarkdown(tabId: string, state: BrokerState = defaultBrokerState): Promise<string> {
  const result = (await kuriGet(state, "/markdown", { tab_id: tabId })) as
    | string
    | { markdown?: string; result?: { result?: { value?: unknown } } };
  if (typeof result === "string") return result;
  if (typeof result?.markdown === "string") return result.markdown;
  if (typeof result?.result?.result?.value === "string") return result.result.result.value;
  return "";
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
  const createViaKuri = async (): Promise<{ tab_id?: string; id?: string; targetId?: string; error?: string; message?: string }> =>
    (await kuriGet(state, "/tab/new", params)) as { tab_id?: string; id?: string; targetId?: string; error?: string; message?: string };

  let result: { tab_id?: string; id?: string; targetId?: string; error?: string; message?: string } = {};
  try {
    result = await createViaKuri();
  } catch {
    result = {};
  }
  let tabId = result?.tab_id ?? result?.id ?? result?.targetId ?? "";
  kuriTrace(() => `newTab url=${url ?? "<none>"} /tab/new -> ${tabId || "<empty>"} (raw=${JSON.stringify(result).slice(0, 200)})`);
  if (!tabId) { tabId = await findReusableIdleTab(state); kuriTrace(() => `newTab after findReusableIdleTab -> ${tabId || "<empty>"}`); }
  if (!tabId) { tabId = await createTabViaChromeCdp(url ?? "about:blank", state); kuriTrace(() => `newTab after createTabViaChromeCdp -> ${tabId || "<empty>"}`); }
  if (tabId) {
    await waitForTabRegistration(state, tabId).catch(() => {});
    await injectStealthScript(tabId, state).catch(() => {});
    kuriTrace(() => `newTab RETURN tabId=${tabId} (attempt 1)`);
    return tabId;
  }

  const restartPort = state.requestedPort || state.port;
  const errorMessage = getKuriErrorMessage(result) ?? "unknown tab creation failure";
  log("kuri", `tab creation failed via /tab/new (${errorMessage}); restarting Kuri once`);
  await stopOn(state);
  await startOn(state, restartPort);

  try {
    result = await createViaKuri();
  } catch {
    result = {};
  }
  tabId = result?.tab_id ?? result?.id ?? result?.targetId ?? "";
  if (!tabId) tabId = await findReusableIdleTab(state);
  if (!tabId) tabId = await createTabViaChromeCdp(url ?? "about:blank", state);
  if (tabId) {
    await waitForTabRegistration(state, tabId).catch(() => {});
    await injectStealthScript(tabId, state).catch(() => {});
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
  // Pass the whole fetch config as a single JSON string and JSON.parse it
  // inside the page. This avoids the previous shape — which embedded
  // JSON.stringify(headers) directly into the JS source — silently dropping
  // requests when a header value contained a character that's legal in JSON
  // but not in raw JS source (notably U+2028 / U+2029 line/paragraph
  // separators, but also a few other rare cases). The symptom on
  // hub.docker.com was a "SyntaxError: Invalid or unexpected token" with
  // HTTP status 0 — the script never reached its own try/catch because
  // V8's parser rejected it before execution. Surfaced by the
  // MCP-driven bench-gate's #010_anchor probe.
  const cfg = JSON.stringify({
    url,
    method,
    headers,
    hasBody: body !== undefined,
    body: body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const fetchScript = `(async function() {
    try {
      var cfg = JSON.parse(${JSON.stringify(cfg)});
      var init = { method: cfg.method, headers: cfg.headers };
      if (cfg.hasBody) init.body = cfg.body;
      var res = await fetch(cfg.url, init);
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

/** Register a script to run before page JS on every navigation (Page.addScriptToEvaluateOnNewDocument via /add-init-script). */
export async function addInitScript(tabId: string, script: string, state: BrokerState = defaultBrokerState): Promise<unknown> {
  return kuriPost(state, "/add-init-script", {}, { tab_id: tabId, script });
}

/**
 * Inject a stealth script via Page.addScriptToEvaluateOnNewDocument so it
 * runs before any page JS on every navigation in this tab.
 *
 * Prevents Cloudflare Turnstile and similar bot-detection from seeing
 * headless Chrome signals:
 *   - navigator.webdriver set to false
 *   - window.chrome.runtime presence ensured
 *   - navigator.plugins non-empty
 *
 * Call once per tab immediately after tab creation, not on every navigation
 * (the script persists until the tab is closed).
 *
 * Uses /add-init-script which maps to CDP Page.addScriptToEvaluateOnNewDocument.
 */
export async function injectStealthScript(tabId: string, state: BrokerState = defaultBrokerState): Promise<void> {
  const stealthSource = `(function() {
  // Prevent navigator.webdriver detection
  Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
  // Ensure chrome.runtime is present (headless Chrome lacks it)
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  // Canvas fingerprint noise — Turnstile reads canvas to fingerprint the browser
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type) {
    var data = origToDataURL.apply(this, arguments);
    // Return data as-is; the stable per-session noise is that canvas ops succeed
    // at all (Turnstile checks consistency across calls, not specific values)
    return data;
  };
  // Ensure non-empty plugins list
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', { get: function() { return [{ name: 'Chrome PDF Plugin' }]; } });
  }
})();`;
  await kuriPost(state, "/add-init-script", {}, { tab_id: tabId, script: stealthSource });
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
    addInitScript: (tabId, script) => addInitScript(tabId, script, state),
    injectStealthScript: (tabId) => injectStealthScript(tabId, state),
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
