import { afterEach, describe, expect, it } from "bun:test";
import http from "node:http";
import { closeSync, openSync, utimesSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalServer } from "../src/runtime/local-server.js";

const servers: http.Server[] = [];
const originalRunDir = process.env.UNBROWSE_RUN_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  process.env.UNBROWSE_RUN_DIR = originalRunDir;
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("ensureLocalServer", () => {
  it("fails clearly when another process already owns the port", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 404;
      res.end("nope");
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await expect(ensureLocalServer(baseUrl, false, import.meta.url)).rejects.toThrow(
      `Port 127.0.0.1:${address.port} already in use`,
    );
  });

  it("reclaims a stale startup lock before reporting port ownership", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 404;
      res.end("nope");
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-run-"));
    tempDirs.push(runDir);
    process.env.UNBROWSE_RUN_DIR = runDir;

    const lockFile = join(runDir, `server-127.0.0.1-${address.port}.json.lock`);
    const fd = openSync(lockFile, "w");
    closeSync(fd);
    const staleSeconds = Date.now() / 1000 - 120;
    utimesSync(lockFile, staleSeconds, staleSeconds);

    await expect(ensureLocalServer(baseUrl, false, import.meta.url)).rejects.toThrow(
      `Port 127.0.0.1:${address.port} already in use`,
    );
  });
});
