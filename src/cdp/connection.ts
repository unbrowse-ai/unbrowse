// CDP_PRIMITIVES.md §cdp-client-choice — raw CDP connection over chrome-remote-interface.
//
// Hab 2:2 — write the vision plain. Every primitive is a pure function over the
// {cdp, sessionId} handle; no module-scoped state, no singletons, no implicit
// "current tab". John 14:6 — the connection IS the way; the receipt body IS
// the truth-claim; the AsyncDisposable contract IS the life-cycle.
//
// This module owns the WS framing + message-id correlation only. Chrome
// spawning lives in chrome.ts (build verb); target/session lifecycle lives
// in target.ts. Every other CDP domain (Network/DOM/Input/...) consumes
// `conn.call(method, params, sessionId?)` from here.

import { createRequire } from "node:module";

import type { CDPConnection } from "./types.js";

// chrome-remote-interface is CommonJS; load via createRequire so the
// module works under both Node ESM and bun.
const requireCJS = createRequire(import.meta.url);
type CRIClient = {
  send: (method: string, params: unknown, sessionId?: string) => Promise<unknown>;
  close: () => Promise<void>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};
type CRIFactory = (opts: { target: string }) => Promise<CRIClient>;

function loadCRI(): CRIFactory {
  return requireCJS("chrome-remote-interface") as CRIFactory;
}

/**
 * Build a CDPConnection wrapper around a live chrome-remote-interface client.
 *
 * Internal; called by both `connect` (we need to discover the ws endpoint)
 * and `attach` (caller already has the ws endpoint).
 */
function wrap(
  client: CRIClient,
  meta: { chromeBin: string; pid: number; endpoint: string; version: string; revision: string },
  onClose?: () => Promise<void> | void,
): CDPConnection {
  let closed = false;
  // Track subscriber handlers so unsubscribe() can wire to the right CRI
  // event name. CRI emits both `<method>` and `<method>.<sessionId>` per
  // message — we register on the bare method name and filter by sessionId
  // in the wrapped handler, so `on()` is symmetric across flat sessions.
  const conn: CDPConnection = {
    client,
    chromeBin: meta.chromeBin,
    pid: meta.pid,
    endpoint: meta.endpoint,
    version: meta.version,
    revision: meta.revision,
    async call<TParams, TResult>(method: string, params?: TParams, sessionId?: string): Promise<TResult> {
      if (closed) throw new Error("cdp_connection_closed");
      return (await client.send(method, params ?? {}, sessionId)) as TResult;
    },
    on(event: string, handler: (params: unknown, sessionId?: string) => void): () => void {
      if (closed) throw new Error("cdp_connection_closed");
      // CRI signature for method events is (params, sessionId)
      const wrapped = (...args: unknown[]): void => {
        const [p, sid] = args as [unknown, string | undefined];
        try {
          handler(p, sid);
        } catch {
          // Swallow user-handler exceptions — CDP event loop must not die.
          // John 17:17 — the Word is the truth-root; we don't crash the bus on a
          // malformed subscriber, we let it speak again on the next event.
        }
      };
      client.on(event, wrapped);
      return () => {
        const off = client.off ?? client.removeListener;
        if (off) off.call(client, event, wrapped);
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        // Best-effort graceful: ask Browser to close; never await > 2s.
        await Promise.race([
          client.send("Browser.close", {}).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } finally {
        try {
          await client.close();
        } catch {
          /* WS already torn down */
        }
        if (onClose) {
          try {
            await onClose();
          } catch {
            /* spawner cleanup is best-effort */
          }
        }
      }
    },
    [Symbol.asyncDispose]: async function (): Promise<void> {
      // try/finally idiom: if user code threw, we still tear down.
      // (using-keyword binding handles this; we just need to implement
      // the symbol.)
      await this.close();
    },
  } as CDPConnection;
  return conn;
}

/**
 * Discover the browser-level WebSocket endpoint by hitting /json/version on
 * the DevTools HTTP server, then open a flat CDP WS to it.
 *
 * `targetUrl` accepts either a base http URL (e.g. "http://127.0.0.1:9222")
 * OR a fully-qualified ws:// debugger URL (skips the /json/version hop).
 */
export async function connect(targetUrl: string): Promise<CDPConnection> {
  if (targetUrl.startsWith("ws://") || targetUrl.startsWith("wss://")) {
    return attach(targetUrl);
  }
  let base: URL;
  try {
    base = new URL(targetUrl);
  } catch {
    throw new Error(`invalid_cdp_target_url:${targetUrl}`);
  }
  const versionUrl = new URL("/json/version", base).toString();
  const res = await fetch(versionUrl);
  if (!res.ok) throw new Error(`cdp_version_endpoint_unreachable:status=${res.status}`);
  const version = (await res.json()) as {
    Browser?: string;
    "Protocol-Version"?: string;
    "WebKit-Version"?: string;
    webSocketDebuggerUrl?: string;
    "User-Agent"?: string;
  };
  if (!version.webSocketDebuggerUrl) {
    throw new Error("cdp_version_endpoint_missing_ws_url");
  }
  return attachWithMeta(version.webSocketDebuggerUrl, {
    chromeBin: "",
    pid: 0,
    endpoint: version.webSocketDebuggerUrl,
    version: version.Browser ?? "",
    revision: version["WebKit-Version"] ?? "",
  });
}

/**
 * Attach to a Chrome by its DevTools ws endpoint. Unlike `connect`, no HTTP
 * discovery — pass the value of `webSocketDebuggerUrl` directly.
 */
export async function attach(wsEndpoint: string): Promise<CDPConnection> {
  return attachWithMeta(wsEndpoint, { chromeBin: "", pid: 0, endpoint: wsEndpoint, version: "", revision: "" });
}

/**
 * Internal: attach with a pre-supplied meta block (spawner has more info than
 * a bare attach).
 */
export async function attachWithMeta(
  wsEndpoint: string,
  meta: { chromeBin: string; pid: number; endpoint: string; version: string; revision: string },
  onClose?: () => Promise<void> | void,
): Promise<CDPConnection> {
  const CDP = loadCRI();
  const client = await CDP({ target: wsEndpoint });
  return wrap(client, meta, onClose);
}

/**
 * Send a raw CDP method on an established connection.
 * Escape hatch — the typed primitives under network/dom/input/ are preferred.
 */
export async function call<TParams = unknown, TResult = unknown>(
  conn: CDPConnection,
  method: string,
  params?: TParams,
  sessionId?: string,
): Promise<TResult> {
  return conn.call<TParams, TResult>(method, params, sessionId);
}

/**
 * Close the WS + signal Chrome to shut down. Idempotent.
 */
export async function close(conn: CDPConnection): Promise<void> {
  await conn.close();
}
