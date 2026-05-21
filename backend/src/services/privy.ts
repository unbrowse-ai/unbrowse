/**
 * Privy server-side verification + wallet lookup, Workers-safe.
 *
 * No SDK — uses Privy's REST API + Web Crypto (subtle.verify) for the
 * ES256 JWT signature check, so the file deploys cleanly to Cloudflare
 * Workers without Node polyfills.
 *
 * Wave 2 of `.claude/wire-privy-authentication-end-to-end-for-unbrows`.
 * Wave 1 was the frontend ethereum->solana flip in
 * `frontend/src/lib/privy-provider.tsx`. This file is what the
 * `/v1/auth/privy/start` route (Wave 3) calls to verify a Privy access
 * token coming from the frontend and to fetch the user's embedded
 * Solana wallet address for binding.
 */
import type { Env } from "../types.js";

interface PrivyClaims {
  sub: string; // Privy DID (privy_user_id)
  aud: string; // app_id
  iss: string;
  iat: number;
  exp: number;
  sid?: string;
}

interface PrivyLinkedAccount {
  type: string;
  chain_type?: string;
  address?: string;
  wallet_index?: number;
  wallet_client?: string; // "privy" for embedded wallets
}

interface PrivyUser {
  id: string;
  created_at: number;
  linked_accounts: PrivyLinkedAccount[];
}

const PRIVY_API_BASE = "https://auth.privy.io/api/v1";

let jwksCache: { kid: string; key: CryptoKey }[] | null = null;
let jwksCachedAt = 0;
const JWKS_TTL_MS = 5 * 60 * 1000;

async function loadJwks(appId: string): Promise<{ kid: string; key: CryptoKey }[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCachedAt < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(`${PRIVY_API_BASE}/apps/${appId}/jwks.json`);
  if (!res.ok) throw new Error(`privy_jwks_fetch_failed: ${res.status}`);
  const body = (await res.json()) as { keys: Array<{ kid: string; kty: string; crv: string; x: string; y: string; alg?: string }> };
  const imported = await Promise.all(
    body.keys.map(async (jwk) => {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      return { kid: jwk.kid, key };
    }),
  );
  jwksCache = imported;
  jwksCachedAt = now;
  return imported;
}

function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJwtHeader(token: string): { alg: string; kid: string; typ?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("privy_jwt_malformed");
  const headerB64 = parts[0];
  if (!headerB64) throw new Error("privy_jwt_malformed");
  let text: string;
  try {
    text = new TextDecoder().decode(base64UrlDecode(headerB64));
  } catch {
    throw new Error("privy_jwt_malformed");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("privy_jwt_malformed");
  }
}

function decodeJwtPayload(token: string): PrivyClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("privy_jwt_malformed");
  let text: string;
  try {
    text = new TextDecoder().decode(base64UrlDecode(parts[1]!));
  } catch {
    throw new Error("privy_jwt_malformed");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("privy_jwt_malformed");
  }
}

/**
 * Verify a Privy access token (ES256 JWT) signed by the app's JWKS.
 *
 * Throws on any invalid-signature / expired / wrong-audience / wrong-issuer.
 * Returns the verified claims (sub = privy_user_id, aud = app_id).
 */
export async function verifyPrivyAuthToken(token: string, env: Env): Promise<PrivyClaims> {
  if (!env.PRIVY_APP_ID) throw new Error("privy_app_id_unset");
  const header = decodeJwtHeader(token);
  if (header.alg !== "ES256") throw new Error(`privy_jwt_unsupported_alg:${header.alg}`);
  const keys = await loadJwks(env.PRIVY_APP_ID);
  const match = keys.find((k) => k.kid === header.kid);
  if (!match) throw new Error(`privy_jwt_unknown_kid:${header.kid}`);
  const [h, p, s] = token.split(".");
  const signedInput = new TextEncoder().encode(`${h}.${p}`);
  const signatureRaw = base64UrlDecode(s ?? "");
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    match.key,
    signatureRaw,
    signedInput,
  );
  if (!ok) throw new Error("privy_jwt_signature_invalid");
  const claims = decodeJwtPayload(token);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) throw new Error("privy_jwt_expired");
  if (claims.aud !== env.PRIVY_APP_ID) throw new Error(`privy_jwt_audience_mismatch:${claims.aud}`);
  if (claims.iss !== "privy.io") throw new Error(`privy_jwt_issuer_mismatch:${claims.iss}`);
  return claims;
}

/**
 * Fetch a Privy user by DID via the REST API. Uses Basic auth with the
 * app_id + app_secret. Returns the linked_accounts list so the caller
 * can pick the embedded Solana wallet address.
 */
async function fetchPrivyUser(privyUserId: string, env: Env): Promise<PrivyUser> {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) throw new Error("privy_credentials_unset");
  const auth = btoa(`${env.PRIVY_APP_ID}:${env.PRIVY_APP_SECRET}`);
  const res = await fetch(`${PRIVY_API_BASE}/users/${encodeURIComponent(privyUserId)}`, {
    headers: {
      Authorization: `Basic ${auth}`,
      "privy-app-id": env.PRIVY_APP_ID,
    },
  });
  if (!res.ok) throw new Error(`privy_user_fetch_failed:${res.status}`);
  return res.json();
}

/**
 * Find the embedded Solana wallet address for a Privy user. Returns null
 * when the user has no embedded Solana wallet (e.g. they signed in with
 * an external EVM wallet only). Embedded wallets carry
 * `wallet_client === "privy"` and `chain_type === "solana"`.
 */
export async function findPrivyEmbeddedSolanaWallet(privyUserId: string, env: Env): Promise<string | null> {
  const user = await fetchPrivyUser(privyUserId, env);
  const wallet = user.linked_accounts.find(
    (a) => a.type === "wallet" && a.chain_type === "solana" && a.wallet_client === "privy" && typeof a.address === "string",
  );
  return wallet?.address ?? null;
}

/**
 * Convenience for the auth route: verify the Privy token and return both
 * the verified privy_user_id AND the embedded Solana wallet (if any) in
 * one round-trip. The route owns the agent registration + binding step;
 * this just hands it the inputs.
 */
export async function verifyPrivyAndLoadWallet(token: string, env: Env): Promise<{
  privy_user_id: string;
  embedded_solana_wallet: string | null;
}> {
  const claims = await verifyPrivyAuthToken(token, env);
  const wallet = await findPrivyEmbeddedSolanaWallet(claims.sub, env);
  return { privy_user_id: claims.sub, embedded_solana_wallet: wallet };
}
