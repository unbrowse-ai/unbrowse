// `unbrowse mcp`: a local stdio MCP server that forwards to the hosted remote MCP.
// For hosts that only run stdio servers, or that reject tool names with dots (Grok: letters, digits, `_`, `-`):
// `unbrowse.scrape` is listed as `unbrowse_scrape` and mapped back on the call. Auth is the CLI's own
// (UNBROWSE_API_KEY, `unbrowse login --key`, or the `unbrowse login` OAuth token, refreshed per call).
import { createInterface } from "node:readline";
import { UnbrowseError, UnbrowseMcp } from "@unbrowse/sdk";
import type { McpTool, RunRequest, Unbrowse } from "@unbrowse/sdk";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Upstream = Pick<UnbrowseMcp, "rpc" | "listTools">;

/** A host-safe tool name: anything outside [A-Za-z0-9_-] becomes `_`, capped at 64 characters. */
export function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** A tool this proxy answers itself: it can read this machine's agent configs, which the hosted server cannot. */
export const LOCAL_MCPS: McpTool = {
  name: "unbrowse_local_mcps",
  description:
    "The MCP servers configured in this machine's agents (Claude Code, Claude Desktop, Cursor, Codex, VS Code, Windsurf, Gemini, Zed), read by this local Unbrowse server: name, agent, remote address or local command, and the NAMES of any headers and env vars (never their values). import: true brings them into Unbrowse through unbrowse_import_mcps (remote ones by address, local ones as their hosted app; Unbrowse itself and duplicates skipped); dryRun: true shows that plan. Keys stay on this machine; for a server that needs one, the person opens the returned link, or runs `unbrowse mcps import --with-keys` in a terminal.",
  inputSchema: {
    type: "object",
    properties: {
      import: { type: "boolean", description: "Import them into Unbrowse" },
      dryRun: { type: "boolean", description: "With import: show the plan without connecting anything" },
      names: { type: "array", items: { type: "string" }, description: "Only these servers (by their config name)" },
    },
    additionalProperties: false,
  },
};

async function localMcps(args: Record<string, unknown>, upstream: () => Promise<Upstream>): Promise<unknown> {
  const A = await import("./agent-mcps.ts");
  const { servers, skipped } = A.scan();
  const names = Array.isArray(args.names) ? new Set(args.names.map(String)) : undefined;
  const pick = servers.filter((s) => !names || names.has(s.name));
  const listing = pick.map(({ file: _f, ...s }) => s);
  if (args.import !== true) {
    return { content: [{ type: "text", text: JSON.stringify({ servers: listing, skipped: skipped.map((x) => x.why) }, null, 2) }], structuredContent: { servers: listing }, isError: false };
  }
  const send = A.unique(pick.filter((s) => !s.self)).map(A.toImport);
  if (!send.length) return { content: [{ type: "text", text: "No MCP servers to import." }], isError: false };
  return (await upstream()).rpc("tools/call", { name: "unbrowse_import_mcps", arguments: { servers: send, ...(args.dryRun === true ? { dryRun: true } : {}) } });
}

/** What `unbrowse_run` takes that a run request carries (the rest, such as select, stay with the hosted tool). */
const RUN_KEYS = ["capability", "task", "targetUrl", "input", "accountRefs", "interactionMode", "idempotencyKey", "allowedDestinations"] as const;
const RESULT_MAX = 40_000;

/**
 * `unbrowse_run` with the site requests sent from this machine (--from-here): the same client-egress loop as
 * `unbrowse run`, so an agent on its own computer (a Grok Bot, a dev box) uses that computer's IP and teaches
 * Unbrowse the route as it goes. Each request is noted on stderr; stdout stays protocol only.
 */
