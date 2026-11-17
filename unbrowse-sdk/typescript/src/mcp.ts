// `unbrowse mcp`: the node's MCP server for an agent that starts its MCP servers as programs (Claude Code, Codex).
//
// The agent speaks MCP over stdio to this process, and it sends each message on to the node's `/mcp` through the SDK's
// one sending function, signed with the agent token (`signed.ts`): the token never goes over the wire, and an answer
// reaches the agent only when the node signed it. An agent handed the token for its own HTTP transport would send it to
// whatever answers at the node's address.

import { createInterface } from "node:readline";
import { DEFAULT_NODE, env, send, trimBase, type Line } from "./http.js";

export type BridgeOptions = {
  /** The node's address. Default: UNBROWSE_NODE, else the node's default. */
  baseUrl?: string;
  /** The agent token. Default: UNBROWSE_AGENT_TOKEN. */
  token?: string;
  /** How long one message may take: a tool call can walk a page, which takes minutes. Default 330 s, as the SDKs wait. */
  timeoutMs?: number;
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): unknown };
  fetch?: typeof globalThis.fetch;
};

/** Relays MCP messages, one JSON-RPC message per line, between `input`/`output` and the node, until `input` ends and
 * every answer is written. */
export async function bridge(opts: BridgeOptions = {}): Promise<void> {
  const token = opts.token ?? env("UNBROWSE_AGENT_TOKEN");
  const line: Line = {
    baseUrl: trimBase(opts.baseUrl ?? env("UNBROWSE_NODE") ?? DEFAULT_NODE),
    token,
    timeoutMs: opts.timeoutMs ?? 330_000,
    fetch: opts.fetch ?? globalThis.fetch,
  };
  const output = opts.output ?? process.stdout;
  const write = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const refuse = (id: unknown, code: number, message: string) => {
    // A notification (no id) is answered by nobody.
    if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, error: { code, message } });
  };

  // The node opens an MCP session at `initialize`; every message after it carries that session's id.
  let session: string | undefined;
  let opened: Promise<void> = Promise.resolve();

  const forward = async (message: any): Promise<void> => {
    const id = message && typeof message === "object" ? message.id : undefined;
    if (!token) return refuse(id, -32001, "no agent token: set UNBROWSE_AGENT_TOKEN");
    try {
      const res: Response = await send(line, "POST", "/mcp", {
        body: message,
        raw: true,
        accept: "application/json",
        headers: session ? { "mcp-session-id": session } : undefined,
      });
      if (message?.method === "initialize") session = res.headers.get("mcp-session-id") ?? session;
      const text = await res.text();
      if (id === undefined || id === null || !text) return;
      write(JSON.parse(text));
    } catch (e) {
      refuse(id, -32001, (e as Error).message);
    }
  };

  const pending = new Set<Promise<void>>();
  for await (const raw of createInterface({ input: opts.input ?? process.stdin, crlfDelay: Infinity })) {
    if (!raw.trim()) continue;
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } });
      continue;
    }
    for (const one of Array.isArray(message) ? message : [message]) {
      // Messages after `initialize` wait for its session; the rest run side by side (a tool call can take minutes).
      const sent = one?.method === "initialize" ? (opened = opened.then(() => forward(one))) : opened.then(() => forward(one));
      pending.add(sent);
      sent.finally(() => pending.delete(sent));
    }
  }
  await Promise.all(pending);
}
