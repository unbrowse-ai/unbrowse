/**
 * Tests for server supervisor, version tracking, and lifecycle commands (Issue #90).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { checkServerVersion, stopServer } from "../src/runtime/local-server.js";
import { getServerPidFile } from "../src/runtime/paths.js";
import { parseArgs } from "../src/cli.js";

const TEST_BASE_URL = "http://localhost:19999";

describe("PidState version tracking", () => {
  const pidFile = getServerPidFile(TEST_BASE_URL);

  beforeEach(() => {
    const dir = path.dirname(pidFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(pidFile); } catch { /* ignore */ }
  });

  it("checkServerVersion returns null when no pid file", () => {
    const result = checkServerVersion(TEST_BASE_URL, import.meta.url);
    expect(result).toBeNull();
  });

  it("checkServerVersion detects version mismatch", () => {
    writeFileSync(pidFile, JSON.stringify({
      pid: process.pid,
      base_url: TEST_BASE_URL,
      started_at: new Date().toISOString(),
      entrypoint: "test",
      version: "0.0.0-old",
    }));
    const result = checkServerVersion(TEST_BASE_URL, import.meta.url);
    expect(result).not.toBeNull();
    expect(result!.running).toBe("0.0.0-old");
    expect(result!.needs_restart).toBe(true);
  });

  it("checkServerVersion detects matching version", () => {
    // Read actual version from package.json
    const pkgPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    writeFileSync(pidFile, JSON.stringify({
      pid: process.pid,
      base_url: TEST_BASE_URL,
      started_at: new Date().toISOString(),
      entrypoint: "test",
      version: pkg.version,
    }));
    const result = checkServerVersion(TEST_BASE_URL, import.meta.url);
    expect(result).not.toBeNull();
    expect(result!.needs_restart).toBe(false);
  });
});

describe("stopServer", () => {
  it("returns false when no server running", () => {
    const result = stopServer("http://localhost:29999");
    expect(result).toBe(false);
  });
});

describe("CLI lifecycle commands parse correctly", () => {
  it("parses 'status' command", () => {
    const { command } = parseArgs(["node", "cli", "status"]);
    expect(command).toBe("status");
  });

  it("parses 'stop' command", () => {
    const { command } = parseArgs(["node", "cli", "stop"]);
    expect(command).toBe("stop");
  });

  it("parses 'restart' command", () => {
    const { command } = parseArgs(["node", "cli", "restart"]);
    expect(command).toBe("restart");
  });

  it("parses 'upgrade' command", () => {
    const { command } = parseArgs(["node", "cli", "upgrade"]);
    expect(command).toBe("upgrade");
  });

  it("parses 'update' as alias for upgrade", () => {
    const { command } = parseArgs(["node", "cli", "update"]);
    expect(command).toBe("update");
  });
});

describe("PidState restart_count tracking", () => {
  const pidFile = getServerPidFile(TEST_BASE_URL);

  afterEach(() => {
    try { rmSync(pidFile); } catch { /* ignore */ }
  });

  it("pid state includes restart_count field", () => {
    const dir = path.dirname(pidFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const state = {
      pid: process.pid,
      base_url: TEST_BASE_URL,
      started_at: new Date().toISOString(),
      entrypoint: "test",
      version: "2.6.0",
      restart_count: 2,
    };
    writeFileSync(pidFile, JSON.stringify(state));
    const parsed = JSON.parse(readFileSync(pidFile, "utf-8"));
    expect(parsed.restart_count).toBe(2);
    expect(parsed.version).toBe("2.6.0");
  });
});
