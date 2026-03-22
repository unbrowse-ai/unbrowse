import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as kuri from "../src/kuri/client.js";
import { getPackageRoot } from "../src/runtime/paths.js";

const originalKuriBin = process.env.KURI_BIN;
const originalPackageRoot = process.env.UNBROWSE_PACKAGE_ROOT;
const tmpDirs: string[] = [];
const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("server failed to bind"));
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  if (originalKuriBin === undefined) delete process.env.KURI_BIN;
  else process.env.KURI_BIN = originalKuriBin;
  if (originalPackageRoot === undefined) delete process.env.UNBROWSE_PACKAGE_ROOT;
  else process.env.UNBROWSE_PACKAGE_ROOT = originalPackageRoot;
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  await kuri.stop();
});

describe("kuri client", () => {
  it("finds the repo root for nested src modules", () => {
    const packageRoot = mkdtempSync(path.join(os.tmpdir(), "unbrowse-paths-package-"));
    tmpDirs.push(packageRoot);
    mkdirSync(path.join(packageRoot, "src", "kuri"), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), "{\"name\":\"tmp-unbrowse\"}\n");

    const nestedModuleUrl = pathToFileURL(path.join(packageRoot, "src", "kuri", "client.ts")).href;
    expect(getPackageRoot(nestedModuleUrl)).toBe(packageRoot);
  });

  it("fails cleanly when the kuri binary is missing", async () => {
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
  });

  it("falls back to the monorepo skill package vendor binary", () => {
    delete process.env.KURI_BIN;
    const packageRoot = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-workspace-"));
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

    const binaryPath = path.join(
      packageRoot,
      "packages",
      "skill",
      "vendor",
      "kuri",
      target,
      process.platform === "win32" ? "kuri.exe" : "kuri",
    );
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);

    expect(kuri.findKuriBinary()).toBe(binaryPath);
  });

  it("creates tabs through Chrome CDP instead of Kuri /tab/new", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
      if (req.method === "PUT" && req.url === `/json/new?${encodeURIComponent("https://example.com/path?q=1")}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "tab-123" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    servers.push(server);
    const cdpPort = await listen(server);

    const tabId = await kuri.createChromeTabViaCdp("https://example.com/path?q=1", {
      cdpPort,
      rediscover: false,
    });

    expect(tabId).toBe("tab-123");
    expect(seen).toEqual([`PUT /json/new?${encodeURIComponent("https://example.com/path?q=1")}`]);
  });
});
