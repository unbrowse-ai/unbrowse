import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import type { BrowserAuthSourceMeta } from "./browser-cookies.js";

type PrimeableCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
};

type ChromeVersionDescriptor = {
  webSocketDebuggerUrl?: string;
};

type CdpCookieParam = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
};

export interface LaunchedProfileContext {
  cdpUrl: string;
  child: ChildProcess;
  tempDir: string;
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function removeTempDirQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; do not fail captures on temp profile removal
  }
}

function resolveChromiumBinary(browserName: string): string | null {
  const macos = new Map<string, string>([
    ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    ["Arc", "/Applications/Arc.app/Contents/MacOS/Arc"],
    ["Dia", "/Applications/Dia.app/Contents/MacOS/Dia"],
    ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
    ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ["Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
  ]);

  if (process.platform === "darwin") {
    const candidate = macos.get(browserName) ?? null;
    return candidate && existsSync(candidate) ? candidate : null;
  }

  const linux = new Map<string, string>([
    ["Chrome", "google-chrome"],
    ["Chromium", "chromium"],
    ["Arc", "arc"],
    ["Dia", "dia"],
    ["Brave", "brave-browser"],
    ["Edge", "microsoft-edge"],
    ["Vivaldi", "vivaldi"],
  ]);
  return linux.get(browserName) ?? null;
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close((err) => err ? reject(err) : resolve(port));
    });
    server.on("error", reject);
  });
}

function httpBaseFromCdpUrl(cdpUrl: string): string {
  const parsed = new URL(cdpUrl);
  return `http://${parsed.hostname}:${parsed.port}`;
}

export function browserCdpBaseUrl(cdpUrl: string): string {
  const parsed = new URL(cdpUrl);
  return `ws://${parsed.hostname}:${parsed.port}`;
}

async function fetchChromeVersion(port: number, timeoutMs = 15_000): Promise<ChromeVersionDescriptor> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return await res.json() as ChromeVersionDescriptor;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`profile browser failed to expose CDP on ${port}`);
}

function cloneChromiumProfile(meta: BrowserAuthSourceMeta): { tempDir: string; profileDir: string } {
  if (!meta.userDataDir) throw new Error("missing user data dir");
  const profileDir = meta.profile || "Default";
  const sourceRoot = meta.userDataDir;
  const sourceProfile = join(sourceRoot, profileDir);
  if (!existsSync(sourceProfile)) throw new Error(`profile dir not found: ${sourceProfile}`);

  const tempDir = mkdtempSync(join(os.tmpdir(), "unbrowse-profile-"));
  cpSync(sourceRoot, tempDir, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (src) => !/\/Singleton(?:Cookie|Lock|Socket)$/.test(src),
  });
  return { tempDir, profileDir };
}

function toCdpCookieParam(cookie: PrimeableCookie): CdpCookieParam {
  const sameSite = cookie.sameSite === "Strict"
    ? "Strict"
    : cookie.sameSite === "None"
      ? "None"
      : cookie.sameSite === "Lax"
        ? "Lax"
        : undefined;
  const normalizedDomain = cookie.domain.replace(/^\./, "");
  const path = cookie.path || "/";
  const url = `${cookie.secure === false ? "http" : "https"}://${normalizedDomain}${path.startsWith("/") ? path : `/${path}`}`;
  return {
    name: cookie.name,
    value: cookie.value,
    url,
    domain: cookie.domain,
    path,
    secure: cookie.secure !== false,
    httpOnly: !!cookie.httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(cookie.expires && cookie.expires > 0 ? { expires: cookie.expires } : {}),
  };
}

async function openBlankTarget(browserHttpBase: string): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  const res = await fetch(`${browserHttpBase}/json/new?about:blank`, {
    method: "PUT",
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`failed to create CDP target: HTTP ${res.status}`);
  const target = await res.json() as { id?: string; webSocketDebuggerUrl?: string };
  if (!target.id || !target.webSocketDebuggerUrl) throw new Error("CDP target missing websocket URL");
  return { id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function closeTarget(browserHttpBase: string, targetId: string): Promise<void> {
  try {
    await fetch(`${browserHttpBase}/json/close/${targetId}`, {
      method: "PUT",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // ignore
  }
}

async function cdpCall<T>(
  socket: WebSocket,
  pending: Map<number, { resolve: (value: T) => void; reject: (error: Error) => void }>,
  state: { nextId: number },
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const id = ++state.nextId;
  const payload = JSON.stringify({ id, method, ...(params ? { params } : {}) });
  return await new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(payload);
  });
}

export async function primeChromiumProfileContext(
  cdpUrl: string,
  cookies: PrimeableCookie[],
  options?: { keepTargetOpen?: boolean },
): Promise<{ targetId: string | null }> {
  if (cookies.length === 0) return { targetId: null };
  const browserHttpBase = httpBaseFromCdpUrl(cdpUrl);
  const target = await openBlankTarget(browserHttpBase);
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    await closeTarget(browserHttpBase, target.id);
    throw new Error("WebSocket API unavailable for CDP priming");
  }
  const socket = new WebSocketCtor(target.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const state = { nextId: 0 };
  let closed = false;
  const closePromise = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => {
      closed = true;
      resolve();
    });
  });

  socket.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (!msg.id) return;
      const handler = pending.get(msg.id);
      if (!handler) return;
      pending.delete(msg.id);
      if (msg.error) {
        handler.reject(new Error(msg.error.message || "CDP error"));
        return;
      }
      handler.resolve(msg);
    } catch {
      // ignore parse noise
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out opening CDP websocket")), 5_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("failed opening CDP websocket"));
      }, { once: true });
    });

    await cdpCall(socket, pending as never, state, "Page.enable");
    await cdpCall(socket, pending as never, state, "Network.enable");
    const setResult = await cdpCall<{ result?: { success?: boolean } }>(
      socket,
      pending as never,
      state,
      "Network.setCookies",
      { cookies: cookies.map(toCdpCookieParam) },
    );
    if (setResult.result?.success === false) throw new Error("CDP cookie priming failed");
    return { targetId: options?.keepTargetOpen ? target.id : null };
  } finally {
    try { socket.close(); } catch {}
    if (!closed) await closePromise;
    if (!options?.keepTargetOpen) {
      await closeTarget(browserHttpBase, target.id);
    }
  }
}

export async function launchChromiumProfileContext(meta: BrowserAuthSourceMeta): Promise<LaunchedProfileContext> {
  if (meta.family !== "chromium") throw new Error("profile attach only supports chromium sources");
  const binary = resolveChromiumBinary(meta.browserName);
  if (!binary) throw new Error(`no browser binary found for ${meta.browserName}`);

  const { tempDir, profileDir } = cloneChromiumProfile(meta);
  const port = await getFreePort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempDir}`,
    `--profile-directory=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  const child = spawn(binary, args, {
    stdio: "ignore",
    detached: false,
  });

  try {
    const version = await fetchChromeVersion(port);
    const cdpUrl = version.webSocketDebuggerUrl;
    if (!cdpUrl) throw new Error("profile browser missing webSocketDebuggerUrl");
    return {
      cdpUrl,
      child,
      tempDir,
    };
  } catch (error) {
    try { child.kill("SIGTERM"); } catch {}
    removeTempDirQuietly(tempDir);
    throw error;
  }
}

export async function cleanupProfileContext(ctx: LaunchedProfileContext | null | undefined): Promise<void> {
  if (!ctx) return;
  try { ctx.child.kill("SIGTERM"); } catch {}
  await waitForChildExit(ctx.child);
  removeTempDirQuietly(ctx.tempDir);
}
