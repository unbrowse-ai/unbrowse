import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import * as kuri from "../src/kuri/client.js";

const originalKuriBin = process.env.KURI_BIN;
const originalPackageRoot = process.env.UNBROWSE_PACKAGE_ROOT;
const originalDisableCdpAttach = process.env.KURI_DISABLE_CDP_ATTACH;
const originalExternalPort = process.env.KURI_EXTERNAL_PORT;
const originalCdpUrl = process.env.CDP_URL;
const tmpDirs: string[] = [];
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function waitForPortDown(port: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} stayed up after ${timeoutMs}ms`);
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalKuriBin === undefined) delete process.env.KURI_BIN;
  else process.env.KURI_BIN = originalKuriBin;
  if (originalPackageRoot === undefined) delete process.env.UNBROWSE_PACKAGE_ROOT;
  else process.env.UNBROWSE_PACKAGE_ROOT = originalPackageRoot;
  if (originalDisableCdpAttach === undefined) delete process.env.KURI_DISABLE_CDP_ATTACH;
  else process.env.KURI_DISABLE_CDP_ATTACH = originalDisableCdpAttach;
  if (originalExternalPort === undefined) delete process.env.KURI_EXTERNAL_PORT;
  else process.env.KURI_EXTERNAL_PORT = originalExternalPort;
  if (originalCdpUrl === undefined) delete process.env.CDP_URL;
  else process.env.CDP_URL = originalCdpUrl;
  kuri.setCdpPortForTests(null);
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  await kuri.stop();
});

describe("kuri client", () => {
  it("fails cleanly when the kuri binary is missing", async () => {
    await kuri.stop();
    process.env.KURI_BIN = "/tmp/definitely-missing-kuri-binary";
    process.env.KURI_DISABLE_CDP_ATTACH = "1";
    await expect(kuri.start(43990 + (process.pid % 1000))).rejects.toThrow("Kuri binary not found");
  });

  it("prefers a packaged Kuri binary when present", () => {
    delete process.env.KURI_BIN;
    const packageRoot = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-package-"));
    tmpDirs.push(packageRoot);
    process.env.UNBROWSE_PACKAGE_ROOT = packageRoot;

    const target = process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin" && process.arch === "x64"
        ? "darwin-x64"
        : process.platform === "linux" && process.arch === "arm64"
          ? "linux-arm64"
          : process.platform === "linux" && process.arch === "x64"
            ? "linux-x64"
            : null;

    if (!target) return;

    const binaryPath = path.join(packageRoot, "vendor", "kuri", target, process.platform === "win32" ? "kuri.exe" : "kuri");
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);

    expect(kuri.findKuriBinary()).toBe(binaryPath);
    expect(kuri.findKuriBinary()).toBe(binaryPath);
  });

  it("finds the vendored Kuri binary one level up when packageRoot is the bundled runtime dir", () => {
    // Regression: the published/dev layout ships the runtime under
    // `<pkg>/runtime/` (its own package.json), so getPackageRoot() lands on the
    // runtime dir while vendor/kuri lives at `<pkg>/vendor/kuri/`. The broker
    // resolver must probe the parent, not only packageRoot itself.
    delete process.env.KURI_BIN;
    const pkg = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-runtime-"));
    tmpDirs.push(pkg);
    const runtimeRoot = path.join(pkg, "runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    process.env.UNBROWSE_PACKAGE_ROOT = runtimeRoot;

    const target = process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin" && process.arch === "x64"
        ? "darwin-x64"
        : process.platform === "linux" && process.arch === "arm64"
          ? "linux-arm64"
          : process.platform === "linux" && process.arch === "x64"
            ? "linux-x64"
            : null;
    if (!target) return;

    // Binary lives at the PARENT of the runtime dir (where getPackageRoot stops).
    const binaryPath = path.join(pkg, "vendor", "kuri", target, process.platform === "win32" ? "kuri.exe" : "kuri");
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);

    expect(kuri.getKuriBinaryCandidates()).toContain(binaryPath);
    expect(kuri.findKuriBinary()).toBe(binaryPath);
  });

  it("retries spawn when kuri exits immediately and fails after max attempts", async () => {
    // A binary that exits with code 1 immediately simulates the LinkedIn spawn failure
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-retry-"));
    tmpDirs.push(tmpDir);
    const fakeBin = path.join(tmpDir, "kuri");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeBin, 0o755);
    process.env.KURI_BIN = fakeBin;
    process.env.KURI_DISABLE_CDP_ATTACH = "1";

    // Should retry 3 times (4 attempts total) and throw a descriptive error
    await expect(kuri.start(7798)).rejects.toThrow(/failed to start after 4 attempts/i);
  }, 30_000);

  it("coalesces concurrent start calls into one spawn loop", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-lock-"));
    tmpDirs.push(tmpDir);
    const fakeBin = path.join(tmpDir, "kuri");
    const counterFile = path.join(tmpDir, "counter.txt");
    writeFileSync(counterFile, "0\n");
    writeFileSync(fakeBin, `#!/bin/sh
