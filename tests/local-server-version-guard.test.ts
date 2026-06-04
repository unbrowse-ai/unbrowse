import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getManagedServerPid, isServerVersionMismatch } from "../src/runtime/local-server.js";

let originalRunDir: string | undefined;
let tempRunDir: string | null = null;

beforeEach(() => {
  originalRunDir = process.env.UNBROWSE_RUN_DIR;
  tempRunDir = mkdtempSync(join(tmpdir(), "unbrowse-version-guard-"));
  process.env.UNBROWSE_RUN_DIR = tempRunDir;
});

afterEach(() => {
  if (originalRunDir === undefined) delete process.env.UNBROWSE_RUN_DIR;
  else process.env.UNBROWSE_RUN_DIR = originalRunDir;
  if (tempRunDir) rmSync(tempRunDir, { recursive: true, force: true });
  tempRunDir = null;
});

describe("local server version guard", () => {
  it("flags mismatched running and installed package versions", () => {
    expect(isServerVersionMismatch("2.10.2", "2.12.0")).toBe(true);
  });

  it("ignores matching package versions", () => {
    expect(isServerVersionMismatch("2.12.0", "2.12.0")).toBe(false);
  });

  it("ignores servers that do not report a package version", () => {
    expect(isServerVersionMismatch(undefined, "2.12.0")).toBe(false);
  });

  it("flags same-version servers when the code hash drifts", () => {
    expect(isServerVersionMismatch("2.12.0", "2.12.0", "oldhash123456", "newhash654321")).toBe(true);
  });

  it("accepts a pid from an Unbrowse health response when the pid file is absent", () => {
    expect(getManagedServerPid("http://127.0.0.1:19876", {
      status: "ok",
      package_version: "2.12.0",
      code_hash: "oldhash123456",
      pid: 12345,
    })).toBe(12345);
  });

  it("rejects bare pid values that are not tied to an Unbrowse health response", () => {
    expect(getManagedServerPid("http://127.0.0.1:19877", {
      status: "ok",
      pid: 12345,
    })).toBeNull();
  });
});