export function localRun(rest: () => Promise<Pick<Unbrowse, "runOnClient">>, log: (line: string) => void = (l) => void process.stderr.write(`${l}\n`)) {
  return async (args: Record<string, unknown>) => {
    const request = Object.fromEntries(RUN_KEYS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]])) as RunRequest;
    const deadline = Number(args.deadlineMs);
    const view = await (await rest()).runOnClient(request, { onRequest: (r) => log(`→ ${r.method} ${r.url}`), timeoutMs: Math.max(120_000, Number.isFinite(deadline) ? deadline : 0) });
    const text = JSON.stringify(view);
    return { content: [{ type: "text", text: text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}…` : text }], structuredContent: view, isError: false };
  };
}

/** The proxy's message handler; `upstream` is built per call so OAuth tokens stay fresh. */
export function createProxy(upstream: () => Promise<Upstream>, version: string, opts: { runLocal?: (args: Record<string, unknown>) => Promise<unknown> } = {}) {
  const names = new Map<string, string>(); // safe → upstream name

  async function list(): Promise<McpTool[]> {
    const tools = await (await upstream()).listTools();
    names.clear();
    const out: McpTool[] = [LOCAL_MCPS];
    for (const t of tools) {
      const safe = safeToolName(t.name);
      if (names.has(safe)) continue; // two upstream names collapse to one: keep the first
      names.set(safe, t.name);
      out.push({ ...t, name: safe });
    }
    return out;
  }

  async function original(safe: string): Promise<string> {
    if (!names.has(safe)) await list();
    return names.get(safe) ?? safe;
  }

  return async function handle(msg: Rpc): Promise<Rpc | undefined> {
    if (msg.id === undefined || msg.id === null) return undefined; // notifications need no answer
    const reply = (result: unknown): Rpc => ({ jsonrpc: "2.0", id: msg.id, result } as Rpc);
    try {
      switch (msg.method) {
        case "initialize": {
          const asked = String(msg.params?.protocolVersion ?? "");
          return reply({
            protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "unbrowse", title: "Unbrowse (local proxy to the hosted MCP)", version },
            instructions: "Unbrowse is the browserless browser. Prefer unbrowse_discover then unbrowse_run; unbrowse_scrape reads a page; unbrowse_browse_* drive the cloud browser. input_required is not a failure: answer it with unbrowse_resume.",
          });
        }
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: await list() });
        case "tools/call": {
          const name = String(msg.params?.name ?? "");
          if (name === LOCAL_MCPS.name) return reply(await localMcps((msg.params?.arguments ?? {}) as Record<string, unknown>, upstream));
          if (opts.runLocal && (await original(name)) === "unbrowse_run") return reply(await opts.runLocal((msg.params?.arguments ?? {}) as Record<string, unknown>));
          return reply(await (await upstream()).rpc("tools/call", { ...msg.params, name: await original(name) }));
        }
        default:
          return reply(await (await upstream()).rpc(String(msg.method), msg.params));
      }
    } catch (e) {
      const err = e as UnbrowseError;
      const code = err instanceof UnbrowseError ? err.code : "proxy_error";
      const hint = err instanceof UnbrowseError && err.status === 401 ? " Run `unbrowse login` (or set UNBROWSE_API_KEY) and restart this server." : "";
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `${err.message}${hint}`, data: { code } } } as never;
    }
  };
}

/** Serve newline-delimited JSON-RPC on stdin/stdout until stdin closes. Logs go to stderr only. */
export async function serveStdio(opts: { url: string; token: () => Promise<string | undefined>; version: string; endUser?: string; fromHere?: () => Promise<Pick<Unbrowse, "runOnClient">> }): Promise<void> {
  const handle = createProxy(async () => new UnbrowseMcp({ url: opts.url, apiKey: (await opts.token()) ?? "", endUser: opts.endUser, client: `cli-mcp/${opts.version}` }), opts.version, opts.fromHere ? { runLocal: localRun(opts.fromHere) } : {});
  // Resolve only once the line is flushed: the CLI exits after stdin closes, which would cut a large tools/list.
  const write = (m: unknown) => new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(m)}\n`, () => resolve()));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line);
    } catch {
      pending.add(write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      continue;
    }
    const p = handle(msg).then((res) => (res ? write(res) : undefined));
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}
