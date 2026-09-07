/**
 * The obscura SESSION BROKER — a live page session that survives across separate
 * CLI invocations, with no Chrome.
 *
 * unbrowse's breath/eval handlers share one page across calls: `breath go`
 * navigates, then `eval text` / `breath click` act on that same page in later
 * processes. With Chrome that lived in a persisted `chromeWsUrl`; here it lives
 * in a long-lived `obscura mcp --http` process. obscura's HTTP MCP server holds
 * one shared page (single V8 isolate, no per-request session id), so any process
 * that POSTs to `http://127.0.0.1:<port>/mcp` drives the SAME live page —
 * confirmed live: fill in process A, read it back "zed" in process B.
 *
 * A broker session is one detached `obscura mcp --http` process, recorded in
 * ~/.unbrowse/obscura-sessions/<id>.json as { port, pid }. `attach` reconnects
 * by port; `stop` kills the process and removes the record. This mirrors kuri's
 * per-session broker, on obscura primitives.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { nanoid } from "nanoid";
import { firstExisting, obscuraVendorCandidatePaths } from "./resolve-bin.js";

export interface ObscuraSessionRecord {
  sessionId: string;
  port: number;
  pid: number;
  createdAt: number;
  bin: string;
}

// --- pure helpers (unit-testable) -------------------------------------------

/** Directory holding broker session records. HOME / env overridable for tests. */
export function sessionsDir(env: Record<string, string | undefined> = process.env): string {
  return env.UNBROWSE_OBSCURA_SESSIONS_DIR ?? join(env.HOME ?? homedir(), ".unbrowse", "obscura-sessions");
}

export function sessionFile(id: string, env?: Record<string, string | undefined>): string {
  return join(sessionsDir(env), `${id}.json`);
}

/** obscura argv for an HTTP MCP server on a port. Pure. */
export function buildMcpHttpArgs(port: number, extra: string[] = []): string[] {
  return ["mcp", "--http", "--host", "127.0.0.1", "--port", String(port), ...extra];
}

/**
 * Extract the joined text of a tools/call JSON-RPC reply. Accepts either a plain
 * JSON body or an SSE `data: {…}` frame (obscura returns plain JSON, but be lenient).
 */
export function parseToolText(raw: string): string {
  let body = raw.trim();
  const sse = body.match(/data:\s*(\{[\s\S]*\})/);
  if (sse) body = sse[1];
  try {
    const msg = JSON.parse(body);
    if (msg.error) throw new Error(`obscura mcp error: ${JSON.stringify(msg.error)}`);
    const content = msg.result?.content ?? [];
    return content.map((c: { text?: string }) => c.text ?? "").join("\n");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("obscura mcp error")) throw e;
    return "";
  }
}

function resolveObscuraCli(env: Record<string, string | undefined> = process.env): string | null {
  const candidates = obscuraVendorCandidatePaths({
    bin: "obscura",
    execDir: dirname(process.execPath),
    moduleDir: import.meta.dirname,
    env,
  });
  return firstExisting(candidates.slice(0, -1), existsSync) ?? candidates[candidates.length - 1] ?? null;
}

/** Grab a free loopback TCP port (ephemeral bind, then release). */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

// --- HTTP MCP client (reattaches to a broker's port) ------------------------

export class ObscuraHttpClient {
  private id = 0;
  private started = false;
  constructor(
    private port: number,
    private fetchImpl: typeof fetch = fetch,
    private host = "127.0.0.1",
  ) {}

