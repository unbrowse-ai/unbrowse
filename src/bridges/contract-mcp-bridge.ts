#!/usr/bin/env node
// MCP stdio bridge for the /contract primitive.
//
// /contract speaks CLI today (Python script at
// ~/.claude/skills/contract/scripts/contract or a Rust binary on PATH). This
// bridge translates a minimal MCP tool surface — declare / iterate / status
// / list / search — into spawned CLI invocations and pipes the captured
// stdout back as MCP tool-call output text content.
//
// Substrate principle: this bridge surfaces what the CLI already declares;
// it does NOT re-implement contract semantics, judge truth, or filter rows.
// The agent on the MCP host reads the captured stdout and judges in-thread,
// the same way it would if it shelled out itself.
//
// Idempotent re-runs are safe because every operation is the contract CLI's
// own — the bridge owns no state.
//
// Hand-rolled JSON-RPC 2.0 over stdio (no @modelcontextprotocol/sdk
// dependency) so the npm bundle stays lean and the bridge inherits the same
// shape as src/mcp.ts (the existing unbrowse MCP server, which is itself
// hand-rolled).

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// -- resolver (vendored from setup/contract-bin-resolver.ts so the bridge can
//    run as a single-file script under `node` without ESM dist plumbing).
function resolveBin(): { path: string | null; source: string } {
  const env = process.env;
  if (env.CONTRACT_BIN && existsSync(env.CONTRACT_BIN)) {
    return { path: env.CONTRACT_BIN, source: "env" };
  }
  const probes: Array<{ cmd: string; args: string[] }> = [
    { cmd: "which", args: ["contract"] },
    { cmd: "command", args: ["-v", "contract"] },
  ];
  for (const probe of probes) {
    try {
      const r = spawnSync(probe.cmd, probe.args, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
      if (r.status === 0) {
        const out = (r.stdout?.toString() ?? "").trim().split("\n")[0]?.trim();
        if (out && existsSync(out)) return { path: out, source: "path" };
      }
    } catch { /* keep probing */ }
  }
  const home = homedir();
  const cargo = join(home, ".cargo", "bin", "contract");
  if (existsSync(cargo)) return { path: cargo, source: "cargo" };
  const claude = join(home, ".claude", "skills", "contract", "scripts", "contract");
  if (existsSync(claude)) return { path: claude, source: "claude-skill" };
  return { path: null, source: "not_detected" };
}

// -- JSON-RPC wire ---------------------------------------------------------
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function writeStdout(msg: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function rpcResult(id: JsonRpcMessage["id"], result: unknown): void {
  writeStdout({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: JsonRpcMessage["id"], code: number, message: string, data?: unknown): void {
  writeStdout({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

// -- Tool catalog ----------------------------------------------------------
// Five tools that cover the bulk of agent-facing usage. Adding more is a
// matter of appending a row here + a case in `runContract` — the CLI carries
// the rest.

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolSpec[] = [
  {
    name: "declare",
    description:
      "Declare a new contract — a truth claim with a mechanical check. " +
      "plan is the human-readable plan text, action is the shell command that " +
      "passes when the contract is satisfied.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Human-readable plan text" },
        action: { type: "string", description: "Shell command that passes (exit 0) when satisfied" },
        parent: { type: "string", description: "Optional parent contract id for nesting" },
        scope: { type: "string", enum: ["project", "global"], description: "Ledger scope (default: project)" },
      },
      required: ["plan", "action"],
    },
  },
  {
    name: "iterate",
    description:
      "Run one iteration wave on an existing contract. Surfaces the action " +
      "exit + ledger row so the agent can judge whether to mark it satisfied.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contract id (8-hex prefix)" },
      },
      required: ["id"],
    },
  },
  {
    name: "status",
    description:
      "Tree view of a contract (or no-arg: the whole ledger summary).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional contract id" },
      },
    },
  },
  {
    name: "list",
    description: "List contracts. Pass show_merged=true to include retired/merged cells.",
    inputSchema: {
      type: "object",
      properties: {
        show_merged: { type: "boolean", description: "Include retired/merged contracts" },
        scope: { type: "string", enum: ["project", "global", "all"], description: "Scope filter (default: project)" },
      },
    },
  },
  {
    name: "search",
    description: "Surface contracts related to a free-text context. Alias for `contract habit`.",
    inputSchema: {
      type: "object",
      properties: {
        context: { type: "string", description: "Free-text context to match against" },
        scope: { type: "string", enum: ["project", "global"], description: "Search scope (default: project)" },
      },
      required: ["context"],
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// -- CLI dispatch ----------------------------------------------------------
function runContract(binPath: string, args: string[]): { exit_code: number; stdout: string; stderr: string } {
  const r = spawnSync(binPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    exit_code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function buildArgs(toolName: string, args: Record<string, unknown>): string[] {
  switch (toolName) {
    case "declare": {
      const plan = String(args.plan ?? "");
      const action = String(args.action ?? "");
      const cli: string[] = ["declare", plan, "--action", action];
      if (typeof args.parent === "string" && args.parent) cli.push("--parent", args.parent);
      if (args.scope === "global") cli.push("--scope", "global");
      return cli;
    }
    case "iterate": {
      const id = String(args.id ?? "");
      return ["iterate", id];
    }
    case "status": {
      const id = typeof args.id === "string" && args.id ? args.id : null;
      return id ? ["status", id] : ["status"];
    }
    case "list": {
      const cli = ["list"];
      if (args.show_merged === true) cli.push("--show-merged");
      // Note: contract list itself doesn't accept --scope today; we
      // re-route to `discover` when scope is explicit.
      if (args.scope === "global" || args.scope === "all" || args.scope === "project") {
        return ["discover", "--scope", args.scope];
      }
      return cli;
    }
    case "search": {
      const context = String(args.context ?? "");
      const cli = ["search", "--context", context];
      if (args.scope === "global") cli.push("--scope", "global");
      else if (args.scope === "project") cli.push("--scope", "project");
      return cli;
    }
    default:
      return [];
  }
}

// -- Server loop -----------------------------------------------------------
let initialized = false;
const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;

async function handle(message: JsonRpcMessage, binPath: string | null): Promise<void> {
  const { id, method } = message;
  const params = message.params ?? {};

  if (!method) {
    if (id !== undefined) rpcError(id ?? null, -32600, "Invalid Request");
    return;
  }

  if (method === "initialize") {
    initialized = true;
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    const protocolVersion =
      requested && SUPPORTED_PROTOCOLS.includes(requested as (typeof SUPPORTED_PROTOCOLS)[number])
        ? requested
        : SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];
    rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "contract",
        title: "Contract",
        version: "0.1.0",
        description:
          "Fractal contract primitive — declare/iterate/status/list/search on the local /contract ledger via the installed CLI.",
      },
      instructions:
        binPath
          ? `Bridge resolved /contract bin at ${binPath}. ` +
            "Tools spawn the CLI and stream stdout back as content. " +
            "The bridge owns no state; the CLI's ledger is the substrate."
          : "No /contract bin detected. Set $CONTRACT_BIN, or install Claude Code (provides ~/.claude/skills/contract/scripts/contract).",
    });
    return;
  }

  if (method === "notifications/initialized") return;
  if (method === "ping") {
    rpcResult(id, {});
    return;
  }

  if (!initialized) {
    rpcError(id, -32002, "Server not initialized");
    return;
  }

  if (method === "tools/list") {
    rpcResult(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : undefined;
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
    if (!name || !TOOL_MAP.has(name)) {
      rpcError(id, -32602, `Unknown tool: ${name ?? "<missing>"}`);
      return;
    }
    if (!binPath) {
      rpcResult(id, {
        isError: true,
        content: [{
          type: "text",
          text:
            "No /contract binary detected on this machine.\n" +
            "Tried: $CONTRACT_BIN, `which contract`, ~/.cargo/bin/contract, ~/.claude/skills/contract/scripts/contract.\n" +
            "Install Claude Code or set $CONTRACT_BIN to a runnable binary.",
        }],
      });
      return;
    }
    const cliArgs = buildArgs(name, args);
    if (cliArgs.length === 0) {
      rpcError(id, -32602, `No CLI mapping for tool: ${name}`);
      return;
    }
    const r = runContract(binPath, cliArgs);
    const text =
      (r.stdout ? r.stdout : "") +
      (r.stderr ? (r.stdout ? `\n--- stderr ---\n${r.stderr}` : r.stderr) : "");
    rpcResult(id, {
      isError: r.exit_code !== 0,
      content: [{ type: "text", text: text || `(no output; exit ${r.exit_code})` }],
      structuredContent: {
        exit_code: r.exit_code,
        bin: binPath,
        argv: cliArgs,
      },
    });
    return;
  }

  if (method === "resources/list") {
    rpcResult(id, { resources: [] });
    return;
  }
  if (method === "prompts/list") {
    rpcResult(id, { prompts: [] });
    return;
  }

  rpcError(id, -32601, `Method not found: ${method}`);
}

export async function runBridge(): Promise<void> {
  const resolved = resolveBin();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      rpcError(null, -32700, "Parse error");
      continue;
    }
    try {
      await handle(message, resolved.path);
    } catch (err) {
      rpcError(message.id ?? null, -32603, err instanceof Error ? err.message : String(err));
    }
  }
}

// Run when invoked directly (e.g. `node dist/bridges/contract-mcp-bridge.js`).
// The top-level src/contract-bridge.ts wrapper is the canonical entry that
// cli.ts spawns; this branch keeps the bridge runnable standalone for tests
// and ad-hoc dev work.
const entry = process.argv[1] ?? "";
if (entry.endsWith("contract-mcp-bridge.ts") || entry.endsWith("contract-mcp-bridge.js")) {
  runBridge().catch((err) => {
    rpcError(null, -32603, err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

// Exports for tests.
export const __testing__ = {
  buildArgs,
  runContract,
  resolveBin,
  TOOLS,
};
