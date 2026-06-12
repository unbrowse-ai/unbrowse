/**
 * reveng-server-first — the ZK/obfuscated egress for moving RE inference server-side.
 *
 * Thin-client migration checkpoint ① (reverse-engineer). The RE *inference*
 * (traffic → API endpoints) is moat and must run server-side. But the captured
 * traffic contains the user's cookies/auth/tokens, so we obfuscate it LOCALLY
 * first (`obfuscateCaptureForReveng` strips secret values, leaving only structure)
 * and POST only the sanitized signal to `/v1/reveng`. "Credentials never leave the
 * machine" holds: the server sees method/URL-shape/param-keys/schema, never secrets.
 *
 * The local `extractEndpoints` stays as a degraded offline fallback, imported
 * LAZILY (dynamic `import()`), so `reverse-engineer` is NOT in the public client's
 * static import closure (see scripts/thin-client-gate.sh). Call sites swap
 * `extractEndpoints(reqs, …)` → `await revengServerFirst(reqs, …)`.
 */
import { obfuscateCaptureForReveng } from "./obfuscate.js";
import { getApiBaseUrl, getApiKey, isLocalOnlyMode } from "../client/index.js";
import type { RawRequest } from "./index.js";
import type { EndpointDescriptor } from "../types/skill.js";

/** Minimal context — kept local so we don't static-import the reverse-engineer module. */
export interface RevengContext {
  pageUrl?: string;
  finalUrl?: string;
  [k: string]: unknown;
}

const REVENG_TIMEOUT_MS = parseInt(process.env.UNBROWSE_REVENG_TIMEOUT ?? "12000", 10);

/** Degraded offline path — lazy import keeps `reverse-engineer` out of the static closure. */
async function localExtract(
  requests: RawRequest[],
  wsMessages: unknown,
  context?: RevengContext,
): Promise<EndpointDescriptor[]> {
  const mod = await import("../reverse-engineer/index.js");
  return mod.extractEndpoints(
    requests as Parameters<typeof mod.extractEndpoints>[0],
    wsMessages as Parameters<typeof mod.extractEndpoints>[1],
    context as Parameters<typeof mod.extractEndpoints>[2],
  );
}

/**
 * Server-first RE inference. Obfuscates capture locally, POSTs the sanitized
 * signal to `/v1/reveng`, returns the server-inferred endpoints. Falls back to
 * the local extractor offline or on any server failure. NEVER sends raw secrets.
 */
export async function revengServerFirst(
  requests: RawRequest[],
  wsMessages?: unknown,
  context?: RevengContext,
): Promise<EndpointDescriptor[]> {
  if (!Array.isArray(requests) || requests.length === 0) {
    return localExtract(requests ?? [], wsMessages, context);
  }
  // Offline / local-only / unauthenticated never egresses — pure local path.
  // (No API key ⇒ the backend would reject us anyway, and tests stay fast.)
  const key = getApiKey();
  if (isLocalOnlyMode() || !key) return localExtract(requests, wsMessages, context);

  try {
    // Strip secret values BEFORE the request leaves the machine.
    const sanitized = obfuscateCaptureForReveng(requests);
    const res = await fetch(`${getApiBaseUrl()}/v1/reveng`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ capture: sanitized, context }),
      signal: AbortSignal.timeout(REVENG_TIMEOUT_MS),
    });
    if (res.ok) {
      const j = (await res.json()) as { endpoints?: EndpointDescriptor[] };
      if (Array.isArray(j.endpoints)) return j.endpoints;
    }
  } catch {
    /* fall through to degraded local */
  }
  return localExtract(requests, wsMessages, context);
}

/**
 * The exact bytes this module would put on the wire for a given capture — exposed
 * so the no-secret-leak test can assert no raw secret value crosses the boundary.
 */
export function revengEgressPayload(requests: RawRequest[], context?: RevengContext): string {
  return JSON.stringify({ capture: obfuscateCaptureForReveng(requests), context });
}
