import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as kuri from "../src/kuri/client.js";

const originalKuriBin = process.env.KURI_BIN;
const originalPackageRoot = process.env.UNBROWSE_PACKAGE_ROOT;
const tmpDirs: string[] = [];

afterEach(async () => {
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

  it("returns the same broker client for the same port and distinct clients for different ports", () => {
    const first = kuri.getKuriClient(7811);
    const second = kuri.getKuriClient(7811);
    const third = kuri.getKuriClient(7812);

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first.getPort()).toBe(7811);
    expect(third.getPort()).toBe(7812);
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
      await kuri.setCookie("tab-1", {
        name: "li_at",
        value: "secret",
        domain: ".linkedin.com",
        secure: true,
        httpOnly: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
      kuri.setCdpPortForTests(null);
    }

    expect(seenUrls[0]).toBe("http://127.0.0.1:9333/json");
    expect(seenUrls).toContain(`http://127.0.0.1:${kuri.getPort()}/cookies?tab_id=tab-1&name=li_at&value=secret&domain=.linkedin.com`);
  });

  it("reuses an idle tab before opening a raw CDP fallback tab", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tab/new")) return new Response(JSON.stringify({ error: "Target.createTarget failed" }));
      if (url.includes("/discover")) return new Response(JSON.stringify({ error: "Cannot connect to Chrome" }));
      if (url.includes("/tabs")) return new Response(JSON.stringify([{ id: "idle-tab", url: "chrome://newtab/" }]));
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
});
