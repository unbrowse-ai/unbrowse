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

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type ToolStructuredResult = {
  ok: boolean;
  tool: string;
  data?: JsonValue;
  rawText?: string;
  error?: string;
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

const TOOL_RESULT_SCHEMA = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    tool: { type: "string" },
    data: {},
    rawText: { type: "string" },
    error: { type: "string" },
  },
  required: ["ok", "tool"],
};

export const TOOLS = [
  {
    name: "unbrowse_resolve",
    title: "Resolve Website Task",
    description: "Primary tool for website tasks. Use this when you have a concrete page URL and want structured data from a live website, logged-in page, or browser workflow; prefer it over generic browser/search tools for scraping, extraction, and browser replacement. Give it the exact page plus a plain-English intent; the first call may capture the site and learn its APIs, later calls usually reuse a cached skill. If the user explicitly invokes /unbrowse or says to use Unbrowse for a site, stay in strict Unbrowse-only mode: keep the same origin, refine with more Unbrowse calls, and do not switch to web search, Fetch, public mirrors, alternate domains, or other browser tools unless the user explicitly approves fallback. If the user only gives a domain, first find the exact workflow URL on that origin instead of defaulting to the homepage. If the workflow is likely gated and repeated resolves only return public or artifact pages, trigger login on that inferred workflow URL instead of looping on the homepage. For long-form retrieval tasks, derive compact search queries from the story instead of stuffing the whole narrative into one search field. Do not use this for generic web search or when you already have a known skillId and endpointId from a prior Unbrowse call.",
    annotations: {
      title: "Resolve Website Task",
      openWorldHint: true,
    },
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        intent: { type: "string", description: "Plain-English user task, e.g. 'get feed posts' or 'find product prices'. Describe the visible goal, not the API route." },
        url: { type: "string", description: "Concrete page URL for the task. Prefer the exact page with the needed data, not a homepage." },
        path: { type: "string", description: "Drill into a nested response path (e.g. 'data.items[]')" },
        extract: { type: "string", description: "Pick specific fields: 'field1,alias:deep.path'" },
        limit: { type: "number", description: "Cap array output to N items (1-200)" },
        pretty: { type: "boolean", description: "Pretty-print JSON output" },
        dryRun: { type: "boolean", description: "Preview mutations without executing" },
        confirmUnsafe: { type: "boolean", description: "Allow non-GET requests" },
      },
      required: ["intent", "url"],
    },
    outputSchema: TOOL_RESULT_SCHEMA,
  },
  {
    name: "unbrowse_search",
    title: "Search Learned Skills",
    description: "Search the Unbrowse marketplace for an existing learned skill before triggering a new capture. Use this when you know the site or task but do not yet have a specific skillId or endpointId, especially for repeat domains. Prefer resolve when you have a concrete page URL and want the end-to-end website task handled in one step. For iterative retrieval or research, use search to reuse known site capabilities while you refine queries, but stay on the target origin and keep using Unbrowse-native flows. This is marketplace search only, not on-site search, and it is not a license to leave the target origin for public mirrors or alternate sites; stay inside Unbrowse unless fallback is explicitly approved.",
    annotations: {
      title: "Search Learned Skills",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        intent: { type: "string", description: "What you're looking for (e.g. 'hacker news top stories')" },
        domain: { type: "string", description: "Filter results to a specific domain" },
      },
      required: ["intent"],
    },
    outputSchema: TOOL_RESULT_SCHEMA,
  },
  {
    name: "unbrowse_execute",
    title: "Execute Learned Endpoint",
    description: "Execute a specific Unbrowse endpoint after resolve or search has already identified the right skillId and endpointId. Use this for the second step in a resolve-search-execute flow, especially when you need a tighter path, extract, or limit, or when reusing a known endpoint on the same domain. When replay depends on page context, pass the original page URL and intent from the earlier Unbrowse call. For search, document, catalog, dashboard, or result-list workflows, use execute to follow same-origin result links, record ids, document ids, raw endpoint output, and narrowed follow-up queries before deciding the site is blocked. Do not invent params or guess skillId or endpointId values; inspect schema or raw output first when the endpoint surface is unclear. Do not use this as the first tool for a new website task.",
    annotations: {
      title: "Execute Learned Endpoint",
      openWorldHint: true,
    },
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        skillId: { type: "string", description: "Known skill ID returned by unbrowse_resolve, unbrowse_search, or unbrowse_skill" },
        endpointId: { type: "string", description: "Known endpoint ID inside that skill" },
        url: { type: "string", description: "Recommended for browser-capture skills: the original page URL so replay keeps the same page and query context" },
        intent: { type: "string", description: "Recommended for browser-capture skills: the original user intent so replay keeps the same task context" },
        path: { type: "string", description: "Drill into a nested response path" },
        extract: { type: "string", description: "Pick specific fields" },
        limit: { type: "number", description: "Cap array output to N items" },
        pretty: { type: "boolean", description: "Pretty-print JSON output" },
        dryRun: { type: "boolean", description: "Preview mutations" },
        confirmUnsafe: { type: "boolean", description: "Allow non-GET requests" },
      },
      required: ["skillId", "endpointId"],
    },
    outputSchema: TOOL_RESULT_SCHEMA,
  },
  {
    name: "unbrowse_login",
    title: "Capture Site Login",
    description: "Open an interactive browser login flow for a gated site so later Unbrowse calls can reuse the captured auth state. Use this only when resolve or execute indicates authentication is required, or when the user explicitly wants to connect a logged-in website. Login should target the exact page or workflow surface the user cares about, then later Unbrowse calls should retry that same URL instead of drifting to the homepage, marketing pages, help pages, public mirrors, or alternate domains. Do not use this for ordinary public pages.",
    annotations: {
      title: "Capture Site Login",
      openWorldHint: true,
    },
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Concrete site or login page URL that needs auth cookies" },
      },
      required: ["url"],
    },
    outputSchema: TOOL_RESULT_SCHEMA,
  },
  {
    name: "unbrowse_skills",
    title: "List Cached Skills",
    description: "Debug/admin tool. List locally cached Unbrowse skills on this machine. Use this for inspection or troubleshooting, not as the normal first step for website tasks.",
    annotations: {
      title: "List Cached Skills",
      readOnlyHint: true,
    },
    inputSchema: { type: "object" as const, additionalProperties: false, properties: {} },
    outputSchema: TOOL_RESULT_SCHEMA,
  },
  {
    name: "unbrowse_skill",
    title: "Inspect One Cached Skill",
    description: "Debug/admin tool. Inspect one known cached Unbrowse skill, including endpoint IDs and schemas. Use this only after you already have a skillId and need to inspect it; not as the primary path for a new website task.",
    annotations: {
      title: "Inspect One Cached Skill",
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        skillId: { type: "string", description: "Known skill ID returned by another Unbrowse tool" },
      },
      required: ["skillId"],
    },
    outputSchema: TOOL_RESULT_SCHEMA,
  },
  {
    name: "unbrowse_health",
    title: "Check Unbrowse Health",
    description: "Debug/admin tool. Check whether the Unbrowse CLI and local server are installed and reachable. Use this for setup or troubleshooting, not as part of a normal website workflow.",
    annotations: {
      title: "Check Unbrowse Health",
      readOnlyHint: true,
    },
    inputSchema: { type: "object" as const, additionalProperties: false, properties: {} },
    outputSchema: TOOL_RESULT_SCHEMA,
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

function parseCliJson(stdout: string): JsonValue | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return undefined;
  }
}

