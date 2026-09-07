// CDP_PRIMITIVES.md §spoof-surface "TLS gap" — libcurl-impersonate front for JA3/JA4 spoof
//
// Eph 6:11 — "Put on the whole armor of God, that you may be able to stand
// against the wiles of the devil." The libcurl-impersonate proxy is the
// TLS-layer armor that CDP cannot itself wear (Chromium's TLS stack ships
// the Chrome ClientHello whether you ask it to or not — but when we route
// through a generic HTTP-CONNECT proxy, the proxy re-handshakes upstream
// and THAT handshake must look like Chrome too, not like curl).
//
// W13 — real impl with HONEST fall-through. If the binary isn't installed,
// `start()` returns `{ ok: false, status: 503, error: "libcurl_impersonate_missing" }`
// and the caller falls through to a no-TLS-spoof chain. Never crashes.

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

import type { ProxyConfig } from "../types.js";

/**
 * Known-good binary names shipped by the libcurl-impersonate / curl-impersonate
 * project + the `curl-impersonate-fork` rewrite. Search order matters: prefer
 * a Chrome-pin that matches our PINNED_CHROME_BUILD_ID major (131), then
 * fall through to any Chrome variant, then generic curl-impersonate-chrome.
 */
export const LIBCURL_IMPERSONATE_BINARY_CANDIDATES = [
  "curl_chrome131",
  "curl_chrome124",
  "curl_chrome120",
  "curl_chrome116",
  "curl_chrome110",
  "curl_chrome107",
  "curl-impersonate-chrome",
  "curl-impersonate",
];

export interface LibcurlImpersonateProbe {
  available: boolean;
  version?: string;
  binary?: string;
  hint?: string;
}

/**
 * Probe whether a libcurl-impersonate variant is on PATH. Returns the first
 * matching binary name + its --version line. Never throws.
 *
 * Install hint emitted when unavailable:
 *   macOS:  brew tap shakacode/sk  && brew install curl-impersonate
 *           (or: docker run lwthiker/curl-impersonate:0.6-chrome-slim)
 *   Linux:  curl -L -o /tmp/ci.tar.gz \
 *             https://github.com/lwthiker/curl-impersonate/releases/latest/download/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz \
 *             && tar -xzf /tmp/ci.tar.gz -C /usr/local/bin/
 */
export async function probeLibcurlImpersonateAvailable(): Promise<LibcurlImpersonateProbe> {
  for (const bin of LIBCURL_IMPERSONATE_BINARY_CANDIDATES) {
    const v = await tryVersion(bin);
    if (v.ok) {
      return { available: true, version: v.version, binary: bin };
    }
  }
  return {
    available: false,
    hint: "libcurl-impersonate not on PATH. Install: `brew tap shakacode/sk && brew install curl-impersonate` (mac) OR `curl -L https://github.com/lwthiker/curl-impersonate/releases/latest/download/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz | tar -xz -C /usr/local/bin` (linux). Falls through to no-TLS-spoof mode.",
  };
}

function tryVersion(bin: string): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const settle = (ok: boolean, version?: string) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* best-effort */
      }
      resolve({ ok, version });
    };
    child.on("error", () => settle(false));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code === 0 && /curl|libcurl/i.test(stdout)) {
        settle(true, stdout.split(/\r?\n/)[0]?.trim());
      } else {
        settle(false);
      }
    });
    setTimeout(() => settle(false), 2000).unref?.();
  });
}

export type LibcurlImpersonateStartResult =
  | {
      ok: true;
      proxy: ProxyConfig;
      localProxyUrl: string;
      upstreamProxyUrl?: string;
      pid: number;
      listenPort: number;
      binary: string;
      stop: () => Promise<void>;
    }
  | {
      ok: false;
      status: 503;
      error: "libcurl_impersonate_missing" | "libcurl_impersonate_not_a_proxy" | "libcurl_impersonate_spawn_failed";
      hint: string;
    };

/**
 * Start a local libcurl-impersonate-shaped HTTP proxy in front of an
 * upstream (e.g. iproyal residential). The chain becomes:
 *
 *     Chrome (CDP)
 *       → --proxy-server=http://127.0.0.1:<listenPort>  (this proxy)
 *         → upstream iproyal (TLS re-handshaken with Chrome JA3/JA4)
 *           → real internet
 *
 * IMPORTANT — honest scope of W13: curl-impersonate is a CLIENT, not a
 * proxy daemon. It re-emits Chrome's TLS ClientHello on outbound requests
 * it itself makes; it does NOT natively run as an `--proxy-server` target.
 * The fully-real version of this primitive is a small Go/Rust JA3-proxy
 * (e.g. https://github.com/refraction-networking/utls + a CONNECT shim)
 * that uses uTLS to emit the Chrome ClientHello upstream. The binary is
 * out of scope for W13 — that's W14's wedge.
 *
 * What W13 ships:
 *   1. The probe (real) — `probeLibcurlImpersonateAvailable()`.
 *   2. The composition surface (real) — `buildProxyChain()` returns the
 *      right ProxyChain shape so the rest of the v7 surface compiles
 *      against it.
 *   3. Honest fall-through (real) — when the binary is missing OR when no
 *      proxy-daemon variant is installed, this function returns the
 *      structured 503 envelope and the caller skips TLS spoof.
 *   4. A real spawn path is wired for the future case where a user
 *      installs a JA3-proxy variant at one of the names above AND sets
 *      `UNBROWSE_LIBCURL_IMPERSONATE_PROXY_MODE=1` (opt-in). Until W14
 *      ships the bundled JA3-proxy, this path stays disabled.
 *
 * This shape is the canonical "honest scaffold + bench-gate corpus where
 * not" pattern from CLAUDE.md — every fall-through is a structured
 * envelope, never a crash, never a silent.
 */
