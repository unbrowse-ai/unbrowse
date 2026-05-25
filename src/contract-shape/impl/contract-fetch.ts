/**
 * impl: contract-fetch (Layer 1 TLS, ephemeral per call).
 * Delegates to the existing statelessTlsFetch primitive.
 */

import { statelessTlsFetch } from "../../kuri/stateless/layer1-tls.js";
import { randomBytes } from "node:crypto";

interface Input {
  url: string;
  intent?: string;
  ja3_profile?: "chrome131" | "chrome120" | "firefox120";
  proxy_url?: string;
  timeout_ms?: number;
}

interface Output {
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

export default async function run(input: unknown): Promise<Output> {
  const started = Date.now();
  const req = input as Input;
  if (!req || typeof req !== "object" || typeof req.url !== "string") {
    return {
      ok: false,
      status: 0,
      bytes: 0,
      body: "",
      final_url: "",
      source: "stateless-fetch",
      capability_pointer: null,
      ts: new Date().toISOString(),
      pointer_id: `cf-${Date.now()}-${randomBytes(4).toString("hex")}`,
      duration_ms: Date.now() - started,
      proxy_used: false,
      error: "missing required field: url",
    };
  }
  const r = await statelessTlsFetch({
    target_url: req.url,
    ja3_profile: req.ja3_profile,
    proxy_url: req.proxy_url,
    timeout_ms: req.timeout_ms ?? 25_000,
    force_direct: !req.proxy_url,
  });
  if (!r) {
    return {
      ok: false,
      status: 0,
      bytes: 0,
      body: "",
      final_url: req.url,
      source: "stateless-fetch",
      capability_pointer: null,
      ts: new Date().toISOString(),
      pointer_id: `cf-${Date.now()}-${randomBytes(4).toString("hex")}`,
      duration_ms: Date.now() - started,
      proxy_used: false,
      error: "stateless TLS fetch returned null",
    };
  }
  return {
    ok: r.response.status >= 200 && r.response.status < 400,
    status: r.response.status,
    bytes: r.response.bytes,
    body: r.response.body,
    final_url: r.response.final_url,
    source: "stateless-fetch",
    capability_pointer: r.capability,
    ts: new Date().toISOString(),
    pointer_id: `cf-${Date.now()}-${randomBytes(4).toString("hex")}`,
    duration_ms: Date.now() - started,
    proxy_used: !!req.proxy_url,
  };
}
