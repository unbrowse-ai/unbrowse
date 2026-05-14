/**
 * Local-binary lifecycle for `@unbrowse/sdk`.
 *
 * The SDK talks to a co-located `unbrowse` runtime over loopback HTTP.
 * `runtime.ts` owns the contract for locating, probing, and spawning that
 * runtime so `client.ts` can stay a pure HTTP transport.
 *
 * Tree-shaking note: heavy Node-only imports (`child_process`) are pulled
 * in lazily inside `spawnUnbrowseRuntime`. Callers that only use
 * `Unbrowse.connect` never pay for them.
 */

import { RuntimeUnavailableError } from "./errors.js";

/**
 * Handle returned by a successful spawn. `owned` distinguishes processes the
 * SDK forked (kill on `.close()`) from processes the SDK adopted via probe
 * (leave running on `.close()`).
 */
export interface RuntimeHandle {
  /** Base URL the running runtime listens on, e.g. "http://127.0.0.1:6969". */
  baseUrl: string;
  /** OS process id; -1 if the runtime was adopted via probe. */
  pid: number;
  /** Stops the runtime if `owned`; no-op otherwise. */
  kill(): Promise<void>;
  /** Resolves once the runtime answers `/health` with 200. */
  ready: Promise<void>;
  /** True iff this SDK started the process and is responsible for tearing it down. */
  owned: boolean;
}

/**
 * Options for `spawnUnbrowseRuntime`. Every field has a sensible default,
 * so the zero-arg call is the documented happy path.
 */
export interface SpawnRuntimeOptions {
  /** Preferred port; default 6969. If already alive, adopts that runtime. */
  port?: number;
  /** Working directory for the child; default = current process cwd. */
  cwd?: string;
  /** Extra env vars layered onto the child's inherited env. */
  env?: Record<string, string>;
  /** Explicit path to the binary; overrides `locateUnbrowseBinary`. */
  binaryPath?: string;
  /** Milliseconds to wait for `/health` readiness; default 10_000. */
  readyTimeoutMs?: number;
}

const DEFAULT_PORT = 6969;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/**
 * Probe an already-running runtime by hitting `/health`. Returns true iff
 * the response status is 2xx. Never throws — connection refused, timeout,
 * DNS failures, and non-2xx all resolve to `false`.
 */
export async function probeUnbrowseRuntime(
  baseUrl: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, "")}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Locate the `unbrowse` binary by walking, in order:
 *   1. `UNBROWSE_BIN` env var
 *   2. `require.resolve('unbrowse/package.json')` -> derived `bin/unbrowse-wrapper.mjs`
 *   3. `Bun.which('unbrowse')` if running under Bun
 * Returns null when nothing is wired.
 */
export function locateUnbrowseBinary(): string | null {
  // 1. Explicit env override.
  const fromEnv = readEnv("UNBROWSE_BIN");
  if (fromEnv && fileExists(fromEnv)) return fromEnv;

  // 2. require.resolve('unbrowse/package.json') -> bin/unbrowse-wrapper.mjs.
  //    Only honor this when the resolved package looks like a real install
  //    (the wrapper has a sibling native binary or compiled launcher). A
  //    bare workspace tree with no postinstall artifacts would set us up to
  //    spawn-and-fail; fall through to PATH lookup in that case.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require("node:module") as typeof import("node:module");
    const requireFn = createRequire(import.meta.url);
    const pkgPath = requireFn.resolve("unbrowse/package.json");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const binDir = path.join(path.dirname(pkgPath), "bin");
    const wrapper = path.join(binDir, "unbrowse-wrapper.mjs");
    if (fileExists(wrapper) && hasNativeSibling(binDir)) return wrapper;
  } catch {
    // peer dep not installed — fall through
  }

  // 3. Bun.which / PATH lookup.
  const bunWhich = (globalThis as { Bun?: { which?: (name: string) => string | null } }).Bun?.which;
  if (typeof bunWhich === "function") {
    const onPath = bunWhich("unbrowse");
    if (onPath && fileExists(onPath)) return onPath;
  }

  return null;
}

function hasNativeSibling(binDir: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    return fs.existsSync(path.join(binDir, "unbrowse"))
      || fs.existsSync(path.join(binDir, "unbrowse.exe"));
  } catch {
    return false;
  }
}

