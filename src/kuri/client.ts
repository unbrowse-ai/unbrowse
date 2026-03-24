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
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { getPackageRoot } from "../runtime/paths.js";

const KURI_DEFAULT_PORT = 7700;
const KURI_STARTUP_TIMEOUT_MS = 10_000;
const KURI_REQUEST_TIMEOUT_MS = 30_000;

export interface KuriTab {
  id: string;
  url: string;
  title?: string;
}

export interface KuriCookie {
  name: string;
  value: string;
  domain: string;
  url?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}

export interface KuriHarEntry {
  request: {
    method: string;
    url: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: { text: string };
  };
  response: {
    status: number;
    headers?: Array<{ name: string; value: string }>;
    content?: { text?: string; mimeType?: string };
  };
  startedDateTime: string;
}

let kuriProcess: ChildProcess | null = null;
let kuriPort = KURI_DEFAULT_PORT;
let kuriCdpPort: number | null = null;
let kuriCdpUrl: string | null = null;
let managedChromePid: number | null = null;
let kuriReady = false;
let externalChromeOverride: {
  cdpUrl: string;
  child: ChildProcess | null;
  tempDir: string | null;
  previousCdpUrl?: string;
  previousAttach?: string;
} | null = null;

async function waitForChildExit(child: ChildProcess | null | undefined, timeoutMs = 2_000): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function kuriBinaryName(): string {
  return process.platform === "win32" ? "kuri.exe" : "kuri";
}

function currentBundledKuriTargets(): string[] {
  if (process.platform === "darwin" && process.arch === "arm64") return ["darwin-arm64"];
  if (process.platform === "darwin" && process.arch === "x64") return ["darwin-x64"];
  if (process.platform === "linux" && process.arch === "arm64") return ["linux-arm64"];
  if (process.platform === "linux" && process.arch === "x64") return ["linux-x64"];
  if (process.platform === "win32" && process.arch === "arm64") return ["win32-x64"];
  if (process.platform === "win32" && process.arch === "x64") return ["win32-x64"];
  return [];
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

function getKuriWorkspaceRoots(): string[] {
  const packageRoot = getPackageRoot(import.meta.url);
  const candidates: string[] = [];
  addCandidate(candidates, packageRoot);
  addCandidate(candidates, path.join(packageRoot, "packages", "skill"));
  return candidates;
}

export function getKuriSourceCandidates(): string[] {
  const candidates: string[] = [];
  for (const root of getKuriWorkspaceRoots()) {
    addCandidate(candidates, path.join(root, "vendor", "kuri-src"));
    addCandidate(candidates, path.join(root, "submodules", "kuri"));
  }
  if (process.env.KURI_PATH) addCandidate(candidates, process.env.KURI_PATH);
  if (process.env.HOME) addCandidate(candidates, path.join(process.env.HOME, "kuri"));
  return candidates;
}

export function getKuriBinaryCandidates(): string[] {
  const binaryName = kuriBinaryName();
  const candidates: string[] = [];

  for (const root of getKuriWorkspaceRoots()) {
    for (const target of currentBundledKuriTargets()) {
      addCandidate(candidates, path.join(root, "vendor", "kuri", target, binaryName));
    }
  }
  for (const sourceDir of getKuriSourceCandidates()) {
    addCandidate(candidates, path.join(sourceDir, "zig-out", "bin", binaryName));
  }
  addCandidate(candidates, resolveBinaryOnPath("kuri"));
  return candidates;
}

/** Try common CDP ports to find where Chrome is listening. */
async function discoverCdpPort(): Promise<void> {
  const managedPort = await discoverManagedChromeCdpPort();
  if (managedPort) {
    kuriCdpPort = managedPort;
    kuriCdpUrl = `ws://127.0.0.1:${managedPort}`;
    log("kuri", `found Kuri-managed Chrome CDP on port ${managedPort}`);
    return;
  }

  const portsToTry = [9222, 9223, 9224, 9225];
  for (const port of portsToTry) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        kuriCdpPort = port;
        kuriCdpUrl = `ws://127.0.0.1:${port}`;
        log("kuri", `found Chrome CDP on port ${port}`);
        return;
      }
    } catch {
      // Not on this port
    }
  }
  log("kuri", "could not discover CDP port — tab discovery may fail");
}

