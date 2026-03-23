/**
 * MCP (Model Context Protocol) server for unbrowse.
 *
 * Started via `unbrowse mcp` — speaks JSON-RPC over stdio.
 * Registers one tool per unbrowse action (resolve, search, execute, etc.)
 * and shells out to the unbrowse CLI for execution.
 */

import { spawn } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────────

type ToolParams = {
  action: "resolve" | "search" | "execute" | "login" | "skills" | "skill" | "health";
  intent?: string;
  url?: string;
  domain?: string;
  skillId?: string;
  endpointId?: string;
  path?: string;
  extract?: string;
  limit?: number;
  pretty?: boolean;
  confirmUnsafe?: boolean;
  dryRun?: boolean;
};

// ── CLI arg builder ────────────────────────────────────────────────────────

function pushFlag(args: string[], name: string, value: string | number | boolean | undefined): void {
  if (value === undefined || value === false || value === "") return;
  args.push(`--${name}`);
  if (value !== true) args.push(String(value));
}

function buildArgs(params: ToolParams): string[] {
  switch (params.action) {
    case "health": return ["health"];
    case "skills": return ["skills"];
    case "skill":
      if (!params.skillId) throw new Error("skillId required for action=skill");
      return ["skill", params.skillId];
    case "login":
      if (!params.url) throw new Error("url required for action=login");
      return ["login", "--url", params.url];
    case "search": {
      if (!params.intent) throw new Error("intent required for action=search");
      const args = ["search", "--intent", params.intent];
      pushFlag(args, "domain", params.domain);
      return args;
    }
    case "execute": {
      if (!params.skillId) throw new Error("skillId required for action=execute");
      if (!params.endpointId) throw new Error("endpointId required for action=execute");
      const args = ["execute", "--skill", params.skillId, "--endpoint", params.endpointId];
      pushFlag(args, "url", params.url);
      pushFlag(args, "intent", params.intent);
      pushFlag(args, "path", params.path);
      pushFlag(args, "extract", params.extract);
      pushFlag(args, "limit", params.limit);
      pushFlag(args, "pretty", params.pretty);
      pushFlag(args, "dry-run", params.dryRun);
      pushFlag(args, "confirm-unsafe", params.confirmUnsafe);
      return args;
    }
    case "resolve": {
      if (!params.intent) throw new Error("intent required for action=resolve");
      if (!params.url) throw new Error("url required for action=resolve");
      const args = ["resolve", "--intent", params.intent, "--url", params.url];
      pushFlag(args, "path", params.path);
      pushFlag(args, "extract", params.extract);
      pushFlag(args, "limit", params.limit);
      pushFlag(args, "pretty", params.pretty);
      pushFlag(args, "dry-run", params.dryRun);
      pushFlag(args, "confirm-unsafe", params.confirmUnsafe);
      return args;
    }
    default:
      throw new Error(`Unsupported action: ${(params as { action: string }).action}`);
  }
}

// ── CLI runner ─────────────────────────────────────────────────────────────