/**
 * Spawn (or adopt) a co-located `unbrowse` runtime and wait for it to
 * answer `/health`. Returns a `RuntimeHandle` whose `.kill()` tears the
 * child down. Throws `RuntimeUnavailableError` on failure modes.
 */
export async function spawnUnbrowseRuntime(
  opts: SpawnRuntimeOptions = {},
): Promise<RuntimeHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  // 1. If a runtime is already alive on the requested port, adopt it.
  if (await probeUnbrowseRuntime(baseUrl, DEFAULT_PROBE_TIMEOUT_MS)) {
    return {
      baseUrl,
      pid: -1,
      kill: async () => {},
      ready: Promise.resolve(),
      owned: false,
    };
  }

  // 2. Locate the binary.
  const binary = opts.binaryPath ?? locateUnbrowseBinary();
  if (!binary || !fileExists(binary)) {
    throw new RuntimeUnavailableError(
      `unbrowse binary not found${opts.binaryPath ? ` at ${opts.binaryPath}` : ""}. Install with: npm i -g unbrowse`,
      "binary_missing",
      port,
    );
  }

  // 3. Spawn via Node's child_process (cross-runtime; Bun shims this).
  //    Lazy import keeps the connect-only path tree-shakeable.
  const childProcess = await import("node:child_process");
  const env: Record<string, string> = {
    ...sanitizeEnv(process.env),
    ...(opts.env ?? {}),
    PORT: String(port),
    HOST: "127.0.0.1",
  };

  // `unbrowse-wrapper.mjs` is a node script; the global `unbrowse` binary
  // may be a wrapper or a compiled single-binary. Pass `serve` as argv[0]
  // either way — `src/single-binary.ts:106` keys on it, and the wrapper
  // forwards argv unchanged.
  const isJsLauncher = binary.endsWith(".mjs") || binary.endsWith(".js");
  const command = isJsLauncher ? process.execPath : binary;
  const args = isJsLauncher ? [binary, "serve"] : ["serve"];

  // `detached: true` puts the child in its own process group so we can
  // signal the entire group at teardown. The unbrowse wrapper fork-execs
  // a node grandchild that wouldn't otherwise receive our SIGTERM.
  const isPosix = process.platform !== "win32";
  const child = childProcess.spawn(command, args, {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: isPosix,
  });
  // Prevent the detached child from keeping the parent event loop alive.
  if (isPosix) child.unref();

  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid && isPosix) {
      try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
    }
    try { child.kill(signal); } catch { /* ignore */ }
  };

  // 4. Poll readiness up to readyTimeoutMs.
  const ready = (async () => {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new RuntimeUnavailableError(
          `unbrowse exited (code=${child.exitCode}) before reaching ready state on port ${port}`,
          "spawn_failed",
          port,
        );
      }
      if (await probeUnbrowseRuntime(baseUrl, 250)) return;
      await sleep(100);
    }
    // Timeout — tear the orphan down and surface the failure.
    signalGroup("SIGTERM");
    throw new RuntimeUnavailableError(
      `unbrowse runtime on port ${port} did not become ready within ${readyTimeoutMs}ms`,
      "spawn_failed",
      port,
    );
  })();

  try {
    await ready;
  } catch (e) {
    if (child.exitCode === null) signalGroup("SIGTERM");
    throw e;
  }

  return {
    baseUrl,
    pid: child.pid ?? -1,
    kill: async () => {
      if (child.exitCode !== null) return;
      signalGroup("SIGTERM");
      // Wait up to 2s for graceful exit; fastify close + browser shutdown
      // can take a moment.
      for (let i = 0; i < 20; i++) {
        if (child.exitCode !== null) return;
        await sleep(100);
      }
      if (child.exitCode === null) {
        signalGroup("SIGKILL");
        // Give the kernel a beat to release the listener.
        await sleep(100);
      }
    },
    ready: Promise.resolve(),
    owned: true,
  };
}

// ---- internal helpers ----

function readEnv(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (!p?.env) return undefined;
  const v = p.env[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function fileExists(p: string): boolean {
  try {
    // Lazy require keeps this file safe in non-Node runtimes that import
    // only the type definitions. `node:fs` is available wherever spawn
    // matters, so this branch is gated by the caller.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
