import { setTimeout as delay } from "node:timers/promises";

type JsonRecord = Record<string, any>;

type CdpMessage =
  | { id: number; method: string; params?: JsonRecord; sessionId?: string }
  | { id: number; result?: JsonRecord; error?: JsonRecord }
  | { method: string; params?: JsonRecord; sessionId?: string };

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

export class CdpWsClient {
  private ws: any;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: any, raw: any) => void>>();

  static async connectFromHttpVersion(cdpHttpBase: string, timeoutMs = 10_000): Promise<CdpWsClient> {
    const base = String(cdpHttpBase || "").trim().replace(/\/$/, "");
    if (!base) throw new Error("cdpHttpBase is required");
    const resp = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`CDP /json/version failed (${resp.status}): ${text}`);
    }
    const data = (await resp.json().catch(() => ({}))) as { webSocketDebuggerUrl?: string };
    const wsUrl = String(data.webSocketDebuggerUrl || "").trim();
    if (!wsUrl) throw new Error("CDP webSocketDebuggerUrl missing");
    return CdpWsClient.connect(wsUrl, timeoutMs);
  }

  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpWsClient> {
    const WebSocket = (await import("ws")).default as any;
    const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP WS connect timeout (${timeoutMs}ms)`)), timeoutMs);
      t.unref?.();
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (err: any) => {
        clearTimeout(t);
        reject(err);
      });
    });
    return new CdpWsClient(ws);
  }

  private constructor(ws: any) {
    this.ws = ws;
    ws.on("message", (data: any) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString() : String(data);
        const msg = JSON.parse(text) as CdpMessage;

        if (typeof (msg as any).id === "number") {
          const id = (msg as any).id as number;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          const err = (msg as any).error;
          if (err) pending.reject(new Error(String(err?.message || JSON.stringify(err))));
          else pending.resolve((msg as any).result);
          return;
        }

        const method = (msg as any).method;
        if (typeof method !== "string") return;
        const set = this.listeners.get(method);
        if (!set || set.size === 0) return;
        for (const fn of set) fn((msg as any).params, msg);
      } catch {
        // ignore parse errors
      }
    });

    const onClose = (err?: any) => {
      const e = err instanceof Error ? err : new Error("CDP WS closed");
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id);
        pending.reject(e);
      }
    };
    ws.on("close", () => onClose());
    ws.on("error", (e: any) => onClose(e));
  }

  on(method: string, handler: (params: any, raw: any) => void): () => void {
    const key = String(method);
    const set = this.listeners.get(key) ?? new Set();
    set.add(handler);
    this.listeners.set(key, set);
    return () => {
      const s = this.listeners.get(key);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.listeners.delete(key);
    };
  }

  async send(method: string, params?: JsonRecord, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload: any = { id, method };
    if (params && typeof params === "object") payload.params = params;
    if (sessionId) payload.sessionId = sessionId;

    const p = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.ws.send(JSON.stringify(payload));
    return p;
  }

  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close?.();
    } catch {
      // ignore
    }
  }
}

export type CdpCapturedRequest = {
  requestId: string;
  method: string;
  url: string;
  type: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  timestamp: number;
  status?: number;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  responseBody?: string | null;
};

export async function captureCdpNetworkTraffic(opts: {
  cdpHttpBase: string;
  urls: string[];
  waitMs: number;
  keepTypes?: Set<string>;
  extraHeaders?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain: string; path?: string }>;
  onBeforeNavigate?: (sessionId: string) => Promise<void>;
}): Promise<{
  captured: CdpCapturedRequest[];
  cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  metaTokens: Record<string, string>;
}> {
  const client = await CdpWsClient.connectFromHttpVersion(opts.cdpHttpBase);
  try {
    const created = await client.send("Target.createTarget", { url: "about:blank" });
    const targetId = String(created?.targetId || "");
    if (!targetId) throw new Error("CDP Target.createTarget missing targetId");

    const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = String(attached?.sessionId || "");
    if (!sessionId) throw new Error("CDP attach missing sessionId");

    await client.send("Page.enable", {}, sessionId);
    await client.send("Network.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);

    if (opts.extraHeaders && Object.keys(opts.extraHeaders).length > 0) {
      await client.send("Network.setExtraHTTPHeaders", { headers: opts.extraHeaders }, sessionId).catch(() => {});
    }
    if (Array.isArray(opts.cookies) && opts.cookies.length > 0) {
      // Best-effort: not all CDP builds support Network.setCookies (vs Storage.setCookies).
      await client.send("Network.setCookies", { cookies: opts.cookies.map((c) => ({ ...c, path: c.path ?? "/" })) }, sessionId).catch(() => {});
    }

    if (opts.onBeforeNavigate) {
      await opts.onBeforeNavigate(sessionId);
    }

    const keep = opts.keepTypes ?? new Set(["xhr", "fetch"]);
    const byId = new Map<string, CdpCapturedRequest>();
    const order: string[] = [];

    const offReq = client.on("Network.requestWillBeSent", (params: any) => {
      const requestId = String(params?.requestId || "");
      const type = String(params?.type || "").toLowerCase();
      if (!requestId || !keep.has(type)) return;
      const req = params?.request || {};
      const method = String(req?.method || "GET");
      const url = String(req?.url || "");
      const headers = (req?.headers && typeof req.headers === "object") ? req.headers : {};
      const postData = typeof req?.postData === "string" ? req.postData : undefined;
      if (!url) return;
      if (!byId.has(requestId)) order.push(requestId);
      byId.set(requestId, {
        requestId,
        method,
        url,
        type,
        requestHeaders: headers,
        postData,
        timestamp: Date.now(),
      });
    });

    const offResp = client.on("Network.responseReceived", (params: any) => {
      const requestId = String(params?.requestId || "");
      const type = String(params?.type || "").toLowerCase();
      if (!requestId || !keep.has(type)) return;
      const entry = byId.get(requestId);
      if (!entry) return;
      const resp = params?.response || {};
      entry.status = Number(resp?.status || 0);
      entry.responseHeaders = (resp?.headers && typeof resp.headers === "object") ? resp.headers : {};
      entry.mimeType = typeof resp?.mimeType === "string" ? resp.mimeType : undefined;
    });

    const offFinish = client.on("Network.loadingFinished", async (params: any) => {
      const requestId = String(params?.requestId || "");
      const entry = byId.get(requestId);
      if (!entry) return;
      // Best-effort body fetch. Some requests (CORS preflight, redirects) may not have body.
      try {
        const res = await client.send("Network.getResponseBody", { requestId }, sessionId);
        entry.responseBody = typeof res?.body === "string" ? res.body : null;
      } catch {
        entry.responseBody = null;
      }
    });

    const offFail = client.on("Network.loadingFailed", (params: any) => {
      const requestId = String(params?.requestId || "");
      const entry = byId.get(requestId);
      if (!entry) return;
      entry.status = entry.status ?? 0;
      entry.responseBody = null;
    });

    for (const url of opts.urls) {
      await client.send("Page.navigate", { url }, sessionId).catch(() => {});
      // Wait for load event then a fixed settle.
      await waitForEventOnce(client, "Page.loadEventFired", 20_000, sessionId).catch(() => {});
      await delay(Math.max(0, opts.waitMs)).catch(() => {});
    }

    // Pull storage + meta tokens from the final page.
    const localStorage = await evalJson<Record<string, string>>(client, sessionId, `(() => {
      const out = {};
      try {
        const ls = globalThis.localStorage;
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (!k) continue;
          try { out[k] = String(ls.getItem(k) ?? ""); } catch {}
        }
      } catch {}
      return out;
    })()`).catch(() => ({}));

    const sessionStorage = await evalJson<Record<string, string>>(client, sessionId, `(() => {
      const out = {};
      try {
        const ss = globalThis.sessionStorage;
        for (let i = 0; i < ss.length; i++) {
          const k = ss.key(i);
          if (!k) continue;
          try { out[k] = String(ss.getItem(k) ?? ""); } catch {}
        }
      } catch {}
      return out;
    })()`).catch(() => ({}));

    const metaTokens = await evalJson<Record<string, string>>(client, sessionId, `(() => {
      const out = {};
      try {
        for (const el of Array.from(document.querySelectorAll("meta"))) {
          const name = (el.getAttribute("name") || el.getAttribute("property") || "").toLowerCase();
          const content = el.getAttribute("content") || "";
          if (!name || !content) continue;
          if (name.includes("csrf") || name.includes("xsrf")) out[name] = content;
        }
      } catch {}
      return out;
    })()`).catch(() => ({}));

    // Cookies: browser-wide query.
    const allCookiesRes = await client.send("Network.getAllCookies", {}, sessionId).catch(() => null);
    const cookies = Array.isArray(allCookiesRes?.cookies) ? allCookiesRes.cookies : [];

    offReq();
    offResp();
    offFinish();
    offFail();

    const captured = order.map((id) => byId.get(id)).filter(Boolean) as CdpCapturedRequest[];
    return { captured, cookies, localStorage, sessionStorage, metaTokens };
  } finally {
    await client.close().catch(() => {});
  }
}

async function evalJson<T>(client: CdpWsClient, sessionId: string, expression: string): Promise<T> {
  const res = await client.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  return (res?.result?.value ?? {}) as T;
}

async function waitForEventOnce(client: CdpWsClient, method: string, timeoutMs: number, sessionId?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), timeoutMs);
    t.unref?.();
    const off = client.on(method, (_params, raw) => {
      if (sessionId && raw?.sessionId && raw.sessionId !== sessionId) return;
      clearTimeout(t);
      off();
      resolve();
    });
  });
}

