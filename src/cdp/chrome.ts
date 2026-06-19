// CDP_PRIMITIVES.md §chromium-binary-acquisition + §process-model — Chrome
// binary install (@puppeteer/browsers) + spawn with the v7 flag set.
//
// Hab 2:2 — write the vision plain. We pin a real Chrome buildId (NOT
// Chromium), cache under ~/.cache/unbrowse/chrome, spawn --headless=new with
// the standard background-throttle disables, then poll /json/version until
// the DevTools endpoint binds. The returned CDPConnection's onClose hook
// is wired to the spawned Process so a `using conn = await spawnChrome(...)`
// scope-exit kills the Chrome child cleanly.

import { mkdtempSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  Browser,
  CDP_WEBSOCKET_ENDPOINT_REGEX,
  computeExecutablePath,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  launch,
  type Process,
} from "@puppeteer/browsers";

import { attachWithMeta } from "./connection.js";
import type { CDPConnection, ChromeLaunchOptions } from "./types.js";

/**
 * Chrome buildId pin — re-pin per release.
 *
 * Strategy: pin a known-good Chrome-for-Testing build. The fingerprint
 * surface (sec-ch-ua brands list, GREASE) drifts with each major; bench
 * gates depend on reproducibility, so a hard pin beats `Browser.STABLE`
 * tag resolution.
 *
 * 2026-05-28 pin: 131.0.6778.85 — last LTS-class CfT build verified by W5
 * on darwin-arm64. Bump via `npx @puppeteer/browsers install chrome@stable`
 * and re-test the bench-gate.
 */
// PIN-LOCKSTEP: when this bumps, also bump:
//   1. submodules/utls-proxy/cmd/utls-proxy/main.go:resolveFingerprint (the
//      uTLS HelloChrome_* spec MUST match this major); and
//   2. submodules/utls-proxy/README.md "Fingerprint pin" section.
// Both downstream callers re-fingerprint TLS to match this build id; drift
// here means the upstream JA3/JA4 stops looking like Chrome (Eph 6:11).
export const PINNED_CHROME_BUILD_ID = "131.0.6778.85";

/**
 * Cache directory for unbrowse-managed Chrome installs.
 * Keep separate from `~/.cache/puppeteer` so puppeteer-the-product
 * doesn't share our pin.
 */
function unbrowseChromeCacheDir(): string {
  const dir = join(homedir(), ".cache", "unbrowse", "chrome");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve env-precedence headless setting (mirrors kuri convention,
 * src/kuri/client.ts:resolveKuriLaunchConfig). `KURI_HEADLESS` /
 * `HEADLESS` are still honored so v7 inherits the operator habits.
 *
 * Default = headless. An unrecognized value defaults to headless with a
 * stderr warning. Only an explicit truthy/falsy override flips the bit.
 */
export function resolveHeadlessDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.UNBROWSE_HEADLESS ?? env.KURI_HEADLESS ?? env.HEADLESS;
  if (explicit === undefined) return true;
  const v = String(explicit).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (process.stderr?.write) {
    process.stderr.write(
      `[unbrowse-cdp] Ignoring unrecognized HEADLESS value ${JSON.stringify(explicit)}; defaulting to headless=true.\n`,
    );
  }
  return true;
}

/**
 * Resolve the Chrome binary path. If the pinned buildId is not already
 * cached, installs it via @puppeteer/browsers. Idempotent.
 */
export async function ensureChrome(pinRevision?: string): Promise<string> {
  const buildId = pinRevision ?? PINNED_CHROME_BUILD_ID;
  const cacheDir = unbrowseChromeCacheDir();
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error("ensure_chrome_unsupported_platform");
  }
  // Fast-path: already installed.
  try {
    const installed = await getInstalledBrowsers({ cacheDir });
    const hit = installed.find((b) => b.browser === Browser.CHROME && b.buildId === buildId && b.platform === platform);
    if (hit && existsSync(hit.executablePath)) return hit.executablePath;
  } catch {
    // fall through to install
  }
  // Install (no progress callback — production output should be clean).
  const installed = await install({
    cacheDir,
    browser: Browser.CHROME,
    buildId,
    platform,
    unpack: true,
  });
  if (!existsSync(installed.executablePath)) {
    throw new Error(`ensure_chrome_install_failed_no_executable:${installed.executablePath}`);
  }
  return installed.executablePath;
}

/**
 * Compute the executable path without installing — used when caller asserts
 * the cache is already populated (CI, prebaked images).
 */
