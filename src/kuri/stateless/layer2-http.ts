/**
 * Stateless-kuri Layer 2 — HTTP layer.
 *
 * Contract: f9ffafc4
 *
 * A contract-neuron primitive that takes (tls_capability_pointer,
 * request_envelope) and emits a response_pointer. cookie_jar is itself a
 * pointer to a layer-6 (auth-bridging) contract neuron, so this layer never
 * reads SQLite directly.
 *
 * Validation: 35 concurrent calls succeed deterministically against
 * api.coingecko.com (the wave-1 timeout culprit).
 *
 * Wired in by: nothing yet (scaffold only).
 */

import { statelessTlsFetch, type TlsCapabilityPointer, type Layer1Result } from "./layer1-tls.js";

export interface RequestEnvelope {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly redirect_policy?: "follow" | "manual" | "error";
  readonly timeout_ms?: number;
  readonly cookie_jar_pointer?: string; // layer-6 reference
}

export interface ResponsePointer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytes: number;
  readonly redirect_chain: readonly string[];
  readonly final_url: string;
  readonly timing: {
    readonly total_ms: number;
    readonly tls_handshake_ms: number | null;
    readonly time_to_first_byte_ms: number | null;
  };
  readonly via_tls_capability: TlsCapabilityPointer;
}

/**
 * Stateless HTTP request. Composes layer 1.
 *
 * Today this is a thin wrapper that only supports GET (curl_cffi via layer 1).
 * POST/PUT/etc. extension is layer-2 future work.
 */
export async function statelessHttpRequest(env: RequestEnvelope): Promise<ResponsePointer | null> {
  if (env.method !== "GET") return null; // future work
  const started = Date.now();
  const r: Layer1Result | null = await statelessTlsFetch({
    target_url: env.url,
    timeout_ms: env.timeout_ms,
  });
  if (!r) return null;
  return {
    status: r.response.status,
    headers: {}, // curl_cffi script today does not surface headers; layer-2 future work
    body: r.response.body,
    bytes: r.response.bytes,
    redirect_chain: [],
    final_url: r.response.final_url,
    timing: {
      total_ms: Date.now() - started,
      tls_handshake_ms: null,
      time_to_first_byte_ms: null,
    },
    via_tls_capability: r.capability,
  };
}
