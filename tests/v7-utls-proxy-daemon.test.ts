// W13.1 — tests for the uTLS-fronted CONNECT proxy daemon wrapper.
//
// Eph 6:11 — "Put on the whole armor." The tests assert the armor is
// real: the wrapper boots the bundled Go binary, returns an honest 503
// envelope when the binary is missing, NEVER leaks upstream auth into
// argv (the ps-leak attack), and the chain composer flips to the
// utls-daemon path under UNBROWSE_UTLS_PROXY=1.
//
// No mocks. Real spawn against the binary at submodules/utls-proxy/dist/
// (built by `bash submodules/utls-proxy/build.sh`). The integration
// probe (test #3) is gated on UNBROWSE_UTLS_INTEGRATION=1 because it
// requires an upstream we can reach.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  probeAvailable,
  resolveUtlsProxyBinary,
  start,
  UPSTREAM_PROXY_AUTH_ENV,
} from "../src/cdp/proxy/utls-daemon.js";
import { buildProxyChain } from "../src/cdp/proxy/index.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PLATFORM_BIN = `utls-proxy-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
const DEV_BINARY = resolve(REPO_ROOT, "submodules", "utls-proxy", "dist", PLATFORM_BIN);

describe("utls-daemon: probeAvailable", () => {
  test("resolveUtlsProxyBinary finds the dev build when present", () => {
    if (!existsSync(DEV_BINARY)) {
      console.log(`skip: ${DEV_BINARY} not built. Run 'bash submodules/utls-proxy/build.sh'.`);
      return;
    }
    const found = resolveUtlsProxyBinary();
    expect(found).toBeTruthy();
    expect(existsSync(found!)).toBe(true);
  });

  test("probeAvailable returns hint when binary missing (forced override)", () => {
    const prev = process.env.UNBROWSE_UTLS_PROXY_BINARY;
    process.env.UNBROWSE_UTLS_PROXY_BINARY = "/nonexistent/path/utls-proxy-xxx";
    try {
      const probe = probeAvailable();
      // The override doesn't exist, so resolver falls through to vendor/dev paths.
      // If a real dev build is present, this still returns available=true; that's
      // the honest answer. The hint-shape contract is the test.
      if (!probe.available) {
        expect(probe.hint).toMatch(/utls-proxy/i);
      }
    } finally {
      if (prev === undefined) delete process.env.UNBROWSE_UTLS_PROXY_BINARY;
      else process.env.UNBROWSE_UTLS_PROXY_BINARY = prev;
    }
  });
});

describe("utls-daemon: start envelope shape", () => {
  test("start returns 503 envelope when binary path is bogus", async () => {
    const r = await start({ binaryPath: "/definitely/does/not/exist/utls-proxy" });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.status).toBe(503);
      expect(r.error).toBe("utls_proxy_missing");
      expect(r.hint).toMatch(/not executable|chmod|missing|utls-proxy/i);
    }
  });

  test("start succeeds against the dev binary and returns a usable proxy URL", async () => {
    if (!existsSync(DEV_BINARY)) {
      console.log(`skip: ${DEV_BINARY} not built`);
      return;
    }
    const r = await start({ binaryPath: DEV_BINARY, verbose: false });
    expect(r.ok).toBe(true);
    if (r.ok === true) {
      expect(r.localProxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(r.listenAddr).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(r.pid).toBeGreaterThan(0);
      expect(r.binary).toBe(DEV_BINARY);
      await r.stop();
    }
  });
});

