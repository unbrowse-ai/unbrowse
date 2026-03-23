import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
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
const childProcs: ChildProcess[] = [];

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
  while (childProcs.length > 0) {
    const child = childProcs.pop();
    if (!child) continue;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await kuri.stop();
});

async function waitForFileContents(file: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return Bun.file(file).text();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${file}`);
}

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

  it("prefers the Chrome child under the running kuri process over stray local CDP ports", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "unbrowse-kuri-proc-tree-"));
    tmpDirs.push(dir);
    const childScript = path.join(dir, "child.cjs");
    const parentScript = path.join(dir, "parent.cjs");
    const portFile = path.join(dir, "child-port.txt");

    writeFileSync(childScript, `
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const portFile = process.argv[2];
const server = createServer((req, res) => {
  if (req.url === "/json/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Browser: "Chrome/131.0.0.0" }));
    return;
  }
  res.writeHead(404);
  res.end("nope");
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  writeFileSync(portFile, String(addr.port));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`.trim() + "\n");

    writeFileSync(parentScript, `
const { spawn } = require("node:child_process");
const childScript = process.argv[2];
const portFile = process.argv[3];
const child = spawn("bash", ["-lc", \`exec -a "Google Chrome" node \${JSON.stringify(childScript)} \${JSON.stringify(portFile)}\`], {
  stdio: "ignore",
});
process.on("SIGTERM", () => {
  try { child.kill("SIGTERM"); } catch {}
  process.exit(0);
});
setInterval(() => {}, 1000);
`.trim() + "\n");

    const parent = spawn("bash", ["-lc", `exec -a kuri node ${JSON.stringify(parentScript)} ${JSON.stringify(childScript)} ${JSON.stringify(portFile)}`], {
      stdio: "ignore",
    });
    childProcs.push(parent);

    const expectedPort = Number((await waitForFileContents(portFile)).trim());
    const discoveredPort = await kuri.__test.discoverManagedChromeCdpPortForPid(parent.pid!);
    expect(discoveredPort).toBe(expectedPort);
  });
});
