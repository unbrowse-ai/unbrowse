/**
 * reveng-server-first — the obfuscated egress for SERVER-ONLY RE inference.
 *
 * The endpoint reverse-engineering heuristics (traffic → API endpoints) are moat IP
 * and run SERVER-side only. The client obfuscates captured traffic LOCALLY first
 * (`obfuscateCaptureForReveng` strips secret values, leaving only structure) and POSTs
 * only the sanitized signal to `/v1/reveng`. "Credentials never leave the machine"
 * holds: the server sees method/URL-shape/param-keys/schema, never secrets.
 *
 * The server path stays PREFERRED: its heuristics are the moat and its answers are the
 * stronger evidential class. What changed is what happens when it is not there. This
 * used to return an EMPTY endpoint list whenever the server was unreachable (offline,
 * no API key, local-only mode, or a non-2xx), and that silently threw away real
 * captures — measured: four JS-rendered sites, 42/65/39 observed network entries,
 * 428 KB downloaded from `data.europa.eu/api/hub/search/search`, ZERO endpoints
 * published, because `/v1/reveng` answered HTTP 426.
 *
 * So there are now exactly two outcomes instead of one: a server answer when the server
 * answers, and `revengLocal` (./reveng-local.ts — structural, response-shape-based,
 * honestly marked `unverified`) when it does not. This is the ONE seam: all eight
 * `revengServerFirst` call sites inherit the fallback without changing. Call sites swap
 * `extractEndpoints(reqs, …)` → `await revengServerFirst(reqs, …)`.
 */
import { obfuscateCaptureForReveng } from "./obfuscate.js";
import { revengLocal } from "./reveng-local.js";
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
 * Server-FIRST RE inference. Obfuscates the capture locally, POSTs the sanitized signal
 * to `/v1/reveng`, and returns the server-inferred endpoints when the server produces
 * any. Falls back to `revengLocal` when it does not — offline, no key, local-only mode,
 * a non-2xx (the observed 426), a timeout, or a 2xx that carried no endpoints. NEVER
 * sends raw secrets. x402 payment-required errors propagate.
 *
 * Server descriptors remain authoritative for matching routes, while locally
 * evidenced routes supplement server omissions. A merely non-empty server answer
 * must not erase a captured collection endpoint the server failed to describe.
 */
export async function revengServerFirst(
  requests: RawRequest[],
  _wsMessages?: unknown,
  context?: RevengContext,
): Promise<EndpointDescriptor[]> {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  // No server reachable (offline / unauthenticated / local-only) ⇒ infer locally.
  const key = getApiKey();
  if (isLocalOnlyMode() || !key) return revengLocal(requests, context);

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
      if (Array.isArray(j.endpoints) && j.endpoints.length > 0) {
        const local = revengLocal(requests, context);
        const serverKeys = new Set(j.endpoints.map((endpoint) =>
          `${String(endpoint.method).toUpperCase()} ${endpoint.url_template}`
        ));
        return [
          ...j.endpoints,
          ...local.filter((endpoint) => !serverKeys.has(`${String(endpoint.method).toUpperCase()} ${endpoint.url_template}`)),
        ];
      }
    }
  } catch {
    /* offline / timeout / non-2xx → fall through to the local engine */
  }
  return revengLocal(requests, context);
}

/**
 * The exact bytes this module would put on the wire for a given capture — exposed
 * so the no-secret-leak test can assert no raw secret value crosses the boundary.
 */
export function revengEgressPayload(requests: RawRequest[], context?: RevengContext): string {
  return JSON.stringify({ capture: obfuscateCaptureForReveng(requests), context });
}
