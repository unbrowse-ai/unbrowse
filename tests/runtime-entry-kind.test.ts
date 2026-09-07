/**
 * Packaged MCP transport guard: CLI auto-main must not fire when the process
 * entry is mcp (or MCP_SERVER_MODE=1), even if isMainModule is true because
 * the single-file bundle inlines cli.ts into mcp.js.
 */
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getRuntimeEntryKind,
  isMainModule,
  shouldAutoRunCliMain,
} from "../src/runtime/paths.js";

const prevMode = process.env.MCP_SERVER_MODE;
const prevEntry = process.env.UNBROWSE_RUNTIME_ENTRY;
const prevArgv1 = process.argv[1];

afterEach(() => {
  if (prevMode === undefined) delete process.env.MCP_SERVER_MODE;
  else process.env.MCP_SERVER_MODE = prevMode;
  if (prevEntry === undefined) delete process.env.UNBROWSE_RUNTIME_ENTRY;
  else process.env.UNBROWSE_RUNTIME_ENTRY = prevEntry;
  process.argv[1] = prevArgv1;
});

describe("getRuntimeEntryKind / shouldAutoRunCliMain", () => {
  test("MCP_SERVER_MODE blocks CLI auto-main even when meta matches entry", () => {
    process.env.MCP_SERVER_MODE = "1";
    delete process.env.UNBROWSE_RUNTIME_ENTRY;
    const entry = path.resolve("/tmp/unbrowse-test-cli.js");
    process.argv[1] = entry;
    const meta = pathToFileURL(entry).href;
    expect(isMainModule(meta)).toBe(true);
    expect(shouldAutoRunCliMain(meta)).toBe(false);
  });

  test("entry basename mcp.js blocks CLI auto-main (packaged bundle case)", () => {
    delete process.env.MCP_SERVER_MODE;
    delete process.env.UNBROWSE_RUNTIME_ENTRY;
    const entry = path.resolve("/tmp/runtime/mcp.js");
    process.argv[1] = entry;
    const meta = pathToFileURL(entry).href;
    // Bundle false-positive: meta url === entry path
    expect(isMainModule(meta)).toBe(true);
    expect(getRuntimeEntryKind()).toBe("mcp");
    expect(shouldAutoRunCliMain(meta)).toBe(false);
  });

  test("cli.js entry still auto-runs when it is the real main", () => {
    delete process.env.MCP_SERVER_MODE;
    delete process.env.UNBROWSE_RUNTIME_ENTRY;
    const entry = path.resolve("/tmp/runtime/cli.js");
    process.argv[1] = entry;
    const meta = pathToFileURL(entry).href;
    expect(getRuntimeEntryKind()).toBe("cli");
    expect(shouldAutoRunCliMain(meta)).toBe(true);
  });

  test("UNBROWSE_RUNTIME_ENTRY=mcp wins over cli-looking path", () => {
    delete process.env.MCP_SERVER_MODE;
    process.env.UNBROWSE_RUNTIME_ENTRY = "mcp";
    const entry = path.resolve("/tmp/runtime/cli.js");
    process.argv[1] = entry;
    const meta = pathToFileURL(entry).href;
    expect(getRuntimeEntryKind()).toBe("mcp");
    expect(shouldAutoRunCliMain(meta)).toBe(false);
  });
});
