import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import * as kuri from "../src/kuri/client.js";

const originalKuriBin = process.env.KURI_BIN;
const originalPackageRoot = process.env.UNBROWSE_PACKAGE_ROOT;
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
    await expect(kuri.start(7799)).rejects.toThrow("Kuri binary not found");
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

  it("retries spawn when kuri exits immediately and fails after max attempts", async () => {
    // A binary that exits with code 1 immediately simulates the LinkedIn spawn failure
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-retry-"));
    tmpDirs.push(tmpDir);
    const fakeBin = path.join(tmpDir, "kuri");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeBin, 0o755);
    process.env.KURI_BIN = fakeBin;

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

    await kuri.start(7795);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await new Promise<void>((resolve, reject) => fakeHealthServer.close((err) => err ? reject(err) : resolve()));
    await waitForPortDown(7795);
    await new Promise((resolve) => setTimeout(resolve, 0));

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

  it("derives launch mode from env flags", () => {
    expect(kuri.resolveKuriLaunchConfig({
      HEADLESS: "true",
    } as NodeJS.ProcessEnv)).toEqual({
      headless: true,
      attachToExistingChrome: false,
    });

    expect(kuri.resolveKuriLaunchConfig({
      KURI_HEADLESS: "1",
      KURI_DISABLE_CDP_ATTACH: "1",
    } as NodeJS.ProcessEnv)).toEqual({
      headless: true,
      attachToExistingChrome: false,
    });

    expect(kuri.resolveKuriLaunchConfig({} as NodeJS.ProcessEnv)).toEqual({
      headless: false,
      attachToExistingChrome: true,
    });
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
      await kuri.setCookie("tab-1", {
        name: "li_at",
        value: "secret",
        domain: ".linkedin.com",
        secure: true,
        httpOnly: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(seenUrls[0]).toBe("http://127.0.0.1:9333/json");
    expect(seenUrls).toContain(`http://127.0.0.1:${kuri.getPort()}/cookies?tab_id=tab-1&name=li_at&value=secret&domain=.linkedin.com`);
  });
});
