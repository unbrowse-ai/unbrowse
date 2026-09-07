/**
 * Witness: packaged (or monorepo) MCP tools/call get must stay on JSON-RPC
 * stdout and keep the process alive — never dump CLI help or exit 0.
 *
 * Regression for: host "MCP transport dropped — using the Unbrowse CLI instead"
 * caused by inlined cli.ts auto-main inside runtime/mcp.js on first get.
 */
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED_MCP = path.join(REPO, "packages/skill/runtime/mcp.js");
const SOURCE_MCP = path.join(REPO, "src/mcp.ts");

type Rpc = { jsonrpc?: string; id?: number; result?: unknown; error?: unknown };

function collectLines(proc: ChildProcessWithoutNullStreams): {
  lines: string[];
  json: Rpc[];
} {
  const lines: string[] = [];
  const json: Rpc[] = [];
  let buf = "";
  proc.stdout.on("data", (c) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        json.push(JSON.parse(trimmed) as Rpc);
      } catch {
        /* non-json */
      }
    }
  });
  return { lines, json };
}

async function waitForId(json: Rpc[], id: number, timeoutMs: number): Promise<Rpc> {
  const start = Date.now();
  for (;;) {
    const hit = json.find((r) => r.id === id);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for id=${id}; got ids=${json.map((r) => r.id).join(",")}`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function runGetTransportSmoke(label: string, cmd: string[], envExtra: Record<string, string> = {}) {
  const env = {
    ...process.env,
    UNBROWSE_MCP_SURFACE: "agent",
    UNBROWSE_NON_INTERACTIVE: "1",
    UNBROWSE_NO_AUTO_START: "1",
    ...envExtra,
  };
  const proc = spawn(cmd[0]!, cmd.slice(1), {
    cwd: REPO,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const { lines, json } = collectLines(proc);
  let stderr = "";
  proc.stderr.on("data", (c) => {
    stderr += c.toString();
  });

  const send = (obj: unknown) => {
    proc.stdin.write(JSON.stringify(obj) + "\n");
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "packaged-get-transport", version: "0" },
      },
    });
    await waitForId(json, 1, 20_000);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await waitForId(json, 2, 15_000);
    const tools = ((list.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
    const getName =
      tools.find((n) => n === "unbrowse_breath_get" || n === "unbrowse_act_get")
      ?? tools.find((n) => n.endsWith("_get"));
    expect(getName, `${label}: agent surface must expose get`).toBeTruthy();

    const linesBeforeGet = lines.length;
    // no_browse: force the get path (loads inlined cli/cmdGet) without a long
    // Chromium miss loop — we only need transport integrity, not extraction quality.
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: getName,
        arguments: {
          intent: "page title",
          url: "https://example.com",
          no_browse: true,
        },
      },
    });
    const call = await waitForId(json, 3, 45_000);

    // Process must still be alive after tools/call
    expect(proc.exitCode, `${label}: MCP exited after get (transport drop)`).toBeNull();
    expect(proc.signalCode).toBeNull();

    // Every stdout line since get must not be the CLI help banner
    const after = lines.slice(linesBeforeGet);
    for (const line of after) {
      expect(line, `${label}: CLI help leaked onto MCP stdout`).not.toMatch(
        /agent-native internet action engine/,
      );
      expect(line, `${label}: non-JSON-RPC on stdout`).toMatch(/^\s*\{/);
    }

    expect(call.jsonrpc).toBe("2.0");
    expect(call.id).toBe(3);
    expect(call.error ?? null).toBeNull();
    expect(call.result).toBeTruthy();

    // Second tools/list proves the session stayed open
    send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    const list2 = await waitForId(json, 4, 15_000);
    expect(list2.result).toBeTruthy();
    expect(proc.exitCode).toBeNull();
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
    }
    // keep stderr for failure messages
    if (proc.exitCode !== null && proc.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error(`[${label}] stderr tail:\n${stderr.slice(-2000)}`);
    }
  }
}

describe("MCP get transport — no CLI main re-entry", () => {
  test("monorepo src/mcp.ts: tools/call get stays JSON-RPC and alive", async () => {
    await runGetTransportSmoke("monorepo", ["bun", SOURCE_MCP]);
  }, 120_000);

  test("packaged runtime/mcp.js: tools/call get stays JSON-RPC and alive", async () => {
    if (!existsSync(PACKAGED_MCP)) {
      // Rebuild path may not have run yet in pure unit CI; monorepo witness is required.
      console.warn("skip packaged mcp: packages/skill/runtime/mcp.js missing");
      return;
    }
    await runGetTransportSmoke("packaged", ["node", PACKAGED_MCP]);
  }, 120_000);
});
