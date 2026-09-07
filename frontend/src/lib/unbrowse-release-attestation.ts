/**
 * Release attestation headers for the cloud (hero) agent.
 *
 * Matches the official unbrowse@11.3.3 client so beta-api's
 * `requireSignedClient` accepts the same identity as `npm install -g unbrowse@latest`.
 * These values are public client identity (embedded in every shipped binary);
 * the HMAC proves the package was signed with RELEASE_MANIFEST_SIGNING_SECRET.
 *
 * Override via env (worker secrets/vars) without a code change:
 *   UNBROWSE_RELEASE_MANIFEST_BASE64
 *   UNBROWSE_RELEASE_MANIFEST_SIGNATURE
 */

/** Official unbrowse@11.3.3 (npm runtime/cli.js BUILD_RELEASE_*). */
export const LATEST_UNBROWSE_RELEASE_MANIFEST_BASE64 =
  "eyJzY2hlbWFfdmVyc2lvbiI6MSwicmVsZWFzZV92ZXJzaW9uIjoiMTEuMy4zIiwiZ2l0X3NoYSI6IjVjN2VmMjU1OWFlYSIsImNvZGVfaGFzaCI6ImIyMzc5NTgxNDM1MyIsInRyYWNlX3ZlcnNpb24iOiJiMjM3OTU4MTQzNTNANWM3ZWYyNTU5YWVhIiwiaXNzdWVkX2F0IjoiMjAyNi0wOC0wM1QxNTozNTo0OS40MzNaIn0";

export const LATEST_UNBROWSE_RELEASE_MANIFEST_SIGNATURE =
  "lq8Dsv-uWAozrzqw82Rb_iBblqnZQc5wFfKwGDVT24g";

/** Browser-safe: only reads public NEXT_PUBLIC_* or embedded latest constants. */
export function releaseAttestationHeaders(
  env: Partial<Record<string, string | undefined>> = typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {},
): Record<string, string> {
  const manifest = (
    env.UNBROWSE_RELEASE_MANIFEST_BASE64?.trim() ||
    env.NEXT_PUBLIC_UNBROWSE_RELEASE_MANIFEST_BASE64?.trim() ||
    LATEST_UNBROWSE_RELEASE_MANIFEST_BASE64
  ).trim();
  const sig = (
    env.UNBROWSE_RELEASE_MANIFEST_SIGNATURE?.trim() ||
    env.NEXT_PUBLIC_UNBROWSE_RELEASE_MANIFEST_SIGNATURE?.trim() ||
    LATEST_UNBROWSE_RELEASE_MANIFEST_SIGNATURE
  ).trim();
  if (!manifest || !sig) return {};
  // Only headers listed in beta-api CORS allowHeaders (backend/src/index.ts).
  // Extra custom headers (e.g. X-Unbrowse-Client) force a preflight the browser
  // rejects → client-driven hero loop surfaces "search failed: network error".
  return {
    "X-Unbrowse-Release-Manifest": manifest,
    "X-Unbrowse-Release-Signature": sig,
  };
}

/**
 * Headers for marketplace calls from the cloud agent (worker or browser).
 * Always carries latest-unbrowse release attestation. Optionally attaches
 * UNBROWSE_AGENT_KEY when present (worker-only — never expose to the client bundle).
 */
export function unbrowseMarketplaceHeaders(opts?: {
  json?: boolean;
  accept?: boolean;
  /** Worker-only agent key; omit in browser code paths. */
  agentKey?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    ...releaseAttestationHeaders(),
  };
  if (opts?.json !== false) headers["content-type"] = "application/json";
  if (opts?.accept) headers.accept = "application/json";
  const key = opts?.agentKey?.trim();
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}
