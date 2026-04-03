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

    const clientA = kuri.getKuriClient(7813);
    const clientB = kuri.getKuriClient(7814);
    const results = await Promise.allSettled([
      clientA.start(),
      clientB.start(),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(Number(readFileSync(path.join(tmpDir, "counter-7813.txt"), "utf8").trim())).toBe(4);
    expect(Number(readFileSync(path.join(tmpDir, "counter-7814.txt"), "utf8").trim())).toBe(4);

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
});
