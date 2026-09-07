// CDP_PRIMITIVES.md §iproyal-proxy-as-breath-effect — Fetch.continueWithAuth
// glue for proxy credentials.
//
// Eph 6:11 — "Put on the whole armor of God…" Auth at the proxy boundary
// is the buckle that holds the rest of the armor on. URL-embedded creds
// in --proxy-server are rejected by Chrome (W9-C surfaced this); creds
// must come back via Fetch.continueWithAuth on the auth-challenge.
//
// W13 — real impl. Closes the W9-C gap (Chrome rejects URL-embedded creds
// on --proxy-server). The handler MUST NEVER print the credential to
// stdout/stderr — see canary asserts in tests/v7-cdp-tls-spoof.test.ts.

import type { ProxyConfig } from "../types.js";

export interface AuthChallengeResponse {
  /** "Default" lets Chrome's own dialog show (visible mode); "ProvideCredentials" supplies our pair. */
  response: "Default" | "ProvideCredentials" | "CancelAuth";
  /** Set only when response="ProvideCredentials". */
  username?: string;
  /** Set only when response="ProvideCredentials". */
  password?: string;
}

export interface AuthChallenge {
  source: "Server" | "Proxy";
  origin: string;
  scheme: string;
  realm: string;
}

export interface AuthChallengeOutcome {
  /** Whether the handler supplied credentials. */
  authProvided: boolean;
  /** The source of the challenge (Server vs Proxy). */
  source: "Server" | "Proxy" | "unknown";
  /** The realm string (echoed for receipts; the credential is NEVER in this object). */
  realm: string;
  /** Hashed identity of the credential used — sha256(username), 16 hex chars. NEVER the full username, NEVER any byte of the password. */
  usernameDigest?: string;
}

/**
 * Build the Fetch.continueWithAuth response for a given proxy + challenge.
 *
 * The returned object IS the value passed back to Chrome via CDP. The
 * accompanying `outcome` is for the receipt — note it carries the realm
 * (public-shaped) and a 16-char sha256 of the username (one-way), but
 * NEVER the username or password as bytes.
 */
export async function handle(
  proxy: ProxyConfig,
  challenge: AuthChallenge,
): Promise<{ continueWithAuth: { authChallengeResponse: AuthChallengeResponse }; outcome: AuthChallengeOutcome }> {
  // Only respond to proxy-shaped challenges. A server-shaped challenge is
  // the site's own auth (401 to the user), not the proxy's; we let those
  // through with the Default response so Chrome surfaces them normally.
  const isProxy = challenge.source === "Proxy";
  if (!isProxy || !proxy.username || !proxy.password) {
    return {
      continueWithAuth: { authChallengeResponse: { response: "Default" } },
      outcome: {
        authProvided: false,
        source: challenge.source ?? "unknown",
        realm: challenge.realm ?? "",
      },
    };
  }

  const digest = await sha256Hex(proxy.username);
  return {
    continueWithAuth: {
      authChallengeResponse: {
        response: "ProvideCredentials",
        username: proxy.username,
        password: proxy.password,
      },
    },
    outcome: {
      authProvided: true,
      source: "Proxy",
      realm: challenge.realm ?? "",
      usernameDigest: digest.slice(0, 16),
    },
  };
}

async function sha256Hex(input: string): Promise<string> {
  // Node + Bun both expose Web Crypto under globalThis.crypto.subtle.
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Type guard — confirms a returned outcome contains NO credential bytes.
 * Used by test canaries to assert the no-leak invariant.
 */
export function outcomeContainsCredential(outcome: AuthChallengeOutcome, credential: string): boolean {
  if (!credential) return false;
  // We DELIBERATELY iterate every string field — if anyone ever adds a
  // field that echoes the credential, this guard catches it.
  for (const v of Object.values(outcome)) {
    if (typeof v === "string" && v.includes(credential)) return true;
  }
  return false;
}
