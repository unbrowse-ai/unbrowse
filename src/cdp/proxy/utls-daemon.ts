// CDP_PRIMITIVES.md §spoof-surface "TLS gap" — uTLS-fronted CONNECT proxy daemon
//
// Eph 6:11-13 — "Put on the whole armor of God... and having done all, to
// stand." This wrapper boots the bundled `utls-proxy` Go binary as a local
// CONNECT proxy that re-fingerprints TLS to Chrome 131 (matching
// PINNED_CHROME_BUILD_ID in src/cdp/chrome.ts). The binary is the TLS-
// layer armor that libcurl-impersonate could not be (libcurl-impersonate
// is a curl CLIENT, not a daemon; see ./libcurl-impersonate.ts:124-130).
//
// W13.1 — real impl. Honest fall-through: if the vendored binary is
// missing for the runtime platform (e.g. an unsupported OS/arch slipped
// past build.sh), `start()` returns a 503 envelope and the caller
// degrades to iproyal-only (no TLS spoof). Never crashes.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProxyConfig } from "../types.js";

/** Env var name the spawned binary reads for upstream proxy auth. */
export const UPSTREAM_PROXY_AUTH_ENV = "UNBROWSE_UPSTREAM_PROXY_AUTH";

/** Stdout marker the Go binary emits exactly once on bind. */
const READY_MARKER = /^listening on (?<addr>[^\s]+)/m;

/** Cap how long we wait for the daemon to bind before declaring failure. */
const READY_TIMEOUT_MS = 4_000;

export interface UtlsDaemonStartResult {
  ok: true;
  /** What Chrome's --proxy-server consumes (always http://127.0.0.1:<port>). */
  localProxyUrl: string;
  /** The listening address (e.g. "127.0.0.1:54321"). */
  listenAddr: string;
  /** PID of the spawned Go binary (0 when not assigned, defensive). */
  pid: number;
  /** Absolute path to the vendored binary we launched. */
  binary: string;
  /** Kill the daemon. Idempotent. */
  stop: () => Promise<void>;
}

export interface UtlsDaemonGap {
  ok: false;
  status: 503;
  error:
    | "utls_proxy_missing"
    | "utls_proxy_spawn_failed"
    | "utls_proxy_not_ready"
    | "utls_proxy_unsupported_platform";
  hint: string;
}

export type UtlsDaemonResult = UtlsDaemonStartResult | UtlsDaemonGap;

export interface UtlsDaemonStartOpts {
  /** Upstream proxy URL (e.g. http://geo.iproyal.com:12321). Empty = direct. */
  upstream?: string | ProxyConfig;
  /** Optional upstream auth as "user:pass". Passed via env, never argv. */
  upstreamAuth?: string;
  /** Override fingerprint name (default chrome_131). */
  fingerprint?: "chrome_131" | "chrome_120" | "firefox_120" | "auto";
  /** Override listen address. Default 127.0.0.1:0 (ephemeral). */
  listen?: string;
  /** Override binary path (testing). */
  binaryPath?: string;
  /** Verbose logging on the Go side. */
  verbose?: boolean;
}

/**
 * Resolve the path to the vendored utls-proxy binary for the current
 * runtime platform. Searches three locations in order:
 *
 *   1. $UNBROWSE_UTLS_PROXY_BINARY (explicit override)
 *   2. packages/skill/vendor/utls-proxy/utls-proxy-<os>-<arch> (npm pack vendor)
 *   3. submodules/utls-proxy/dist/utls-proxy-<os>-<arch> (dev / monorepo)
 *
 * Returns null when none exist (the runtime degrades to no-TLS-spoof).
 */
export function resolveUtlsProxyBinary(): string | null {
  const override = process.env.UNBROWSE_UTLS_PROXY_BINARY;
  if (override && existsSync(override)) return override;

  const platform = process.platform; // "darwin" | "linux" | ...
  const arch = process.arch; // "arm64" | "x64" | ...
  const goarch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch;
  const binName = `utls-proxy-${platform}-${goarch}`;

  // npm-vendor path (resolved relative to this file in the published tarball)
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/cdp/proxy/utls-daemon.js → packages/skill/vendor/utls-proxy/<bin>
    // (when bundled by prepare-pack.mjs the file lives at dist/.../utls-daemon.js,
    // and packages/skill/vendor/utls-proxy/ sits two levels up from dist/)
    const vendoredCandidates = [
      resolve(here, "..", "..", "..", "vendor", "utls-proxy", binName),
      resolve(here, "..", "..", "..", "..", "vendor", "utls-proxy", binName),
      resolve(here, "..", "..", "..", "..", "..", "vendor", "utls-proxy", binName),
    ];
    for (const c of vendoredCandidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    /* fileURLToPath can throw in odd loaders; fall through to dev path */
  }

  // dev / monorepo path
  // This file lives at <repo>/src/cdp/proxy/utls-daemon.ts in source,
  // so submodules/utls-proxy/dist/<bin> is four parents up.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const devCandidates = [
      resolve(here, "..", "..", "..", "submodules", "utls-proxy", "dist", binName),
      resolve(here, "..", "..", "..", "..", "submodules", "utls-proxy", "dist", binName),
    ];
    for (const c of devCandidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    /* same fall-through */
  }

  return null;
}

