// POST /v1/proxy — server-side fetch proxy for the SDK.
//
// Why this exists: the v7 SDK is HTTP-first and never spawns a local daemon.
// Many captured endpoints are blocked by anti-bot, geo-fenced, or require an
// outbound IP the user doesn't have. The worker fetches on behalf of the
// agent. Optionally routes through IProyal residential proxy.
//
// Substrate-faithful: the route surfaces what the caller declared (url, method,
// headers, body, proxy mode) and reports what actually happened (status, body,
// proxy_used). It does not synthesize headers or rewrite the response.

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { optionalAuth } from "../middleware/auth.js";

// cloudflare:sockets is a Workers-runtime virtual module. It does not exist in
// Bun (which loads this file during backend tests via the Hono app import
// graph). The residential proxy path that uses it is Workers-only at runtime,
// so we resolve `connect` lazily inside that path and type `Socket`
// structurally here.
type Socket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
  startTls(opts: { expectedServerHostname: string }): Socket;
};
type CfConnect = (
  addr: { hostname: string; port: number },
  opts?: { secureTransport?: "starttls" | "off"; allowHalfOpen?: boolean },
) => Socket;
async function getCloudflareConnect(): Promise<CfConnect> {
  const mod = await import("cloudflare:sockets");
  return mod.connect as CfConnect;
}

interface ProxyRequestBody {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  proxy?: "direct" | "residential";
  timeout_ms?: number;
}

interface ProxyResponseBody {
  status: number;
  headers: Record<string, string>;
  body: string;
  proxy_used: "direct" | "residential";
  duration_ms: number;
  egress_ip?: string;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

// Strip headers that would confuse the upstream or leak worker context.
const STRIP_REQUEST_HEADERS = new Set([
  "host", "content-length", "connection", "cf-connecting-ip", "cf-ipcountry",
  "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
  "true-client-ip",
]);

// Headers to relay back to the SDK on the response.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection",
]);

function isPrivateOrLocalUrl(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  // Block private RFC1918 ranges (best-effort; full check happens at the worker network layer too).
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;  // link-local
  return false;
}

async function handleProxy(c: Context<{ Bindings: Env; Variables: { agent_id?: string } }>): Promise<Response> {
  const start = Date.now();

  // Auth gate: accept EITHER (a) a valid Bearer API key (sets c.agent_id via
  // optionalAuth applied at the route level) OR (b) an x402 payment proof on
  // the request. If neither, return 402 with payment requirements so the
  // caller can pay-as-you-go without an account. Substrate-faithful: the
  // route surfaces the cost up front; the agent's LLM decides whether to
  // attach a payment proof or use its key.
  const agentId = c.get("agent_id");
  const paymentProof = c.req.header("X-Payment-Proof") ?? c.req.header("PAYMENT-SIGNATURE");
  if (!agentId && !paymentProof) {
    return c.json({
      error: "payment_required",
      message: "Attach a Bearer API key (Authorization: Bearer ubr_...) or an x402 payment proof (X-Payment-Proof header) to use /v1/proxy.",
      payment: {
        scheme: "x402",
        network: ((c.env as unknown as { X402_NETWORK_MODE?: string }).X402_NETWORK_MODE ?? "mainnet"),
        // Direct mode: ~$0.0001 per call. Residential mode (iproyal): ~$0.001
        // per call (bandwidth is the dominant cost). Exact cents settled by
        // facilitator after upstream completes. Surface the upper-bound here
        // so a sponsor agent can pre-budget.
        max_amount_usd: 0.001,
        currencies: ["USDC"],
        signers: [(c.env as unknown as { PAYMENT_RECIPIENT?: string }).PAYMENT_RECIPIENT].filter(Boolean),
      },
      docs: "https://www.unbrowse.ai/docs/proxy",
    }, 402);
  }

  let req: ProxyRequestBody;
  try {
    req = await c.req.json<ProxyRequestBody>();
  } catch {
    return c.json({ error: "invalid_json", message: "body must be JSON" }, 400);
  }

  if (!req.url || typeof req.url !== "string") {
    return c.json({ error: "invalid_url", message: "url is required" }, 400);
  }

  let target: URL;
  try {
    target = new URL(req.url);
  } catch {
    return c.json({ error: "invalid_url", message: `cannot parse url: ${req.url}` }, 400);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return c.json({ error: "invalid_scheme", message: "only http/https allowed" }, 400);
  }
  if (isPrivateOrLocalUrl(target)) {
    return c.json({ error: "blocked_private_host", message: `private/loopback hosts not allowed: ${target.hostname}` }, 400);
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return c.json({ error: "invalid_method", message: `method ${method} not allowed` }, 400);
  }

  const proxyMode = req.proxy ?? "direct";
  if (proxyMode !== "direct" && proxyMode !== "residential") {
    return c.json({ error: "invalid_proxy_mode", message: `proxy must be 'direct' or 'residential'` }, 400);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "Mozilla/5.0 (compatible; UnbrowseProxy/1.0)");
  }
  if (!headers.has("accept")) headers.set("accept", "*/*");

  const timeoutMs = Math.min(req.timeout_ms ?? DEFAULT_TIMEOUT_MS, 60_000);

  try {
    let result: ProxyResponseBody;
    if (proxyMode === "residential") {
      result = await fetchViaIproyal(target, method, headers, req.body ?? null, timeoutMs, c.env);
    } else {
      result = await fetchDirect(target, method, headers, req.body ?? null, timeoutMs);
    }
    result.duration_ms = Date.now() - start;
    // Tag the response so the caller can audit which auth path settled.
    (result as ProxyResponseBody & { auth_used?: string }).auth_used = agentId ? "api_key" : "x402";
    return c.json(result, 200);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    return c.json({
      error: "upstream_fetch_failed",
      message,
      proxy_used: proxyMode,
      duration_ms: Date.now() - start,
    }, 502);
  }
}

