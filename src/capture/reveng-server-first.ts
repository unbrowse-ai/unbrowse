/**
 * reveng-server-first — the ZK/obfuscated egress for SERVER-ONLY RE inference.
 *
 * The endpoint reverse-engineering heuristics (traffic → API endpoints) are moat IP
 * and run SERVER-side only. The client obfuscates captured traffic LOCALLY first
 * (`obfuscateCaptureForReveng` strips secret values, leaving only structure) and POSTs
 * only the sanitized signal to `/v1/reveng`. "Credentials never leave the machine"
 * holds: the server sees method/URL-shape/param-keys/schema, never secrets.
 *
 * There is NO local RE fallback in the client — the inference engine does not ship in
 * the public/npm client bundle. When the server is unreachable (offline, no API key,
 * local-only mode, or a non-2xx response) this returns an EMPTY endpoint list and the
 * caller falls through to its non-RE path (e.g. DOM extraction). Call sites swap
 * `extractEndpoints(reqs, …)` → `await revengServerFirst(reqs, …)`.
 */
import { obfuscateCaptureForReveng } from "./obfuscate.js";
import { getApiBaseUrl, getApiKey, isLocalOnlyMode } from "../client/index.js";
import type { RawRequest } from "./index.js";
import type { EndpointDescriptor } from "../types/skill.js";

/** Minimal context — kept local so we don't pull in any inference module. */
export interface RevengContext {
  pageUrl?: string;
  finalUrl?: string;
  [k: string]: unknown;
}

const REVENG_TIMEOUT_MS = parseInt(process.env.UNBROWSE_REVENG_TIMEOUT ?? "12000", 10);

/**
 * Server-only RE inference. Obfuscates capture locally, POSTs the sanitized signal to
 * `/v1/reveng`, returns the server-inferred endpoints. Returns [] when the server is
 * unreachable (offline / no key / local-only / non-2xx) — the client carries no local
 * RE heuristics. NEVER sends raw secrets. x402 payment-required errors propagate.
 */
export async function revengServerFirst(
  requests: RawRequest[],
  _wsMessages?: unknown,
  context?: RevengContext,
): Promise<EndpointDescriptor[]> {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  // No server reachable (offline / unauthenticated / local-only) ⇒ no inference.
  const key = getApiKey();
  if (isLocalOnlyMode() || !key) return [];

  try {
    // Strip secret values BEFORE the request leaves the machine.
    const sanitized = obfuscateCaptureForReveng(requests);
    const res = await fetch(`${getApiBaseUrl()}/v1/reveng`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ capture: sanitized, context }),
      signal: AbortSignal.timeout(REVENG_TIMEOUT_MS),
    });
    if (res.ok) {
      const j = (await res.json()) as { endpoints?: EndpointDescriptor[] };
      if (Array.isArray(j.endpoints)) return j.endpoints;
    }
  } catch {
    /* offline / timeout / non-2xx → empty (server-only, no local fallback) */
  }
  return [];
}

/**
 * The exact bytes this module would put on the wire for a given capture — exposed
 * so the no-secret-leak test can assert no raw secret value crosses the boundary.
 */
export function revengEgressPayload(requests: RawRequest[], context?: RevengContext): string {
  return JSON.stringify({ capture: obfuscateCaptureForReveng(requests), context });
}
