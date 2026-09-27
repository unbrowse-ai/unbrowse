// A minimal client for the hosted remote MCP (JSON-RPC over streamable HTTP, stateless). Host plugins that
// cannot mount a remote MCP server themselves (elizaOS, OpenClaw tools) call Unbrowse through this.
import { UnbrowseError } from "./client.ts";
import type { Json } from "./types.ts";

export const DEFAULT_MCP_URL = "https://unbrowse.ai/mcp";
/** Sent as `Mcp-Protocol-Version`. The hosted server refuses 2025-06-18 on its streaming path. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

export type McpOptions = {
  /** API key (`ub_live_…`) or OAuth access token. Defaults to `UNBROWSE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `UNBROWSE_MCP_URL`, then https://unbrowse.ai/mcp. */
  url?: string;
  /** Org keys: the end user the call is for (`X-Unbrowse-End-User`). */
  endUser?: string;
  fetch?: typeof globalThis.fetch;
  /** Client name sent on the wire (User-Agent suffix). */
  client?: string;
};

export type McpTool = { name: string; description?: string; inputSchema: { type: "object"; properties?: Record<string, Json>; required?: string[] } & Record<string, unknown> };
export type McpContent = { type: string; text?: string } & Record<string, unknown>;
export type McpToolResult = { content: McpContent[]; structuredContent?: Json; isError?: boolean };

const env = (name: string): string | undefined => (typeof process !== "undefined" ? process.env?.[name] : undefined) || undefined;

/** The JSON-RPC message in a response body: plain JSON, or the last `data:` event of an SSE stream. */
export function parseRpcBody(text: string): { result?: unknown; error?: { code: number; message: string; data?: { code?: string } & Record<string, unknown> } } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const events = trimmed.split(/\n\n+/).flatMap((block) => {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    return data ? [data] : [];
  });
  if (!events.length) throw new UnbrowseError("Empty MCP response", 502, "mcp_empty");
  return JSON.parse(events[events.length - 1]);
}

/** Plain text of a tool result: its text parts, else its structured content as JSON. */
export function resultText(result: McpToolResult): string {
  const text = result.content?.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
  return text || (result.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent));
}

export class UnbrowseMcp {
  readonly url: string;
  private apiKey?: string;
  private endUser?: string;
  private client: string;
  private fetchImpl: typeof globalThis.fetch;
  private nextId = 1;

  constructor(opts: McpOptions = {}) {
    this.url = (opts.url ?? env("UNBROWSE_MCP_URL") ?? DEFAULT_MCP_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? env("UNBROWSE_API_KEY");
    this.endUser = opts.endUser ?? env("UNBROWSE_END_USER");
    this.client = opts.client ?? "sdk";
    this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  /** One JSON-RPC call. MCP errors become UnbrowseError with the server's `data.code` (e.g. `browser_capacity`). */
  async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...(this.endUser ? { "x-unbrowse-end-user": this.endUser } : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "user-agent": `unbrowse-${this.client}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, ...(params ? { params } : {}) }),
    });
    const text = await res.text();
    if (!res.ok) {
      let body: { error?: string | { code?: string; message?: string }; error_description?: string } = {};
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      const err = typeof body.error === "object" ? body.error : undefined;
      throw new UnbrowseError(err?.message ?? body.error_description ?? (res.statusText || `HTTP ${res.status}`), res.status, err?.code ?? (typeof body.error === "string" ? body.error : "http_error"), body);
    }
    const msg = parseRpcBody(text);
    if (msg.error) throw new UnbrowseError(msg.error.message, 200, msg.error.data?.code ?? `rpc_${msg.error.code}`, msg.error);
    return msg.result as T;
  }

  /** Every tool this key can call: the core tools plus the workspace's learned and indexed ones. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc<{ tools: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    return this.rpc<McpToolResult>("tools/call", { name, arguments: args });
  }
}