export function computeChromePath(buildId: string = PINNED_CHROME_BUILD_ID): string {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error("compute_chrome_path_unsupported_platform");
  return computeExecutablePath({
    cacheDir: unbrowseChromeCacheDir(),
    browser: Browser.CHROME,
    buildId,
    platform,
  });
}

/**
 * Build the v7 standard Chrome flag set. Notes:
 *  - `--headless=new` is the v7 default; v7 must NEVER pop a window
 *    onto the user's screen unless `HEADLESS=false`.
 *  - `--remote-debugging-port=0` lets Chrome pick a free port; we read
 *    it back from stderr via `CDP_WEBSOCKET_ENDPOINT_REGEX`.
 *  - The background-throttle disables are load-bearing for parallel
 *    sessions — Kuri (Phase 0d, commit db9190af) confirmed
 *    `--headless=new` renderer-backgrounds non-active tabs and
 *    starves concurrent snap.
 *  - `--proxy-server=per-context` arms per-BrowserContext proxy
 *    routing (used by target.ts:createBrowserContext when proxy
 *    config is non-null).
 */
export function buildChromeArgs(opts: {
  headless: boolean;
  userDataDir: string;
  proxy?: string;
  perContextProxy?: boolean;
  extraArgs?: string[];
}): string[] {
  const args: string[] = [
    "--remote-debugging-port=0",
    `--user-data-dir=${opts.userDataDir}`,
    // Disable renderer backgrounding so parallel targets don't starve.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache,AcceptCHFrame",
    // First-run / default-browser / metrics noise.
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-pings",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    // Stability under CI / sandboxed test runs.
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // Force a deterministic window size for screenshots / bench comparisons.
    "--window-size=1280,800",
  ];
  if (opts.headless) {
    args.push("--headless=new");
  }
  if (opts.proxy) {
    args.push(`--proxy-server=${opts.proxy}`);
  }
  // else: RAW (direct). The old `--proxy-server=per-context` branch was REMOVED
  // (2026-06-20). Standard Chrome-for-Testing does NOT support `per-context` as a
  // magic value — it treats the literal string as a proxy host, so a context with
  // no per-context proxy set (the common case for `auth-capture` / `session-restore`,
  // which create a context WITHOUT a proxy) failed EVERY navigation with
  // ERR_PROXY_CONNECTION_FAILED. The flag poisoned the browser instead of enabling
  // proxying. Per-context proxying, when genuinely needed, is set on the context via
  // Target.createBrowserContext({proxyServer: <REAL url>}) — never this launch flag.
  // `opts.perContextProxy` is now a no-op kept for call-site compatibility.
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

/**
 * Probe whether an existing CDP endpoint is reachable. Used by turbobox-VM
 * style deployments where Chrome is pre-spawned and we attach.
 */
export async function probeExistingCdp(endpoint: string): Promise<boolean> {
  try {
    let probeUrl: string;
    if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
      // Convert ws://host:port/devtools/browser/<id> → http://host:port/json/version
      const u = new URL(endpoint);
      probeUrl = `http://${u.host}/json/version`;
    } else {
      const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
      probeUrl = base + "/json/version";
    }
    const res = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn Chrome with the v7 flag set, poll for the DevTools endpoint,
 * connect, and return a CDPConnection. The connection's `.close()` (and
 * `Symbol.asyncDispose`) tears down Chrome too.
 */
export async function spawnChrome(opts: ChromeLaunchOptions = {}): Promise<CDPConnection> {
  const chromeBin = opts.chromeBin ?? (await ensureChrome());
  const headless = opts.headless ?? resolveHeadlessDefault();
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), "unbrowse-cdp-"));
  const args = buildChromeArgs({
    headless,
    userDataDir,
    proxy: opts.proxy,
    perContextProxy: opts.perContextProxy,
    extraArgs: opts.extraArgs,
  });

  // Browse-session mode: persist Chrome across this CLI process's exit so a
  // SEPARATE `eval snap` / `act click` / `act close` invocation can re-attach.
  if (opts.persist) {
    return spawnChromeDetached(chromeBin, args, userDataDir);
  }

  let proc: Process;
  try {
    proc = launch({
      executablePath: chromeBin,
      args,
      dumpio: false,
      // Detach=false on darwin/linux keeps the child in our process group so
      // `process.exit()` / SIGTERM in the parent reliably reaps the child.
      detached: false,
    });
  } catch (e) {
    throw new Error(`spawn_chrome_failed:${e instanceof Error ? e.message : String(e)}`);
  }

  let wsEndpoint: string;
  try {
    // 30s is generous on a cold install; bench probes should never see > 3s.
    wsEndpoint = await proc.waitForLineOutput(CDP_WEBSOCKET_ENDPOINT_REGEX, 30_000);
  } catch (e) {
    try {
      await proc.close();
    } catch {
      /* best-effort */
    }
    throw new Error(`spawn_chrome_no_devtools_endpoint:${e instanceof Error ? e.message : String(e)}`);
  }

  // Connect via CRI and resolve Browser.getVersion to populate the receipt
  // body (revision / userAgent are load-bearing for fingerprint pin assertions).
  let conn: CDPConnection;
  try {
    conn = await attachWithMeta(
      wsEndpoint,
      {
        chromeBin,
        pid: proc.nodeProcess.pid ?? 0,
        endpoint: wsEndpoint,
        version: "",
        revision: "",
      },
      async () => {
        try {
          await proc.close();
        } catch {
          // SIGKILL fallback (Process.close already does graceful → kill chain).
        }
      },
    );
  } catch (e) {
    try {
      await proc.close();
    } catch {
      /* best-effort */
    }
    throw new Error(`spawn_chrome_attach_failed:${e instanceof Error ? e.message : String(e)}`);
  }

  // Backfill version + revision so receipts carry the real values.
  try {
    const v = await getBrowserVersion(conn);
    // CDPConnection's readonly fields are immutable in TS but the underlying
    // object is plain — we set them once at construction-time here.
    Object.assign(conn, { version: v.version, revision: v.revision });
  } catch {
    // Non-fatal — caller can still operate the connection.
  }
  return conn;
}

