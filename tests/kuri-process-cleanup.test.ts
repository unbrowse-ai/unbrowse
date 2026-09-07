import { describe, expect, test } from "bun:test";
import {
  chromiumCdpCleanupCommands,
  cleanupChromiumOnCdpPort,
} from "../src/kuri/process-cleanup.js";

describe("orphan Chromium CDP cleanup", () => {
  test("plans the Windows branch without relying on the CI host platform", () => {
    const [command] = chromiumCdpCleanupCommands(9223, "win32");
    expect(command.file).toBe("powershell.exe");
    expect(command.args).toContain("-NonInteractive");
    const script = command.args.at(-1) ?? "";
    expect(script).toContain("--remote-debugging-port=9223");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("Stop-Process");
    expect(script).not.toContain("pkill");
  });

  test("keeps the Unix cleanup scoped to the exact CDP marker", () => {
    expect(chromiumCdpCleanupCommands(9333, "linux")).toEqual([
      { file: "pkill", args: ["-f", "remote-debugging-port=9333"] },
    ]);
  });

  test("rejects invalid ports before executing anything", () => {
    const calls: unknown[] = [];
    expect(cleanupChromiumOnCdpPort(0, "win32", (...args) => { calls.push(args); })).toBe(false);
    expect(cleanupChromiumOnCdpPort(65_536, "linux", (...args) => { calls.push(args); })).toBe(false);
    expect(calls).toEqual([]);
  });

  test("is best-effort and reports execution failure", () => {
    expect(cleanupChromiumOnCdpPort(9222, "win32", () => { throw new Error("missing powershell"); })).toBe(false);
  });
});