async function fetchDirect(
  url: URL,
  method: string,
  headers: Headers,
  body: string | null,
  timeoutMs: number,
): Promise<ProxyResponseBody> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url.toString(), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? null : body,
      signal: ctrl.signal,
      redirect: "follow",
    });
    const respHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
    });
    const respBody = await r.text();
    return {
      status: r.status,
      headers: respHeaders,
      body: respBody.length > MAX_BODY_BYTES ? respBody.slice(0, MAX_BODY_BYTES) : respBody,
      proxy_used: "direct",
      duration_ms: 0,
    };
  } finally {
    clearTimeout(t);
  }
}

async function fetchViaIproyal(
  url: URL,
  method: string,
  headers: Headers,
  body: string | null,
  timeoutMs: number,
  env: Env,
): Promise<ProxyResponseBody> {
  const iproyalUser = (env as unknown as { IPROYAL_USER?: string }).IPROYAL_USER;
  const iproyalPass = (env as unknown as { IPROYAL_PASS?: string }).IPROYAL_PASS;
  const iproyalHost = (env as unknown as { IPROYAL_HOST?: string }).IPROYAL_HOST ?? "geo.iproyal.com";
  const iproyalPort = Number((env as unknown as { IPROYAL_PORT?: string }).IPROYAL_PORT ?? 12321);
  if (!iproyalUser || !iproyalPass) {
    throw new Error("IPROYAL_USER / IPROYAL_PASS env not set; run `wrangler secret put IPROYAL_USER` and `wrangler secret put IPROYAL_PASS`");
  }

  const targetHost = url.hostname;
  const targetPort = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  const isHttps = url.protocol === "https:";

  // Open TCP socket to iproyal proxy endpoint. Cloudflare's cloudflare:sockets
  // connect() returns a Socket with readable/writable streams. Loaded lazily
  // because the module is a Workers virtual; Bun can't resolve it statically.
  const connect = await getCloudflareConnect();
  const sock: Socket = connect(
    { hostname: iproyalHost, port: iproyalPort },
    // `secureTransport: "starttls"` is required by cloudflare:sockets so a
    // later sock.startTls() upgrade is allowed. Without it, startTls() throws
    // "The `secureTransport` socket option must be set to 'starttls'".
    {
      secureTransport: isHttps ? "starttls" : "off",
      allowHalfOpen: false,
    },
  );

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const writer = sock.writable.getWriter();
  const reader = sock.readable.getReader();

  // 1) Send HTTP CONNECT for the target host:port (with Proxy-Authorization).
  const proxyAuth = btoa(`${iproyalUser}:${iproyalPass}`);
  const connectReq =
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    `Proxy-Authorization: Basic ${proxyAuth}\r\n` +
    `Proxy-Connection: keep-alive\r\n\r\n`;
  await writer.write(enc.encode(connectReq));

  // 2) Read the CONNECT response (line-oriented; we only care about 200).
  const connectResp = await readUntilDoubleCrlf(reader, timeoutMs);
  const firstLine = connectResp.split("\r\n")[0] ?? "";
  if (!/^HTTP\/\d\.\d 200/.test(firstLine)) {
    writer.releaseLock();
    reader.releaseLock();
    await sock.close();
    throw new Error(`iproyal CONNECT failed: ${firstLine}`);
  }
  writer.releaseLock();
  reader.releaseLock();

  // 3) If https, upgrade to TLS. cloudflare:sockets exposes startTls().
  const conn: Socket = isHttps ? sock.startTls({ expectedServerHostname: targetHost }) : sock;

  // 4) Send the actual HTTP request through the (now possibly TLS) tunnel.
  const path = url.pathname + url.search;
  const reqHeaderLines: string[] = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${targetHost}${url.port ? `:${url.port}` : ""}`,
    `Connection: close`,
  ];
  headers.forEach((v, k) => {
    if (k.toLowerCase() === "host" || k.toLowerCase() === "connection") return;
    reqHeaderLines.push(`${k}: ${v}`);
  });
  let bodyBytes: Uint8Array | null = null;
  if (body && method !== "GET" && method !== "HEAD") {
    bodyBytes = enc.encode(body);
    reqHeaderLines.push(`Content-Length: ${bodyBytes.byteLength}`);
  }
  const reqStr = reqHeaderLines.join("\r\n") + "\r\n\r\n";

  const w = conn.writable.getWriter();
  await w.write(enc.encode(reqStr));
  if (bodyBytes) await w.write(bodyBytes);
  w.releaseLock();

  // 5) Read the full HTTP response.
  const r = conn.readable.getReader();
  const buf = await readAll(r, MAX_BODY_BYTES, timeoutMs);
  r.releaseLock();
  await conn.close();

  const text = dec.decode(buf);
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("malformed http response from iproyal upstream (no header terminator)");
  const headerBlock = text.slice(0, headerEnd);
  const bodyText = text.slice(headerEnd + 4);

  const lines = headerBlock.split("\r\n");
  const statusLine = lines[0] ?? "";
  const statusMatch = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const respHeaders: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const k = line.slice(0, sep).trim().toLowerCase();
    const v = line.slice(sep + 1).trim();
    if (STRIP_RESPONSE_HEADERS.has(k)) continue;
    respHeaders[k] = v;
  }

  return {
    status,
    headers: respHeaders,
    body: bodyText,
    proxy_used: "residential",
    duration_ms: 0,
  };
}

async function readUntilDoubleCrlf(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const dec = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      acc += dec.decode(value, { stream: true });
      if (acc.includes("\r\n\r\n")) return acc;
    }
  }
  throw new Error(`timeout waiting for proxy CONNECT response after ${timeoutMs}ms`);
}

async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cap: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= cap) break;
    }
  }
  const out = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, cap - off);
    out.set(chunk.subarray(0, take), off);
    off += take;
    if (off >= cap) break;
  }
  return out;
}

export const proxyRoutes = new Hono<{ Bindings: Env; Variables: { agent_id?: string } }>();
// optionalAuth so a Bearer key sets c.agent_id without rejecting unauthed callers
// (handleProxy returns 402 with payment requirements when no auth path matched).
proxyRoutes.post("/v1/proxy", optionalAuth, handleProxy);

// Health probe: GET /v1/proxy returns capability info without making upstream calls.
// Useful for the SDK to check "is residential mode wired" before requesting it.
proxyRoutes.get("/v1/proxy", (c) => {
  const env = c.env as unknown as { IPROYAL_USER?: string };
  return c.json({
    modes: ["direct", "residential"],
    residential_configured: Boolean(env.IPROYAL_USER),
    max_body_bytes: MAX_BODY_BYTES,
    default_timeout_ms: DEFAULT_TIMEOUT_MS,
  });
});