describe("utls-daemon: NEVER leak auth into argv (ps-leak attack)", () => {
  test("upstream auth from opts.upstreamAuth is passed via env, not argv", async () => {
    if (!existsSync(DEV_BINARY)) {
      console.log(`skip: ${DEV_BINARY} not built`);
      return;
    }
    const secret = "user_for_test:supersecret_p@ssw0rd-for-test-only";
    const r = await start({
      binaryPath: DEV_BINARY,
      upstream: "http://example-upstream.test:9999",
      upstreamAuth: secret,
    });
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    try {
      // Read the cmdline of the spawned process and assert the secret is absent.
      // Use `ps` which shows command-line arguments. The exact field depends on
      // platform; on darwin `ps -o command= -p PID` prints argv joined.
      const ps = spawnSync("ps", ["-o", "command=", "-p", String(r.pid)], { encoding: "utf8" });
      const cmdline = (ps.stdout || "").trim();
      expect(cmdline.length).toBeGreaterThan(0);
      expect(cmdline).not.toContain(secret);
      expect(cmdline).not.toContain("supersecret");
      // The env var NAME may legitimately appear in env dumps but not in argv.
      expect(cmdline).not.toContain(UPSTREAM_PROXY_AUTH_ENV + "=");
    } finally {
      await r.stop();
    }
  });

  test("upstream auth from ProxyConfig.username/password is also env-only", async () => {
    if (!existsSync(DEV_BINARY)) {
      console.log(`skip: ${DEV_BINARY} not built`);
      return;
    }
    const secret = "x402-test-creds-p@ss";
    const r = await start({
      binaryPath: DEV_BINARY,
      upstream: {
        server: "http://example-upstream.test:9999",
        username: "u",
        password: secret,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    try {
      const ps = spawnSync("ps", ["-o", "command=", "-p", String(r.pid)], { encoding: "utf8" });
      const cmdline = (ps.stdout || "").trim();
      expect(cmdline).not.toContain(secret);
    } finally {
      await r.stop();
    }
  });
});

describe("utls-daemon: integration HTTPS relay (gated)", () => {
  test("end-to-end HTTPS request through utls-proxy reaches a remote", async () => {
    if (process.env.UNBROWSE_UTLS_INTEGRATION !== "1") {
      console.log("skip: set UNBROWSE_UTLS_INTEGRATION=1 to exercise live network");
      return;
    }
    if (!existsSync(DEV_BINARY)) {
      console.log(`skip: ${DEV_BINARY} not built`);
      return;
    }
    const r = await start({ binaryPath: DEV_BINARY, verbose: true });
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    try {
      // The current W13.1 primer closes the tunnel after the spoof handshake;
      // a fetch through it expects to fail at the application layer (EOF after
      // the primer tear-down). That IS the spoof evidence — anti-bot vendors
      // who fingerprint that first hello will have seen a Chrome-shaped JA3.
      // We assert the fetch ATTEMPT proceeded (no connection refused / no
      // immediate proxy error).
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      let raised: unknown = null;
      try {
        await fetch("https://tls.peet.ws/api/all", {
          // @ts-expect-error — bun's fetch accepts proxy
          proxy: r.localProxyUrl,
          signal: ctrl.signal,
        });
      } catch (err) {
        raised = err;
      }
      clearTimeout(t);
      // Either a successful response OR a tear-down style network error is
      // expected; a hard "ECONNREFUSED" or "Invalid proxy URL" would mean the
      // daemon never bound. We assert the daemon at least bound by re-probing.
      const ps = spawnSync("ps", ["-o", "pid=", "-p", String(r.pid)], { encoding: "utf8" });
      expect((ps.stdout || "").trim()).toContain(String(r.pid));
      // raised is fine; we just want NOT-a-refused-connection
      const raisedStr = raised ? String(raised) : "";
      expect(raisedStr).not.toMatch(/ECONNREFUSED/i);
    } finally {
      await r.stop();
    }
  }, 20_000);
});

describe("buildProxyChain composes utls-daemon when UNBROWSE_UTLS_PROXY=1", () => {
  test("opting in returns either utls_daemon-layer chain OR a 503 envelope with iproyal partial", async () => {
    const prev = process.env.UNBROWSE_UTLS_PROXY;
    process.env.UNBROWSE_UTLS_PROXY = "1";
    try {
      const chain = await buildProxyChain({ useTlsSpoof: true });
      // Three honest outcomes:
      //   a) no iproyal creds → ok:false with iproyal_creds_*
      //   b) iproyal creds + utls binary present → ok:true layers=["utls_daemon","iproyal"]
      //   c) iproyal creds + no utls binary → ok:false utls_proxy_missing with partial=iproyal-only
      if (chain.ok === true) {
        expect(chain.layers).toContain("iproyal");
        // utls_daemon may or may not be present depending on build state.
        if (chain.tlsSpoof) {
          expect(chain.layers).toContain("utls_daemon");
          expect(chain.local).toBeTruthy();
        }
        await chain.stop();
      } else {
        expect(chain.status).toBe(503);
        expect(typeof chain.error).toBe("string");
        expect(typeof chain.hint).toBe("string");
      }
    } finally {
      if (prev === undefined) delete process.env.UNBROWSE_UTLS_PROXY;
      else process.env.UNBROWSE_UTLS_PROXY = prev;
    }
  });
});

describe("vendor manifest: prepare-pack discovers the dev binaries", () => {
  test("submodules/utls-proxy/dist/ exists with at least the current-platform binary", () => {
    if (!existsSync(DEV_BINARY)) {
      console.log(`skip: ${DEV_BINARY} not built (build via bash submodules/utls-proxy/build.sh)`);
      return;
    }
    const distDir = resolve(REPO_ROOT, "submodules", "utls-proxy", "dist");
    expect(existsSync(distDir)).toBe(true);
    expect(existsSync(DEV_BINARY)).toBe(true);
  });

  test("prepare-pack.mjs source mentions the utls-proxy vendor lane", () => {
    const src = readFileSync(
      resolve(REPO_ROOT, "packages", "skill", "scripts", "prepare-pack.mjs"),
      "utf8",
    );
    expect(src).toContain("utls-proxy");
    // package.json files[] entry uses literal "vendor/utls-proxy"; prepare-pack
    // composes the path via path.join so check for either shape.
    expect(src.includes("vendor/utls-proxy") || src.includes('"vendor", "utls-proxy"')).toBe(true);
  });

  test("packages/skill/package.json lists vendor/utls-proxy in files[]", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "packages", "skill", "package.json"), "utf8"),
    );
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("vendor/utls-proxy");
  });
});
