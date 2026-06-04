#!/usr/bin/env bun
/**
 * contract-fetch — the smallest stateless-stdio contract-neuron primitive.
 *
 * Contracts:
 *   - 4d123d52 (unbrowse CLI = /contract + stateless-kuri primitives)
 *   - 61b784e4 (stateless + stdio-based for /contract-driven parallelism)
 *   - 18d1a651 (Layer 1 — TLS, ephemeral per call)
 *
 * Shape:
 *   stdin (JSON, one object per line OR a single object):
 *     {"url": "...", "intent": "...?", "ja3_profile": "chrome131"?, "proxy_url": "...?", "timeout_ms": 25000?}
 *   stdout (JSON, one object per line):
 *     {"status": 200, "bytes": 1234, "body": "...", "final_url": "...", "source": "stateless-fetch",
 *      "capability_pointer": {...}, "ts": "iso", "pointer_id": "..."}
 *
 * No shared state. No broker. No connection pool. Each invocation:
 *   spawn → read stdin → call Layer-1 statelessTlsFetch (which spawns curl_cffi subprocess)
 *         → emit stdout → exit
 *
 * Designed so that 35 concurrent invocations against distinct URLs (or the
 * same URL) have ZERO cross-talk. Each call gets its own ephemeral
 * subprocess at Layer 1; Node never holds the connection state.
 *
 * Run:
 *   echo '{"url":"https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"}' | bun src/contract-fetch.ts
 */

import { statelessTlsFetch } from "./kuri/stateless/layer1-tls.js";
import { randomBytes } from "node:crypto";

interface ContractFetchRequest {
  url: string;
  intent?: string;
  ja3_profile?: "chrome131" | "chrome120" | "firefox120";
  /** Explicit proxy URL — caller passes one in. Local CLI does NOT auto-
   *  detect IPROYAL_USER/PASS or any other env (per contract b664f482:
   *  proxies are ALWAYS server-side; local binary stays oblivious). When a
   *  residential proxy is needed, the caller invokes the server-side
   *  proxy-provisioning contract neuron, which selects a provider
   *  (pay.sh, agentcash.dev) and signs the x402 invoice, returning a
   *  one-shot proxy_url pointer that the local primitive then dials.
   */
  proxy_url?: string;
  timeout_ms?: number;
}

interface ContractFetchResult {
  ok: boolean;
  status: number;
  bytes: number;
  body: string;
  final_url: string;
  source: "stateless-fetch";
  capability_pointer: unknown;
  ts: string;
  pointer_id: string;
  duration_ms: number;
  proxy_used: boolean;
  error?: string;
}

async function readStdinJson(): Promise<ContractFetchRequest> {
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += chunk;
  }
  buf = buf.trim();
  if (!buf) throw new Error("stdin empty");
  // Accept either a single JSON object or first JSON object in a stream.
  return JSON.parse(buf) as ContractFetchRequest;
}

function newPointerId(): string {
  return `cf-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function main(): Promise<void> {
  const started = Date.now();
  let req: ContractFetchRequest;
  try {
    req = await readStdinJson();
  } catch (err) {
    const result: ContractFetchResult = {
      ok: false,
      status: 0,
      bytes: 0,
      body: "",
      final_url: "",
      source: "stateless-fetch",
      capability_pointer: null,
      ts: new Date().toISOString(),
      pointer_id: newPointerId(),
      duration_ms: Date.now() - started,
      proxy_used: false,
      error: `stdin parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(1);
  }

  if (!req.url) {
    const result: ContractFetchResult = {
      ok: false,
      status: 0,
      bytes: 0,
      body: "",
      final_url: "",
      source: "stateless-fetch",
      capability_pointer: null,
      ts: new Date().toISOString(),
      pointer_id: newPointerId(),
      duration_ms: Date.now() - started,
      proxy_used: false,
      error: "missing required field: url",
    };
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(2);
  }

  // Local primitive never auto-detects proxy env (contract b664f482).
  // Caller passes proxy_url explicitly when needed — typically obtained
  // from a server-side proxy-provisioning contract neuron that handles
  // x402 settlement via pay.sh / agentcash.dev (contract c0e6432e). When
  // proxy_url is unset, force_direct=true so the curl_cffi subprocess
  // also ignores any ambient IPROYAL_USER/PASS env that may be present
  // (env isolation for ephemerality).
  const r = await statelessTlsFetch({
    target_url: req.url,
    ja3_profile: req.ja3_profile,
    proxy_url: req.proxy_url,
    timeout_ms: req.timeout_ms ?? 25_000,
    force_direct: !req.proxy_url,
  });

  if (!r) {
    const result: ContractFetchResult = {
      ok: false,
      status: 0,
      bytes: 0,
      body: "",
      final_url: req.url,
      source: "stateless-fetch",
      capability_pointer: null,
      ts: new Date().toISOString(),
      pointer_id: newPointerId(),
      duration_ms: Date.now() - started,
      proxy_used: false,
      error: "stateless TLS fetch returned null (subprocess error, timeout, or parse failure)",
    };
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(3);
  }

  const result: ContractFetchResult = {
    ok: r.response.status >= 200 && r.response.status < 400,
    status: r.response.status,
    bytes: r.response.bytes,
    body: r.response.body,
    final_url: r.response.final_url,
    source: "stateless-fetch",
    capability_pointer: r.capability,
    ts: new Date().toISOString(),
    pointer_id: newPointerId(),
    duration_ms: Date.now() - started,
    proxy_used: !!req.proxy_url,
  };
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[contract-fetch] uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(99);
});