async function isChromeCdpPort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function parsePortFromCdpUrl(cdpUrl?: string | null): number | null {
  if (!cdpUrl) return null;
  try {
    return Number(new URL(cdpUrl).port) || null;
  } catch {
    return null;
  }
}

function findListeningPid(port: number): number | null {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pid = Number(output.split(/\s+/).find(Boolean));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readProcessCommand(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function isLikelyKuriProcess(pid: number): boolean {
  return /(^|[\/\s])kuri(?:\.exe)?(\s|$)|vendor\/kuri|zig-out\/bin\/kuri/i.test(readProcessCommand(pid));
}

function isLikelyChromeProcess(pid: number): boolean {
  return /\bGoogle Chrome\b|\bChromium\b|\bchrome\b/i.test(readProcessCommand(pid));
}

function findChildPids(pid: number): number[] {
  try {
    const output = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function findListeningPortsForPid(pid: number): number[] {
  try {
    const output = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ports = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("n"))
      .map((line) => {
        const match = line.match(/:(\d+)(?:->|$)/);
        return match ? Number(match[1]) : NaN;
      })
      .filter((value) => Number.isInteger(value) && value > 0);
    return [...new Set(ports)];
  } catch {
    return [];
  }
}

async function discoverManagedChromeCdpPortForPid(kuriPid: number): Promise<number | null> {
  if (!isLikelyKuriProcess(kuriPid)) return null;
  for (const childPid of findChildPids(kuriPid)) {
    if (!isLikelyChromeProcess(childPid)) continue;
    for (const port of findListeningPortsForPid(childPid)) {
      if (await isChromeCdpPort(port)) return port;
    }
  }

  return null;
}

async function discoverManagedChromeCdpPort(): Promise<number | null> {
  const kuriPid = kuriProcess?.pid ?? findListeningPid(kuriPort);
  if (!kuriPid) return null;
  return discoverManagedChromeCdpPortForPid(kuriPid);
}

export const __test = {
  discoverManagedChromeCdpPortForPid,
};

async function waitForKuriDown(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
      if (!res.ok) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
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

function kuriUrl(path: string, params?: Record<string, string>): string {
  const base = `http://127.0.0.1:${kuriPort}${path}`;
  if (!params || Object.keys(params).length === 0) return base;
  const parts = Object.entries(params).map(([k, v]) => `${k}=${v}`);
  return `${base}?${parts.join("&")}`;
}

function kuriEncodedUrl(path: string, params: Record<string, string>): string {
  const base = `http://127.0.0.1:${kuriPort}${path}`;
  return `${base}?${new URLSearchParams(params).toString()}`;
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

/**
 * Start Kuri server + managed Chrome.
 * Idempotent — returns immediately if already running.
 */
export async function start(port?: number): Promise<void> {
  if (kuriReady) return;
  kuriPort = port ?? KURI_DEFAULT_PORT;
  managedChromePid = null;
  const attachExistingChrome = process.env.UNBROWSE_KURI_ATTACH_EXISTING_CHROME === "1";

  // Check if kuri is already running on this port
  try {
    const health = await fetch(`http://127.0.0.1:${kuriPort}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (health.ok) {
      log("kuri", `already running on port ${kuriPort}`);
      kuriReady = true;
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

  // Eval and test runs should default to an isolated managed Chrome. Attaching
  // to whatever is already on :9222 drags in unrelated tabs and destabilizes
  // repeatability. Opt in explicitly when sharing an existing browser is
  // actually desired.
  if (attachExistingChrome) {
    await discoverCdpPort();
  } else {
    kuriCdpPort = null;
    kuriCdpUrl = null;
  }
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(kuriPort),
    HOST: "127.0.0.1",
  };
  const explicitCdpUrl = process.env.CDP_URL || process.env.KURI_CDP_URL;
  kuriCdpPort = parsePortFromCdpUrl(explicitCdpUrl);
  kuriCdpUrl = explicitCdpUrl || (attachExistingChrome && kuriCdpPort ? `ws://127.0.0.1:${kuriCdpPort}` : null);
  if (explicitCdpUrl) {
    env.CDP_URL = explicitCdpUrl;
    log("kuri", `connecting to explicit Chrome at ${explicitCdpUrl}`);
  } else if (attachExistingChrome && kuriCdpPort) {
    env.CDP_URL = kuriCdpUrl || `ws://127.0.0.1:${kuriCdpPort}`;
    log("kuri", `connecting to existing Chrome on port ${kuriCdpPort}`);
  } else {
    delete env.CDP_URL;
    kuriCdpPort = null;
    kuriCdpUrl = null;
    log("kuri", "launching isolated managed Chrome");
  }

  kuriProcess = spawn(binary, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Parse CDP port from stderr output
  kuriProcess.stderr?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      log("kuri", `[stderr] ${line}`);
      const launchedMatch = line.match(/launched Chrome \(pid=(\d+)\) on CDP port (\d+)/);
      if (launchedMatch) {
        managedChromePid = parseInt(launchedMatch[1], 10);
        kuriCdpPort = parseInt(launchedMatch[2], 10);
        kuriCdpUrl = `ws://127.0.0.1:${kuriCdpPort}`;
        log("kuri", `managed Chrome pid=${managedChromePid} cdp_port=${kuriCdpPort}`);
        continue;
      }
      const cdpMatch = line.match(/CDP port:\s*(\d+)/);
      if (cdpMatch) {
        kuriCdpPort = parseInt(cdpMatch[1], 10);
        if (!kuriCdpUrl) kuriCdpUrl = `ws://127.0.0.1:${kuriCdpPort}`;
        log("kuri", `discovered CDP port: ${kuriCdpPort}`);
      }
    }
  });

  kuriProcess.on("exit", (code, signal) => {
    if (managedChromePid) {
      try {
        process.kill(managedChromePid, "SIGTERM");
      } catch {
        // ignore
      }
      managedChromePid = null;
    }
    log("kuri", `process exited with code ${code} signal ${signal ?? "null"}`);
    kuriReady = false;
    kuriProcess = null;
  });

  // Wait for health endpoint
  const deadline = Date.now() + KURI_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
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
  throw new Error(`Kuri failed to start within ${KURI_STARTUP_TIMEOUT_MS}ms`);
}

/** Stop Kuri and managed Chrome. */
export async function stop(): Promise<void> {
  if (kuriProcess) {
    kuriProcess.kill("SIGTERM");
    kuriProcess = null;
  }
  if (managedChromePid) {
    try {
      process.kill(managedChromePid, "SIGTERM");
    } catch {
      // ignore
    }
    managedChromePid = null;
  }
  const externalPid = findListeningPid(kuriPort);
  if (externalPid && externalPid !== kuriProcess?.pid && isLikelyKuriProcess(externalPid)) {
    try {
      process.kill(externalPid, "SIGTERM");
    } catch {
      // ignore
    }
    await waitForKuriDown(kuriPort);
  }
  kuriReady = false;
  kuriCdpPort = null;
  kuriCdpUrl = null;
  if (externalChromeOverride) {
    try {
      externalChromeOverride.child?.kill("SIGTERM");
    } catch {
      // ignore
    }
    if (externalChromeOverride.tempDir) {
      await waitForChildExit(externalChromeOverride.child);
      try {
        rmSync(externalChromeOverride.tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; don't fail the caller on temp profile removal
      }
    }
    if (externalChromeOverride.previousCdpUrl == null) delete process.env.CDP_URL;
    else process.env.CDP_URL = externalChromeOverride.previousCdpUrl;
    if (externalChromeOverride.previousAttach == null) delete process.env.UNBROWSE_KURI_ATTACH_EXISTING_CHROME;
    else process.env.UNBROWSE_KURI_ATTACH_EXISTING_CHROME = externalChromeOverride.previousAttach;
    externalChromeOverride = null;
  }
}

export function useExternalChrome(
  cdpUrl: string,
  options?: { child?: ChildProcess | null; tempDir?: string | null },
): void {
  externalChromeOverride = {
    cdpUrl,
    child: options?.child ?? null,
    tempDir: options?.tempDir ?? null,
    previousCdpUrl: process.env.CDP_URL,
    previousAttach: process.env.UNBROWSE_KURI_ATTACH_EXISTING_CHROME,
  };
  process.env.CDP_URL = cdpUrl;
  process.env.UNBROWSE_KURI_ATTACH_EXISTING_CHROME = "1";
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

/**
 * Create a Chrome tab directly via the CDP /json/new endpoint.
 *
 * Kuri's /tab/new path can panic under repeated eval churn; using Chrome's
 * native target creation keeps tab provisioning outside that crashy path.
 */
export async function createChromeTabViaCdp(
  url = "about:blank",
  options?: { cdpPort?: number | null; rediscover?: boolean },
): Promise<string> {
  let cdpPort = options?.cdpPort ?? kuriCdpPort;
  if (!cdpPort) {
    await discoverCdpPort();
    cdpPort = kuriCdpPort;
  }
  if (!cdpPort) throw new Error("Chrome CDP port unavailable");

  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(5000),
  });
  const target = (await res.json()) as { id?: string };
  if (!target?.id) throw new Error("Chrome tab creation returned no target id");

  log("kuri", `created new Chrome tab: ${target.id}`);
  if (options?.rediscover !== false) {
    await new Promise((r) => setTimeout(r, 300));
    await ensureTabsDiscovered();
    try {
      await waitForTabReady(target.id, externalChromeOverride ? 10_000 : 5_000);
    } catch (error) {
      if (!externalChromeOverride) throw error;
      log("kuri", `using external Chrome tab ${target.id} without registry confirmation (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return target.id;
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

  try {
    return await createChromeTabViaCdp("about:blank");
  } catch (err) {
    log("kuri", `Chrome tab creation failed: ${err instanceof Error ? err.message : err}`);
  }

  throw new Error("No tabs available and failed to create one");
}

/** Trigger Kuri's /discover to sync Chrome tabs into Kuri's registry. */
/** Trigger Kuri's /discover to sync Chrome tabs into Kuri's registry. */
async function ensureTabsDiscovered(): Promise<void> {
  try {
    // Pass CDP URL as query param so /discover works even if Kuri was started without CDP_URL env
    const params: Record<string, string> = {};
    if (kuriCdpUrl) params.cdp_url = kuriCdpUrl;
    else if (kuriCdpPort) params.cdp_url = `ws://127.0.0.1:${kuriCdpPort}`;
    await kuriGet("/discover", params);
  } catch {
    // /discover may fail if no Chrome running — that's OK
  }
}

async function waitForTabReady(tabId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tabs = (await kuriGet("/tabs")) as Array<{ id: string }>;
      if (Array.isArray(tabs) && tabs.some((tab) => tab.id === tabId)) {
        await evaluate(tabId, "1");
        return;
      }
    } catch {
      // Tab not attached yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome tab ${tabId} did not become ready within ${timeoutMs}ms`);
}

/** Navigate tab to URL. */
export async function navigate(tabId: string, url: string): Promise<void> {
  const res = await fetch(kuriEncodedUrl("/navigate", { tab_id: tabId, url }), {
    signal: AbortSignal.timeout(KURI_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await res.text());
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
      if (!res.ok) throw new Error(text || `Kuri evaluate failed (${res.status})`);
      try { raw = JSON.parse(text); } catch { raw = text as never; }
    } finally {
      clearTimeout(timeout);
    }
  } else {
    const res = await fetch(kuriEncodedUrl("/evaluate", { tab_id: tabId, expression }), {
      signal: AbortSignal.timeout(KURI_REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `Kuri evaluate failed (${res.status})`);
    try { raw = JSON.parse(text); } catch { raw = text as never; }
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
  const url = kuriEncodedUrl("/cookies", {
    tab_id: tabId,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    ...(cookie.url ? { url: cookie.url } : {}),
    ...(cookie.path ? { path: cookie.path } : {}),
    ...(cookie.secure != null ? { secure: String(cookie.secure) } : {}),
    ...(cookie.httpOnly != null ? { httpOnly: String(cookie.httpOnly) } : {}),
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.expires != null ? { expires: String(cookie.expires) } : {}),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KURI_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(await res.text() || `Kuri cookie set failed (${res.status})`);
  } finally {
    clearTimeout(timeout);
  }
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
  const result = (await kuriGet("/snapshot", params)) as { snapshot?: string };
  return result?.snapshot ?? "";
}

/** Close a tab. */
export async function closeTab(tabId: string): Promise<void> {
  await kuriGet("/close", { tab_id: tabId });
}

/** Create a new tab. */
export async function newTab(url?: string): Promise<string> {
  return createChromeTabViaCdp(url ?? "about:blank");
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