count="$(cat "${counterFile}")"
count=$((count + 1))
echo "$count" > "${counterFile}"
exit 1
`);
    chmodSync(fakeBin, 0o755);
    process.env.KURI_BIN = fakeBin;
    process.env.KURI_DISABLE_CDP_ATTACH = "1";

    const results = await Promise.allSettled([
      kuri.start(7797),
      kuri.start(7797),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(Number(readFileSync(counterFile, "utf8").trim())).toBe(4);
  }, 30_000);

  it("rechecks health when cached ready state points at a dead kuri port", async () => {
    const fakeHealthServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });

    await new Promise<void>((resolve) => fakeHealthServer.listen(7795, "127.0.0.1", () => resolve()));

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-stale-"));
    tmpDirs.push(tmpDir);
    const fakeBin = path.join(tmpDir, "kuri");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeBin, 0o755);
    process.env.KURI_BIN = fakeBin;
    process.env.KURI_DISABLE_CDP_ATTACH = "1";
    process.env.KURI_EXTERNAL_PORT = "7795";
    process.env.CDP_URL = "ws://127.0.0.1:9222/devtools/browser/test";

    await kuri.start(7795);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await new Promise<void>((resolve, reject) => fakeHealthServer.close((err) => err ? reject(err) : resolve()));
    await waitForPortDown(7795);
    await new Promise((resolve) => setTimeout(resolve, 0));

    delete process.env.KURI_EXTERNAL_PORT;
    delete process.env.CDP_URL;
    await expect(kuri.start(7795)).rejects.toThrow(/failed to start after 4 attempts/i);
  }, 30_000);

  it("falls back to raw Chrome CDP tab creation when /tab/new fails", async () => {
    let cdpCreated = false;

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "http://127.0.0.1:7794/health") {
        return jsonResponse({ ok: true, tabs: cdpCreated ? 1 : 0 });
      }
      if (url === "http://127.0.0.1:9222/json/version") {
        return jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test" });
      }
      if (url.startsWith("http://127.0.0.1:7794/discover")) {
        return jsonResponse({ ok: true });
      }
      if (url === "http://127.0.0.1:7794/tabs") {
        return jsonResponse(cdpCreated ? [{ id: "cdp-tab", url: "about:blank" }] : []);
      }
      if (url.startsWith("http://127.0.0.1:7794/tab/new")) {
        return jsonResponse({ error: "Target.createTarget failed" });
      }
      if (url === "http://127.0.0.1:9222/json/new?about:blank") {
        expect(init?.method).toBe("PUT");
        cdpCreated = true;
        return jsonResponse({ id: "cdp-tab" });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await kuri.start(7794);
    await expect(kuri.newTab("about:blank")).resolves.toBe("cdp-tab");
  });

  it("returns the same broker client for the same port and distinct clients for different ports", () => {
    const first = kuri.getKuriClient(7811);
    const second = kuri.getKuriClient(7811);
    const third = kuri.getKuriClient(7812);

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first.getPort()).toBe(7811);
    expect(third.getPort()).toBe(7812);
  });

  it("unwraps broker Runtime.evaluate envelopes for text and markdown helpers", async () => {
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/text")) {
        return jsonResponse({
          id: 1,
          result: {
            result: {
              type: "string",
              value: "hello from text",
            },
          },
        });
      }
      if (url.includes("/markdown")) {
        return jsonResponse({
          id: 2,
          result: {
            result: {
              type: "string",
              value: "# hello from markdown",
            },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(kuri.getText("tab-1")).resolves.toBe("hello from text");
    await expect(kuri.getMarkdown("tab-1")).resolves.toBe("# hello from markdown");
  });

  it("drops a cached broker client after stop so the next lookup gets a fresh state object", async () => {
    const first = kuri.getKuriClient(7813);
    await first.stop();
    const second = kuri.getKuriClient(7813);

    expect(second).not.toBe(first);
    expect(second.getPort()).toBe(7813);
  });

  it("runs independent start loops for different broker ports", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-multiport-"));
    tmpDirs.push(tmpDir);
    const fakeBin = path.join(tmpDir, "kuri");
    writeFileSync(fakeBin, `#!/bin/sh