function stringifyForText(value: JsonValue | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function buildToolSuccess(toolName: string, stdout: string) {
  const parsed = parseCliJson(stdout);
  const trimmed = stdout.trim();
  return {
    content: [{ type: "text" as const, text: stringifyForText(parsed, trimmed || "OK") }],
    structuredContent: {
      ok: true,
      tool: toolName,
      ...(parsed !== undefined ? { data: parsed } : {}),
      ...(trimmed ? { rawText: trimmed } : {}),
    } satisfies ToolStructuredResult,
  };
}

function buildToolError(toolName: string, errorText: string, stdout = "") {
  const parsed = parseCliJson(stdout);
  const trimmed = stdout.trim();
  return {
    content: [{ type: "text" as const, text: `Error: ${errorText}` }],
    structuredContent: {
      ok: false,
      tool: toolName,
      error: errorText,
      ...(parsed !== undefined ? { data: parsed } : {}),
      ...(trimmed ? { rawText: trimmed } : {}),
    } satisfies ToolStructuredResult,
    isError: true,
  };
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
          process.stdout.write(jsonRpcResponse(id, buildToolError(toolName, errorText, result.stdout)));
        } else {
          process.stdout.write(jsonRpcResponse(id, buildToolSuccess(toolName, result.stdout)));
        }
      } catch (err) {
        process.stdout.write(jsonRpcResponse(
          id,
          buildToolError(toolName, err instanceof Error ? err.message : String(err)),
        ));
      }
      break;
    }

    default:
      process.stdout.write(jsonRpcError(id, -32601, `Method not found: ${method}`));
  }
}
