/**
 * Chrome-free live-page SESSION on obscura's MCP server.
 *
 * unbrowse's breath actuators — navigate/click/fill/type/press/select/scroll —
 * need a STATEFUL page session (the DOM persists across calls). obscura's MCP
 * server (`obscura mcp`, stdio) provides exactly that with no Chrome and no CDP:
 * probed live, navigate → fill → read-back → detect_forms all hold within a
 * session. This driver speaks the MCP JSON-RPC line protocol and exposes the
 * actuators + readers the breath/eval handlers call.
 *
 * The transport is injectable so the framing and tool-argument construction are
 * unit-testable without spawning a real obscura process.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { firstExisting, obscuraVendorCandidatePaths } from "./resolve-bin.js";

/** Line-delimited JSON-RPC transport. */
export interface McpTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  close(): void;
}

/** Default transport: spawn `obscura mcp` and frame its stdio by newline. */
export function spawnObscuraMcpTransport(bin: string, extraArgs: string[] = []): McpTransport {
  const child = spawn(bin, ["mcp", ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let lineCb: ((line: string) => void) | null = null;
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() && lineCb) lineCb(line);
    }
  });
  child.stderr.on("data", () => {}); // obscura logs to stderr; ignore
  return {
    send: (line) => child.stdin.write(line + "\n"),
    onLine: (cb) => {
      lineCb = cb;
    },
    close: () => child.kill(),
  };
}

function resolveObscuraMcpBin(env: Record<string, string | undefined> = process.env): string | null {
  const candidates = obscuraVendorCandidatePaths({
    bin: "obscura",
    execDir: dirname(process.execPath),
    moduleDir: import.meta.dirname,
    env,
  });
  return firstExisting(candidates.slice(0, -1), existsSync) ?? candidates[candidates.length - 1] ?? null;
}

export interface ObscuraMcpSessionOptions {
  binPath?: string;
  /** Inject a transport (tests); default spawns `obscura mcp`. */
  transport?: McpTransport;
  /** Extra obscura args, e.g. ["--stealth"]. */
  extraArgs?: string[];
  /** Per-call timeout (ms). */
  callTimeoutMs?: number;
}

interface RpcResult {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: unknown;
}

/** A live obscura page session driven over MCP (no Chrome, no CDP). */
export class ObscuraMcpSession {
  private transport: McpTransport;
  private pending = new Map<number, (msg: RpcResult) => void>();
  private nextId = 0;
  private started = false;
  private callTimeoutMs: number;

  constructor(opts: ObscuraMcpSessionOptions = {}) {
    this.callTimeoutMs = opts.callTimeoutMs ?? 30000;
    if (opts.transport) {
      this.transport = opts.transport;
    } else {
      const bin = opts.binPath ?? resolveObscuraMcpBin();
      if (!bin) throw new Error("obscura CLI not found (set UNBROWSE_OBSCURA_BIN)");
      this.transport = spawnObscuraMcpTransport(bin, opts.extraArgs ?? []);
    }
    this.transport.onLine((line) => {
      let msg: (RpcResult & { id?: number }) | null = null;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  private call(method: string, params: unknown): Promise<RpcResult> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`obscura mcp call timed out: ${method}`));
      }, this.callTimeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Extract the joined text content of a tools/call result. */
  private static text(msg: RpcResult): string {
    return (msg.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "unbrowse", version: "0" },
    });
    this.started = true;
  }

  /** Call a browser_* tool and return its joined text output. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (!this.started) await this.start();
    const msg = await this.call("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(`obscura mcp ${name} failed: ${JSON.stringify(msg.error)}`);
    return ObscuraMcpSession.text(msg);
  }

  // --- readers -------------------------------------------------------------
  navigate(url: string): Promise<string> { return this.tool("browser_navigate", { url }); }
  snapshot(): Promise<string> { return this.tool("browser_snapshot"); }
  markdown(): Promise<string> { return this.tool("browser_markdown"); }
  links(): Promise<string> { return this.tool("browser_links"); }
  detectForms(): Promise<string> { return this.tool("browser_detect_forms"); }
  networkRequests(): Promise<string> { return this.tool("browser_network_requests"); }
  getCookies(): Promise<string> { return this.tool("browser_get_cookies"); }
  evaluate(expression: string): Promise<string> { return this.tool("browser_evaluate", { expression }); }
  async text(): Promise<string> {
    return this.evaluate("document.body ? document.body.innerText : ''");
  }

  // --- actuators -----------------------------------------------------------
  click(selector: string): Promise<string> { return this.tool("browser_click", { selector }); }
  fill(selector: string, value: string): Promise<string> { return this.tool("browser_fill", { selector, value }); }
  type(selector: string, text: string): Promise<string> { return this.tool("browser_type", { selector, text }); }
  press(key: string): Promise<string> { return this.tool("browser_press_key", { key }); }
  selectOption(selector: string, value: string): Promise<string> { return this.tool("browser_select_option", { selector, value }); }
  scroll(args: Record<string, unknown> = {}): Promise<string> { return this.tool("browser_scroll", args); }
  setCookie(cookie: Record<string, unknown>): Promise<string> { return this.tool("browser_set_cookie", cookie); }

  dispose(): void {
    this.transport.close();
  }
}