counter_file="${tmpDir}/counter-$PORT.txt"
[ -f "$counter_file" ] || echo "0" > "$counter_file"
count="$(cat "$counter_file")"
count=$((count + 1))
echo "$count" > "$counter_file"
exit 1
`);
    chmodSync(fakeBin, 0o755);
    process.env.KURI_BIN = fakeBin;
    process.env.KURI_DISABLE_CDP_ATTACH = "1";

    const basePort = 43000 + (process.pid % 1000);
    const clientA = kuri.getKuriClient(basePort);
    const clientB = kuri.getKuriClient(basePort + 1);
    const results = await Promise.allSettled([
      clientA.start(),
      clientB.start(),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(Number(readFileSync(path.join(tmpDir, `counter-${basePort}.txt`), "utf8").trim())).toBe(4);
    expect(Number(readFileSync(path.join(tmpDir, `counter-${basePort + 1}.txt`), "utf8").trim())).toBe(4);

    await Promise.allSettled([clientA.stop(), clientB.stop()]);
  }, 30_000);
  it("derives launch mode from env flags", () => {
    expect(kuri.resolveKuriLaunchConfig({
      HEADLESS: "true",
    } as NodeJS.ProcessEnv)).toEqual({
      headless: true,
      attachToExistingChrome: true,
    });

    expect(kuri.resolveKuriLaunchConfig({
      KURI_HEADLESS: "1",
      KURI_DISABLE_CDP_ATTACH: "1",
    } as NodeJS.ProcessEnv)).toEqual({
      headless: true,
      attachToExistingChrome: false,
    });

    // New contract (Jun 2026): headless defaults to true on every platform so
    // production unbrowse never floods the user's screen. Attach-to-existing-Chrome
    // defaults on; clean-room callers opt out explicitly.
    expect(kuri.resolveKuriLaunchConfig({} as NodeJS.ProcessEnv)).toEqual({
      headless: true,
      attachToExistingChrome: true,
    });

    // HEADLESS=false is independent of attach; default attach still applies.
    expect(kuri.resolveKuriLaunchConfig({
      HEADLESS: "false",
      UNBROWSE_IMPORT_BROWSER_COOKIES: "0",
    } as NodeJS.ProcessEnv)).toEqual({
      headless: false,
      attachToExistingChrome: true,
    });

    expect(kuri.resolveKuriLaunchConfig({
      HEADLESS: "false",
      KURI_ATTACH_EXISTING_CHROME: "1",
    } as NodeJS.ProcessEnv)).toEqual({
      headless: false,
      attachToExistingChrome: true,
    });

    // Clean-room overrides attach intent; HEADLESS=false here only proves clean-room
    // wins over attach when both are requested.
    expect(kuri.resolveKuriLaunchConfig({
      HEADLESS: "false",
      UNBROWSE_LOCAL_ONLY: "1",
    } as NodeJS.ProcessEnv)).toEqual({
      headless: false,
      attachToExistingChrome: false,
    });
  });

  it("launches fallback user Chrome with keychain-safe CDP flags", () => {
    const args = kuri.chromeCdpAttachLaunchArgs(9223, "darwin");
    expect(args).toContain("--remote-debugging-port=9223");
    expect(args).toContain("--password-store=basic");
    expect(args).toContain("--disable-save-password-bubble");
    expect(args).toContain("--use-mock-keychain");
    expect(args.some((arg) => arg.includes("PasswordManagerOnboarding"))).toBe(true);
  });

  it("reuses a surviving managed Chrome even when ambient CDP attach is disabled", () => {
    expect(kuri.shouldReuseManagedChrome(
      { headless: true, attachToExistingChrome: false },
      { cdpPort: 9224, managedChrome: true },
      true,
    )).toBe(true);

    expect(kuri.shouldReuseManagedChrome(
      { headless: true, attachToExistingChrome: false },
      { cdpPort: 9224, managedChrome: false },
      true,
    )).toBe(false);

    expect(kuri.shouldReuseManagedChrome(
      { headless: false, attachToExistingChrome: true },
      { cdpPort: 9224, managedChrome: true },
      true,
    )).toBe(false);
  });

  // U-4: a healthy broker with no process handle is FOREIGN (owned by another
  // process, e.g. `act serve`). In attach mode it must be reused cooperatively,
  // NOT terminated — terminating it is the U-4 crash.
  it("reuses (never terminates) a healthy FOREIGN broker in attach mode", async () => {
    const seen: string[] = [];
    const state = {
      process: null,
      port: 7700,
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 7700,
    };

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: false, attachToExistingChrome: true },
      {
        isHealthyPort: async () => true,
        discoverCdpPort: async () => { seen.push("discover-cdp"); },
        ensureUserChromeRunning: async () => { seen.push("ensure-user-chrome"); },
        ensureTabsDiscovered: async () => { seen.push("discover-tabs"); },
        listTabs: async () => [],
        terminateBrokerOnPort: async () => { seen.push("terminate-broker"); },
      },
    );

    expect(reused).toBe(true);
    expect(state.ready).toBe(true);
    // The foreign broker is NEVER terminated.
    expect(seen).not.toContain("terminate-broker");
  });

  // The self-owned recycle path: a broker THIS process spawned (process handle
  // present) whose CDP+tabs are gone IS torn down via its own child handle
  // (SIGTERM), never via lsof-on-port. That distinction is what keeps capture
  // from killing serve.
  it("recycles a SELF-OWNED healthy broker that has lost both CDP and tabs (via its own handle)", async () => {
    const seen: string[] = [];
    let killSignal: string | null = null;
    const fakeChild = {
      kill: (sig: string) => { killSignal = sig; return true; },
      exitCode: 0,
      signalCode: null,
      once: (_e: string, cb: () => void) => { cb(); },
      on: (_e: string, cb: () => void) => { cb(); },
    };
    const state = {
      process: fakeChild,
      port: 7700,
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 7700,
    };

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: false, attachToExistingChrome: true },
      {
        isHealthyPort: async () => true,
        discoverCdpPort: async () => { seen.push("discover-cdp"); },
        ensureUserChromeRunning: async () => { seen.push("ensure-user-chrome"); },
        ensureTabsDiscovered: async () => { seen.push("discover-tabs"); },
        listTabs: async () => [],
        terminateBrokerOnPort: async () => { seen.push("terminate-broker"); },
      },
    );

    expect(reused).toBe(false);
    expect(state.ready).toBe(false);
    expect(killSignal).toBe("SIGTERM");
    // lsof-on-port termination is NEVER used, even for a self-owned broker.
    expect(seen).not.toContain("terminate-broker");
  });

  it("clean-room opt-out does not discover or reuse ambient CDP", async () => {
    const seen: string[] = [];
    const state = {
      process: null,
      port: 7700,
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 7700,
    };

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: true, attachToExistingChrome: false },
      {
        isHealthyPort: async () => true,
        discoverCdpPort: async (nextState) => {
          seen.push("discover-cdp");
          nextState.cdpPort = 9223;
        },
        ensureTabsDiscovered: async () => { seen.push("discover-tabs"); },
        listTabs: async () => [],
        terminateBrokerOnPort: async () => { seen.push("terminate-broker"); },
      },
    );

    // U-4: clean-room does not reuse the foreign broker, but it must NOT
    // terminate it either — the spawn path brings up its own broker instead.
    expect(reused).toBe(false);
    expect(state.cdpPort).toBe(null);
    expect(seen).not.toContain("terminate-broker");
  });

  it("keeps a healthy broker when user Chrome is restored during reuse", async () => {
    const state = {
      process: null,
      port: 7700,
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 7700,
    };

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: false, attachToExistingChrome: true },
      {
        isHealthyPort: async () => true,
        isChromeCdpAvailable: async (port) => port === 9222,
        discoverCdpPort: async () => {},
        ensureUserChromeRunning: async (nextState) => {
          nextState.cdpPort = 9222;
        },
        ensureTabsDiscovered: async () => {},
        listTabs: async () => [],
        terminateBrokerOnPort: async () => {
          throw new Error("should not terminate a revived broker");
        },
      },
    );

    expect(reused).toBe(true);
    expect(state.ready).toBe(true);
    expect(state.cdpPort).toBe(9222);
  });

  // U-4: stale tabs on a FOREIGN broker (no process handle) → reuse, not kill.
  it("reuses (never terminates) a healthy FOREIGN broker with only stale tabs in attach mode", async () => {
    const seen: string[] = [];
    const state = {
      process: null,
      port: 7700,
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 7700,
    };

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: false, attachToExistingChrome: true },
      {
        isHealthyPort: async () => true,
        discoverCdpPort: async () => { seen.push("discover-cdp"); },
        ensureUserChromeRunning: async () => { seen.push("ensure-user-chrome"); },
        ensureTabsDiscovered: async () => { seen.push("discover-tabs"); },
        listTabs: async () => [{ id: "stale-tab", url: "https://www.linkedin.com/feed/" }],
        terminateBrokerOnPort: async () => { seen.push("terminate-broker"); },
      },
    );

    expect(reused).toBe(true);
    expect(state.ready).toBe(true);
    expect(seen).not.toContain("terminate-broker");
  });

  it("reuses (never terminates) a healthy FOREIGN broker when Chrome launch leaves a non-responsive CDP port", async () => {
    const seen: string[] = [];
    const state = {
      process: null,
      port: 7700,
      cdpPort: null,
      managedChrome: false,
      ready: false,
      startPromise: null,
      requestedPort: 7700,
    };

    const reused = await kuri.reuseHealthyBrokerIfPossible(
      state as any,
      { headless: false, attachToExistingChrome: true },
      {
        isHealthyPort: async () => true,
        isChromeCdpAvailable: async () => false,
        discoverCdpPort: async () => {},
        ensureUserChromeRunning: async (nextState) => {
          seen.push("ensure-user-chrome");
          nextState.cdpPort = 9222;
        },
        ensureTabsDiscovered: async () => { seen.push("discover-tabs"); },
        listTabs: async () => [],
        terminateBrokerOnPort: async () => { seen.push("terminate-broker"); },
      },
    );

    // Foreign broker → reused cooperatively, never terminated.
    expect(reused).toBe(true);
    expect(state.ready).toBe(true);
    expect(seen).not.toContain("terminate-broker");
  });

  it("extracts plugin loaders from html datasets", () => {
    const html = `
      <div data-load-plugins="ticketing.js calendar.js"></div>
      <section data-load-plugins="calendar.js, upsell.js"></section>
    `;

    expect(kuri.extractLoadPluginsFromHtml(html)).toEqual([
      "ticketing.js",
      "calendar.js",
      "upsell.js",
    ]);
  });

  it("parses plugin rehydrate no-op responses safely", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      result: {
        result: {
          type: "string",
          value: JSON.stringify({
            attempted: false,
            loaded: false,
            nooped: true,
            reason: "missing_wrs_require",
            modules: ["ticketing.js"],
          }),
        },
      },
    }))) as typeof fetch;

    try {
      const result = await kuri.bestEffortRehydratePlugins("tab-1");
      expect(result.nooped).toBe(true);
      expect(result.reason).toBe("missing_wrs_require");
      expect(result.modules).toEqual(["ticketing.js"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts Kuri tab ids returned as id", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tab/new")) return new Response(JSON.stringify({ id: "tab-from-id" }));
      if (url.includes("/discover")) return new Response(JSON.stringify({ ok: true }));
      if (url.includes("/tabs")) return new Response(JSON.stringify([{ id: "tab-from-id", url: "about:blank" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      await expect(kuri.newTab("about:blank")).resolves.toBe("tab-from-id");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the discovered CDP port for secure cookie lookup instead of hardcoded 9222", async () => {
    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    kuri.setCdpPortForTests(9333);

    globalThis.fetch = (async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url === "http://127.0.0.1:9333/json") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.startsWith(`http://127.0.0.1:${kuri.getPort()}/cookies?`)) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      await expect(kuri.setCookie("tab-1", {
        name: "li_at",
        value: "secret",
        domain: ".linkedin.com",
        secure: true,
        httpOnly: true,
      })).rejects.toThrow(/no CDP websocket/);
    } finally {
      globalThis.fetch = originalFetch;
      kuri.setCdpPortForTests(null);
    }

    expect(seenUrls[0]).toBe("http://127.0.0.1:9333/json");
    expect(
      seenUrls.some((url) => url.includes("/cookies?")),
      "secure/httpOnly cookies must not fall back to /cookies because that strips flags",
    ).toBe(false);
  });

  it("reuses an idle tab before opening a raw CDP fallback tab", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tab/new")) return new Response(JSON.stringify({ error: "Target.createTarget failed" }));
      if (url.includes("/discover")) return new Response(JSON.stringify({ error: "Cannot connect to Chrome" }));
      if (url.includes("/tabs")) return new Response(JSON.stringify([{ id: "idle-tab", url: "about:blank" }]));
      if (url.includes("/evaluate")) return new Response(JSON.stringify({ result: 1 }));
      if (url.includes("/json/new?")) {
        if (init?.method !== "PUT") throw new Error("expected PUT");
        throw new Error("should not create a raw CDP tab when an idle tab exists");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      await expect(kuri.newTab("about:blank")).resolves.toBe("idle-tab");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps long evaluate expressions in the query string for brokers that only read URL params", async () => {
    const originalFetch = globalThis.fetch;
    const longExpression = "x".repeat(2101);
    let seenUrl = "";
    let seenMethod = "";

    globalThis.fetch = (async (input, init) => {
      seenUrl = String(input);
      seenMethod = String(init?.method ?? "GET");
      return new Response(JSON.stringify({
        result: {
          result: {
            type: "string",
            value: "ok",
          },
        },
      }));
    }) as typeof fetch;

    try {
      await expect(kuri.evaluate("tab-1", longExpression)).resolves.toBe("ok");
      expect(seenMethod).toBe("POST");
      expect(new URL(seenUrl).searchParams.get("expression")).toBe(longExpression);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("encodes plus signs in evaluate expressions so Kuri does not turn concatenation into spaces", async () => {
    const originalFetch = globalThis.fetch;
    const expression = '(() => "#" + "single")()';
    let seenUrl = "";

    globalThis.fetch = (async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({
        result: {
          result: {
            type: "string",
            value: "ok",
          },
        },
      }));
    }) as typeof fetch;

    try {
      await expect(kuri.evaluate("tab-1", expression)).resolves.toBe("ok");
      expect(seenUrl).toContain("%2B");
      expect(seenUrl).not.toContain("+");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