function runCli(
  binPath: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // binPath is the script path (e.g. src/cli.ts or dist/cli.js).
    // Spawn it under the current runtime (bun/node).
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim() });
        return;
      }
      resolve({ ok: exitCode === 0, stdout, stderr });
    });
  });
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "unbrowse_resolve",
    description: "Reverse-engineer a website into structured API data. Give it a URL and describe what data you want — it captures network traffic, discovers API endpoints, and returns structured JSON. First call to a new site takes 5-15s; subsequent calls use the cached skill and return in under 1s.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "Plain-English description of what data to extract" },
        url: { type: "string", description: "Target website URL" },
        path: { type: "string", description: "Drill into a nested response path (e.g. 'data.items[]')" },
        extract: { type: "string", description: "Pick specific fields: 'field1,alias:deep.path'" },
        limit: { type: "number", description: "Cap array output to N items (1-200)" },
        pretty: { type: "boolean", description: "Pretty-print JSON output" },
        dryRun: { type: "boolean", description: "Preview mutations without executing" },
        confirmUnsafe: { type: "boolean", description: "Allow non-GET requests" },
      },
      required: ["intent", "url"],
    },
  },
  {
    name: "unbrowse_search",
    description: "Search the unbrowse skill marketplace for pre-built API skills. Faster than resolving from scratch if a skill already exists for the target site.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", description: "What you're looking for (e.g. 'hacker news top stories')" },
        domain: { type: "string", description: "Filter results to a specific domain" },
      },
      required: ["intent"],
    },
  },
  {
    name: "unbrowse_execute",
    description: "Execute a previously discovered skill endpoint. Use after resolve or search returns a skill ID and endpoint ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skillId: { type: "string", description: "Skill ID to execute" },
        endpointId: { type: "string", description: "Endpoint ID within the skill" },
        url: { type: "string", description: "Optional source URL when endpoint replay needs page context" },
        intent: { type: "string", description: "Optional original intent when endpoint replay needs selection context" },
        path: { type: "string", description: "Drill into a nested response path" },
        extract: { type: "string", description: "Pick specific fields" },
        limit: { type: "number", description: "Cap array output to N items" },
        pretty: { type: "boolean", description: "Pretty-print JSON output" },
        dryRun: { type: "boolean", description: "Preview mutations" },
        confirmUnsafe: { type: "boolean", description: "Allow non-GET requests" },
      },
      required: ["skillId", "endpointId"],
    },
  },
  {
    name: "unbrowse_login",
    description: "Open a browser for the user to log into a website. Captures auth cookies so future resolve/execute calls can access authenticated content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Login page URL" },
      },
      required: ["url"],
    },
  },
  {
    name: "unbrowse_skills",
    description: "List all locally cached unbrowse skills.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "unbrowse_skill",
    description: "Get details of a specific cached skill, including its endpoints and schemas.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skillId: { type: "string", description: "Skill ID to inspect" },
      },
      required: ["skillId"],
    },
  },
  {
    name: "unbrowse_health",
    description: "Check if the unbrowse CLI and local server are working.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

// ── Tool param extraction ──────────────────────────────────────────────────

function toolParamsFromCall(toolName: string, args: Record<string, unknown>): ToolParams {
  switch (toolName) {
    case "unbrowse_resolve":
      return { action: "resolve", intent: args.intent as string, url: args.url as string, path: args.path as string | undefined, extract: args.extract as string | undefined, limit: args.limit as number | undefined, pretty: args.pretty as boolean | undefined, dryRun: args.dryRun as boolean | undefined, confirmUnsafe: args.confirmUnsafe as boolean | undefined };
    case "unbrowse_search":
      return { action: "search", intent: args.intent as string, domain: args.domain as string | undefined };
    case "unbrowse_execute":
      return { action: "execute", skillId: args.skillId as string, endpointId: args.endpointId as string, intent: args.intent as string | undefined, url: args.url as string | undefined, path: args.path as string | undefined, extract: args.extract as string | undefined, limit: args.limit as number | undefined, pretty: args.pretty as boolean | undefined, dryRun: args.dryRun as boolean | undefined, confirmUnsafe: args.confirmUnsafe as boolean | undefined };
    case "unbrowse_login":
      return { action: "login", url: args.url as string };
    case "unbrowse_skills":
      return { action: "skills" };
    case "unbrowse_skill":
      return { action: "skill", skillId: args.skillId as string };
    case "unbrowse_health":
      return { action: "health" };
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── Minimal MCP stdio server (no SDK dependency) ───────────────────────────
//
// The MCP protocol is JSON-RPC 2.0 over stdio. We implement the minimal
// subset needed: initialize, notifications/initialized, tools/list, tools/call.
// This avoids adding @modelcontextprotocol/sdk as a dependency to the CLI.

function jsonRpcResponse(id: number | string, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
}

function cliErrorText(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;

    if (parsed.result && typeof parsed.result === "object") {
      const nested = parsed.result as Record<string, unknown>;
      if (typeof nested.error === "string" && nested.error.trim()) return nested.error;
    }
  } catch {
    return null;
  }

  return null;
}

export async function startMcpServer(unbrowseBin: string): Promise<void> {
  const timeoutMs = Number(process.env.UNBROWSE_TIMEOUT_MS) || 120_000;

  let buffer = "";
  let pending = 0;
  let stdinEnded = false;

  function maybeExit() {
    if (stdinEnded && pending === 0) process.exit(0);
  }

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;

    // Process complete JSON-RPC messages (newline-delimited)
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        // Track async work so we don't exit before it completes
        if (msg.id !== undefined && msg.method === "tools/call") {
          pending++;
          handleMessage(msg, unbrowseBin, timeoutMs).finally(() => {
            pending--;
            maybeExit();
          });
        } else {
          handleMessage(msg, unbrowseBin, timeoutMs);
        }
      } catch {
        process.stdout.write(jsonRpcError(null, -32700, "Parse error"));
      }
    }
  });

  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeExit();
  });

  // Keep process alive
  await new Promise(() => {});
}

async function handleMessage(
  msg: { id?: number | string; method?: string; params?: Record<string, unknown> },
  unbrowseBin: string,
  timeoutMs: number,
): Promise<void> {
  const { id, method } = msg;

  // Notifications (no id) — just acknowledge silently
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      process.stdout.write(jsonRpcResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "unbrowse", version: "1.0.0" },
      }));
      break;

    case "tools/list":
      process.stdout.write(jsonRpcResponse(id, { tools: TOOLS }));
      break;

    case "tools/call": {
      const toolName = (msg.params as any)?.name as string;
      const toolArgs = ((msg.params as any)?.arguments ?? {}) as Record<string, unknown>;

      try {
        const params = toolParamsFromCall(toolName, toolArgs);
        const cliArgs = buildArgs(params);
        const result = await runCli(unbrowseBin, cliArgs, timeoutMs);
        const payloadError = cliErrorText(result.stdout);

        if (!result.ok || payloadError) {
          const errorText = payloadError || result.stderr?.trim() || result.stdout?.trim() || "Command failed";
          process.stdout.write(jsonRpcResponse(id, {
            content: [{ type: "text", text: `Error: ${errorText}` }],
            isError: true,
          }));
        } else {
          process.stdout.write(jsonRpcResponse(id, {
            content: [{ type: "text", text: result.stdout.trim() || "OK" }],
          }));
        }
      } catch (err) {
        process.stdout.write(jsonRpcResponse(id, {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }));
      }
      break;
    }

    default:
      process.stdout.write(jsonRpcError(id, -32601, `Method not found: ${method}`));
  }
}