/**
 * Spawn the bundled utls-proxy CONNECT daemon. Resolves once the binary
 * prints its "listening on <addr>" marker, or fails closed with a
 * structured 503 envelope.
 *
 * The caller's chain composer (./index.ts:buildProxyChain) wraps this and
 * routes Chrome's `--proxy-server=` at the returned `localProxyUrl`.
 *
 * SECURITY: the upstream proxy credential is passed via the
 * `UNBROWSE_UPSTREAM_PROXY_AUTH` env var on the child, NEVER as a
 * command-line argument — argv is visible in `ps`. Tests assert this.
 */
export async function start(opts: UtlsDaemonStartOpts = {}): Promise<UtlsDaemonResult> {
  const binary = opts.binaryPath ?? resolveUtlsProxyBinary();
  if (!binary) {
    return {
      ok: false,
      status: 503,
      error: "utls_proxy_missing",
      hint: `utls-proxy binary not found for ${process.platform}/${process.arch}. Build via 'bash submodules/utls-proxy/build.sh' (dev) or wait for a release that bundles it under packages/skill/vendor/utls-proxy/.`,
    };
  }
  if (!safelyExecutable(binary)) {
    return {
      ok: false,
      status: 503,
      error: "utls_proxy_missing",
      hint: `utls-proxy binary at ${binary} is not executable (chmod +x ${binary}).`,
    };
  }

  const upstreamUrl =
    typeof opts.upstream === "string"
      ? opts.upstream
      : opts.upstream && "server" in opts.upstream
        ? opts.upstream.server
        : undefined;

  const args: string[] = ["--listen", opts.listen ?? "127.0.0.1:0"];
  if (upstreamUrl) args.push("--upstream", upstreamUrl);
  args.push("--fingerprint", opts.fingerprint ?? "chrome_131");
  if (opts.verbose) args.push("--verbose");

  // SECURITY: never put creds in argv. Pass via env only.
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Prefer explicit opt; else fall through to inheritance from process.env.
  if (opts.upstreamAuth !== undefined) {
    env[UPSTREAM_PROXY_AUTH_ENV] = opts.upstreamAuth;
  } else if (
    typeof opts.upstream !== "string" &&
    opts.upstream &&
    "username" in opts.upstream &&
    opts.upstream.username &&
    opts.upstream.password
  ) {
    env[UPSTREAM_PROXY_AUTH_ENV] = `${opts.upstream.username}:${opts.upstream.password}`;
  }

  let proc: ChildProcess;
  try {
    proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env });
  } catch (err) {
    return {
      ok: false,
      status: 503,
      error: "utls_proxy_spawn_failed",
      hint: `spawn(${binary}) threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ready = await waitForReady(proc);
  if (!ready.ok) {
    try {
      proc.kill();
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      status: 503,
      error: "utls_proxy_not_ready",
      hint: ready.reason,
    };
  }

  const stop = async () => {
    try {
      proc.kill();
    } catch {
      /* best-effort */
    }
  };

  return {
    ok: true,
    localProxyUrl: `http://${ready.addr}`,
    listenAddr: ready.addr,
    pid: proc.pid ?? 0,
    binary,
    stop,
  };
}

function safelyExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    // posix exec bit (any). On windows we don't ship .exe yet so this is moot.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

interface ReadyOk {
  ok: true;
  addr: string;
}
interface ReadyFail {
  ok: false;
  reason: string;
}

function waitForReady(proc: ChildProcess): Promise<ReadyOk | ReadyFail> {
  return new Promise((resolveFn) => {
    let settled = false;
    const buf: string[] = [];
    const errBuf: string[] = [];

    const settle = (result: ReadyOk | ReadyFail) => {
      if (settled) return;
      settled = true;
      proc.stdout?.removeAllListeners("data");
      proc.stderr?.removeAllListeners("data");
      proc.removeAllListeners("exit");
      resolveFn(result);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      buf.push(s);
      const m = READY_MARKER.exec(buf.join(""));
      if (m?.groups?.addr) {
        settle({ ok: true, addr: m.groups.addr });
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      errBuf.push(chunk.toString("utf8"));
    });
    proc.on("exit", (code, signal) => {
      const stderr = errBuf.join("").trim();
      settle({
        ok: false,
        reason: `utls-proxy exited before ready (code=${code} signal=${signal}) ${stderr ? "stderr=" + stderr : ""}`,
      });
    });

    setTimeout(() => {
      settle({
        ok: false,
        reason: `utls-proxy did not print 'listening on ...' within ${READY_TIMEOUT_MS}ms`,
      });
    }, READY_TIMEOUT_MS).unref?.();
  });
}

/**
 * Probe whether a usable binary is on disk for the runtime platform.
 * Cheap — does not spawn. Useful for buildProxyChain to gate on.
 */
export function probeAvailable(): { available: boolean; binary?: string; hint?: string } {
  const binary = resolveUtlsProxyBinary();
  if (!binary) {
    return {
      available: false,
      hint: `utls-proxy binary not vendored for ${process.platform}/${process.arch}. Falls through to iproyal-only chain (no TLS spoof). Build via submodules/utls-proxy/build.sh.`,
    };
  }
  if (!safelyExecutable(binary)) {
    return {
      available: false,
      binary,
      hint: `binary at ${binary} is not executable.`,
    };
  }
  return { available: true, binary };
}

// Tiny dead-store to make TS happy with the unused export.
export const __vendorMarker = join("vendor", "utls-proxy");