export async function start(opts: {
  upstream?: ProxyConfig;
  listenPort?: number;
  chromeMajor?: number;
}): Promise<LibcurlImpersonateStartResult> {
  const probe = await probeLibcurlImpersonateAvailable();
  if (!probe.available || !probe.binary) {
    return {
      ok: false,
      status: 503,
      error: "libcurl_impersonate_missing",
      hint:
        probe.hint ??
        "libcurl-impersonate not on PATH; install via brew (mac) or release tarball (linux).",
    };
  }

  // Even when the binary IS present, plain curl-impersonate is a client,
  // not a proxy daemon. Until a JA3-proxy variant lands, the only honest
  // answer is to acknowledge the binary exists but refuse to mis-spawn it.
  // The caller logs once and falls through.
  if (process.env.UNBROWSE_LIBCURL_IMPERSONATE_PROXY_MODE !== "1") {
    return {
      ok: false,
      status: 503,
      error: "libcurl_impersonate_not_a_proxy",
      hint: `${probe.binary} is a curl client, not an HTTP proxy daemon. W14 will ship a uTLS-fronted JA3 proxy. Set UNBROWSE_LIBCURL_IMPERSONATE_PROXY_MODE=1 to opt in to the experimental local spawn (currently a no-op).`,
    };
  }

  // Experimental opt-in path: try to spawn whatever is at the binary name
  // (some forks DO ship a proxy mode under a similar name, e.g.
  // `curl-impersonate-chrome --proxy-mode --listen 127.0.0.1:PORT`).
  // Honest fall-through if it doesn't bind a port.
  const listenPort = opts.listenPort ?? (await findFreePort());
  let proc: ChildProcess;
  try {
    proc = spawn(
      probe.binary,
      [
        "--proxy-mode",
        "--listen",
        `127.0.0.1:${listenPort}`,
        ...(opts.upstream ? ["--upstream", opts.upstream.server] : []),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    return {
      ok: false,
      status: 503,
      error: "libcurl_impersonate_spawn_failed",
      hint: `spawn(${probe.binary}) threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Wait up to 3s for the listener to bind; if it doesn't, fall through.
  const bound = await waitForPort(listenPort, 3000);
  if (!bound) {
    try {
      proc.kill();
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      status: 503,
      error: "libcurl_impersonate_not_a_proxy",
      hint: `${probe.binary} did not bind 127.0.0.1:${listenPort} within 3s. This binary is likely a client-only variant. W14 will ship a uTLS-fronted JA3 proxy.`,
    };
  }

  const localProxyUrl = `http://127.0.0.1:${listenPort}`;
  const upstreamProxyUrl = opts.upstream?.server;
  return {
    ok: true,
    proxy: { server: localProxyUrl },
    localProxyUrl,
    upstreamProxyUrl,
    pid: proc.pid ?? 0,
    listenPort,
    binary: probe.binary,
    stop: async () => {
      try {
        proc.kill();
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Legacy alias — preserved for any caller that imports the old name.
 */
export async function spawnLibcurlImpersonateFront(opts: {
  upstream: ProxyConfig;
  listenPort?: number;
  chromeMajor?: number;
}): Promise<LibcurlImpersonateStartResult> {
  return start(opts);
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createConnection({ port: 0 });
    srv.on("error", () => {
      // createConnection isn't a listener — use net.createServer instead.
      // We accept the loop-fallback shape: pick a random ephemeral port.
      resolve(40000 + Math.floor(Math.random() * 10000));
    });
    // The createConnection above will fail; we just want any ephemeral.
    // Use net.createServer for a real free-port probe.
    srv.destroy();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("node:net") as typeof import("node:net");
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr && "port" in addr) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("findFreePort_failed")));
      }
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const sock = createConnection({ host: "127.0.0.1", port });
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        try {
          sock.destroy();
        } catch {
          /* best-effort */
        }
        if (ok) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(tick, 100).unref?.();
      };
      sock.on("connect", () => finish(true));
      sock.on("error", () => finish(false));
    };
    tick();
  });
}