  private async rpc(method: string, params?: unknown): Promise<string> {
    const res = await this.fetchImpl(`http://${this.host}:${this.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    return await res.text();
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "unbrowse", version: "0" },
    });
    this.started = true;
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (!this.started) await this.start();
    return parseToolText(await this.rpc("tools/call", { name, arguments: args }));
  }

  /**
   * How a target is named to obscura. unbrowse callers pass either a CSS
   * selector or an accessibility ref from a snapshot (`e3`, `@e3`, `[e3]`).
   * obscura's own resolver reads `ref` first and `selector` second, so a ref is
   * sent AS a ref — passing `e3` as a CSS selector would silently match the
   * `<e3>` element type and act on nothing.
   */
  static targetArgs(target: string): { ref: string } | { selector: string } {
    const m = String(target).trim().match(/^@?\[?(e\d+)\]?$/i);
    return m ? { ref: m[1].toLowerCase() } : { selector: target };
  }

  navigate(url: string) { return this.tool("browser_navigate", { url }); }
  back() { return this.tool("browser_back"); }
  forward() { return this.tool("browser_forward"); }
  reload() { return this.tool("browser_reload"); }
  /** Actionable elements as `ref=eN <role> "label"` lines — backs `eval snap`. */
  interactiveElements() { return this.tool("browser_interactive_elements"); }
  markdown() { return this.tool("browser_markdown"); }
  snapshot() { return this.tool("browser_snapshot"); }
  click(target: string) { return this.tool("browser_click", ObscuraHttpClient.targetArgs(target)); }
  fill(target: string, value: string) { return this.tool("browser_fill", { ...ObscuraHttpClient.targetArgs(target), value }); }
  type(target: string, text: string) { return this.tool("browser_type", { ...ObscuraHttpClient.targetArgs(target), text }); }
  press(key: string) { return this.tool("browser_press_key", { key }); }
  selectOption(target: string, value: string) { return this.tool("browser_select_option", { ...ObscuraHttpClient.targetArgs(target), value }); }
  /**
   * Fill several fields in one round-trip, optionally clicking a submit target
   * afterwards. Each field takes a `selector` OR a `ref` (same targeting rule as
   * the single-field actuators) plus a `value`.
   */
  fillForm(
    fields: Array<{ selector?: string; ref?: string; value: string; type?: "text" | "check" | "uncheck" | "select" }>,
    submit?: string,
  ) {
    const args: Record<string, unknown> = { fields };
    if (submit) {
      const t = ObscuraHttpClient.targetArgs(submit);
      if ("ref" in t) args.submit_ref = t.ref;
      else args.submit_selector = t.selector;
    }
    return this.tool("browser_fill_form", args);
  }
  scroll(args: Record<string, unknown> = {}) { return this.tool("browser_scroll", args); }
  evaluate(expression: string) { return this.tool("browser_evaluate", { expression }); }
  getCookies() { return this.tool("browser_get_cookies"); }
  text() { return this.evaluate("document.body ? document.body.innerText : ''"); }
}

// --- broker lifecycle -------------------------------------------------------

async function waitReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const client = new ObscuraHttpClient(port);
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await client.start();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`obscura mcp --http did not become ready on :${port}: ${String(lastErr)}`);
}

export interface StartSessionOptions {
  binPath?: string;
  extraArgs?: string[];
  readyTimeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Brokers THIS process spawned, keyed by sessionId. The broker is `detached`
 * (its own process group) and `unref`'d so it survives a parent exit — which is
 * exactly why an agent session that dies without `breath close` would ORPHAN it
 * and, across sessions, pile trees up into OOM. `reapOwnSessions()` (wired to
 * MCP-server shutdown) kills precisely these, and only these, so a peer session's
 * brokers are never touched. `env` per session so a test-scoped sessions dir is
 * cleaned up correctly.
 */
const ownSessions = new Map<string, Record<string, string | undefined> | undefined>();

/** Spawn a detached obscura HTTP MCP server, record it, return its handle. */
export async function startObscuraSession(opts: StartSessionOptions = {}): Promise<ObscuraSessionRecord> {
  const bin = opts.binPath ?? resolveObscuraCli(opts.env);
  if (!bin) throw new Error("obscura CLI not found (set UNBROWSE_OBSCURA_BIN)");
  const port = await pickFreePort();
  const child = spawn(bin, buildMcpHttpArgs(port, opts.extraArgs ?? []), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await waitReady(port, opts.readyTimeoutMs ?? 15000);
  const rec: ObscuraSessionRecord = {
    sessionId: nanoid(),
    port,
    pid: child.pid ?? -1,
    createdAt: Date.now(),
    bin,
  };
  const dir = sessionsDir(opts.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(sessionFile(rec.sessionId, opts.env), JSON.stringify(rec, null, 2), { mode: 0o600 });
  ownSessions.set(rec.sessionId, opts.env);
  return rec;
}

/**
 * Best-effort check that `pid` is still an obscura broker before we group-kill
 * it — guards against PID reuse (the recorded pid could have been recycled by an
 * unrelated process after the broker died). Linux `/proc/<pid>/cmdline` is
 * NUL-separated argv; a non-Linux host (no /proc) returns true (best-effort).
 */
function isLiveObscuraBroker(pid: number, bin: string): boolean {
  if (pid <= 1) return false;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (cmdline.length === 0) return false; // zombie / gone
    const argv = cmdline.split("\0");
    return argv.some((a) => a === bin || a.endsWith("/obscura") || a === "obscura" || a === "mcp");
  } catch (err) {
    // ENOENT => the pid is gone (not live); any other error (or no /proc) =>
    // fall back to a liveness check so we still reap on non-Linux hosts.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Kill a broker's whole process GROUP and remove its record. The broker was
 * spawned `detached`, so it leads its own group (pgid === pid); the NEGATIVE pid
 * therefore reaps the broker AND any obscura-worker/child it spawned in one
 * signal, rather than orphaning the grandchildren the way a single-pid kill
 * would. SIGTERM first (let obscura release its page), then SIGKILL as the
 * guarantee. Verifies the pid is still an obscura broker first (PID-reuse safe).
 */
export function killBrokerTree(rec: ObscuraSessionRecord, env?: Record<string, string | undefined>): void {
  if (rec.pid > 1 && isLiveObscuraBroker(rec.pid, rec.bin)) {
    try {
      process.kill(-rec.pid, "SIGTERM");
    } catch {
      /* group already gone */
    }
    // A short grace, then SIGKILL the group. Synchronous so this is safe to call
    // from a `process.on('exit')` backstop where async work cannot run.
    if (isLiveObscuraBroker(rec.pid, rec.bin)) {
      try {
        process.kill(-rec.pid, "SIGKILL");
      } catch {
        /* gone between the two signals */
      }
    }
  }
  try {
    rmSync(sessionFile(rec.sessionId, env));
  } catch {
    /* already gone */
  }
}

/**
 * Reap every broker THIS process spawned. Wired to MCP-server shutdown (stdin
 * EOF, SIGINT/SIGTERM/SIGHUP, and a synchronous `process.on('exit')` backstop)
 * so an agent session that ends without an explicit `breath close` cannot leave
 * an orphaned obscura tree behind. Fully synchronous and idempotent — safe to
 * call from an exit handler and safe to call more than once. Returns the number
 * of tracked brokers it acted on.
 */
export function reapOwnObscuraSessions(): number {
  let n = 0;
  for (const [sessionId, env] of Array.from(ownSessions.entries())) {
    ownSessions.delete(sessionId);
    const rec = readObscuraSession(sessionId, env);
    if (rec) {
      killBrokerTree(rec, env);
      n += 1;
    }
  }
  return n;
}

/** Session ids this process spawned and still tracks (for tests/observability). */
export function ownObscuraSessionIds(): string[] {
  return Array.from(ownSessions.keys());
}

/** Read a broker record (or null if unknown). */
export function readObscuraSession(sessionId: string, env?: Record<string, string | undefined>): ObscuraSessionRecord | null {
  const f = sessionFile(sessionId, env);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ObscuraSessionRecord;
  } catch {
    return null;
  }
}

/** Reattach a client to a live broker session by id. */
export function attachObscuraSession(
  sessionId: string,
  opts?: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> },
): ObscuraHttpClient {
  const rec = readObscuraSession(sessionId, opts?.env);
  if (!rec) throw new Error(`no obscura session ${sessionId}`);
  return new ObscuraHttpClient(rec.port, opts?.fetchImpl);
}

/** Kill a broker session's whole process tree and remove its record. */
export function stopObscuraSession(sessionId: string, env?: Record<string, string | undefined>): boolean {
  const rec = readObscuraSession(sessionId, env);
  // Untrack regardless: an explicitly-stopped session must not also be reaped by
  // the shutdown sweep (and a missing record still clears any stale tracking).
  ownSessions.delete(sessionId);
  if (!rec) return false;
  // Group-kill (broker leads its own detached group) so an obscura-worker child
  // is reaped with it, not orphaned — the same fix the shutdown sweep relies on.
  killBrokerTree(rec, env);
  return true;
}

/** List known broker session ids. */
export function listObscuraSessions(env?: Record<string, string | undefined>): string[] {
  const dir = sessionsDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}