/**
 * Read the DevTools ws endpoint from Chrome's own `DevToolsActivePort` file
 * (written into the user-data-dir once CDP is listening). Line 1 is the port,
 * line 2 is the browser ws path. Polled because the file appears a beat after
 * the process starts. This is how we discover the endpoint of a DETACHED Chrome
 * whose stdout/stderr we do not capture.
 */
async function readDevToolsEndpoint(userDataDir: string, timeoutMs: number): Promise<string> {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(portFile, "utf8").trim();
      const nl = raw.indexOf("\n");
      if (nl > 0) {
        const port = raw.slice(0, nl).trim();
        const path = raw.slice(nl + 1).trim();
        if (port && path) return `ws://127.0.0.1:${port}${path}`;
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("DevToolsActivePort not written within timeout");
}

/**
 * Spawn Chrome DETACHED so it OUTLIVES this CLI process. Unlike the puppeteer
 * `launch()` path (which registers a `process.on('exit', () => kill)` hook that
 * tears Chrome down when the parent calls `process.exit()`), this uses a raw
 * detached + unref'd child and discovers the endpoint via `DevToolsActivePort`.
 * The returned connection's `close()` kills the persisted Chrome (used by
 * `act close`). This realizes `act go`'s "keep Chrome alive for re-attach" intent.
 */
async function spawnChromeDetached(
  chromeBin: string,
  args: string[],
  userDataDir: string,
): Promise<CDPConnection> {
  const child = spawnProcess(chromeBin, args, { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid ?? 0;
  const killPersisted = () => {
    if (!pid) return;
    // Kill the whole process group (detached → child is its own group leader),
    // falling back to the bare pid.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };

  let wsEndpoint: string;
  try {
    wsEndpoint = await readDevToolsEndpoint(userDataDir, 30_000);
  } catch (e) {
    killPersisted();
    throw new Error(`spawn_chrome_no_devtools_endpoint:${e instanceof Error ? e.message : String(e)}`);
  }

  let conn: CDPConnection;
  try {
    conn = await attachWithMeta(
      wsEndpoint,
      { chromeBin, pid, endpoint: wsEndpoint, version: "", revision: "" },
      async () => {
        killPersisted();
      },
    );
  } catch (e) {
    killPersisted();
    throw new Error(`spawn_chrome_attach_failed:${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const v = await getBrowserVersion(conn);
    Object.assign(conn, { version: v.version, revision: v.revision });
  } catch {
    /* non-fatal */
  }
  return conn;
}

/**
 * Read Browser.getVersion off a live connection. Used for fingerprint-pin
 * assertions and the receipt body on chromium_launch.
 */
export async function getBrowserVersion(
  conn: CDPConnection,
): Promise<{ version: string; revision: string; product: string; userAgent: string; jsVersion: string }> {
  const v = await conn.call<unknown, {
    protocolVersion: string;
    product: string;
    revision: string;
    userAgent: string;
    jsVersion: string;
  }>("Browser.getVersion");
  return {
    version: v.product,
    revision: v.revision,
    product: v.product,
    userAgent: v.userAgent,
    jsVersion: v.jsVersion,
  };
}
