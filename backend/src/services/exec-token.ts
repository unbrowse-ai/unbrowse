// Server-bound execution token (anti-reverse-engineering Wave 1).
//
// Lewis 2026-05-22: "make sure that reverse engineering just wont fucking
// work if youre not signed properly at all -- make sure it binds the logic
// itself deeply with the unbrowse index only or it wont work -- based on
// the servers".
//
// The wedge: the unbrowse marketplace IS the moat. A reverse-engineered
// CLI that lifts the binary and runs it standalone still has working local
// capture / extraction code, but without server-issued search + skill +
// publish access the agent loses the marketplace it needs to be useful.
//
// The token mechanism:
//
//   1. CLI hits POST /v1/session/exec-token with its claimed
//      { build_sha, deployed_at } (read from bundled build-info OR from
//      a /v1/version round-trip).
//   2. Server checks the (build_sha, deployed_at) tuple matches a known-
//      CI-issued manifest. The set of valid tuples is maintained server-
//      side; CI deploys register via the admin-gated
//      /v1/internal/register-build route.
//   3. If valid, server mints an HMAC token over
//      `${agent_id}|${build_sha}|${deployed_at}|${exp}` using the same
//      RELEASE_MANIFEST_SIGNING_SECRET already used for /v1/version.
//      Token returned to caller; default TTL 1 hour.
//   4. Subsequent marketplace calls (search, skills, etc) carry the
//      token as X-Unbrowse-Session. The verifyExecToken middleware
//      recomputes the HMAC and constant-time-compares.
//
// Why this is "deep":
//   - The secret lives only on the server (wrangler secret).
//   - The set of valid (build_sha, deployed_at) tuples is server-side
//     KV; a patched binary cannot self-register because the registration
//     route is ADMIN_KEY gated and only CI workflows have that key.
//   - Patching the CLI to skip token injection means every marketplace
//     call returns 401; the binary still "runs" but has no
//     intelligence layer behind it.
//   - The token is bound to agent_id, so even if a token leaks it's
//     useless under a different bearer key.
//
// Substrate-faithful: the agent / CLI receives a clean 401 with
// error_code=unsigned_build and an actionable next_step pointing at
// `unbrowse update`. No silent degradation.

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

/** Fields statsKV(env) reads (the EmergentDB-backed stats store + CF fallback). */
type StatsKvEnv = Pick<Env, "STATS_KV" | "EMERGENTDB_API_KEY" | "EMERGENTDB_MAX_VALUE_BYTES" | "ENVIRONMENT">;

const encoder = new TextEncoder();

export const EXEC_TOKEN_DEFAULT_TTL_SECONDS = 3600;
export const EXEC_TOKEN_MAX_TTL_SECONDS = 24 * 3600;

export type IssueResult =
  | { ok: true; token: string; exp: number; agent_id: string; build_sha: string; deployed_at: string }
  | { ok: false; error_code: "unknown_build" | "missing_identity" | "secret_unconfigured"; reason: string };

export type VerifyResult =
  | { ok: true; agent_id: string; build_sha: string; deployed_at: string; exp: number }
  | { ok: false; error_code: "missing_token" | "malformed_token" | "expired_token" | "agent_mismatch" | "signature_mismatch" | "secret_unconfigured"; reason: string };

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildRegistryKey(buildSha: string, deployedAt: string): string {
  return `exec-build:${buildSha}:${deployedAt}`;
}

export async function registerBuild(
  env: StatsKvEnv,
  build_sha: string,
  deployed_at: string,
  meta: { version?: string; channel?: string; registered_by?: string } = {},
): Promise<void> {
  await statsKV(env).put(
    buildRegistryKey(build_sha, deployed_at),
    JSON.stringify({ build_sha, deployed_at, ...meta, registered_at: new Date().toISOString() }),
    { expirationTtl: 90 * 24 * 3600 },
  );
}

export async function isBuildRegistered(
  env: StatsKvEnv & Pick<Env, "UNBROWSE_BUILD_SHA" | "UNBROWSE_DEPLOYED_AT">,
  build_sha: string,
  deployed_at: string,
): Promise<boolean> {
  // Fast path: the CURRENT prod build is always a valid build to issue
  // tokens against (without it, the first deploy after registry creation
  // would refuse every token until CI re-registers).
  if (env.UNBROWSE_BUILD_SHA === build_sha && env.UNBROWSE_DEPLOYED_AT === deployed_at) {
    return true;
  }
  const row = await statsKV(env).get(buildRegistryKey(build_sha, deployed_at)) as string | null;
  return row !== null;
}

export async function issueExecToken(
  env: StatsKvEnv & Pick<Env, "RELEASE_MANIFEST_SIGNING_SECRET" | "UNBROWSE_BUILD_SHA" | "UNBROWSE_DEPLOYED_AT">,
  params: { agent_id: string; build_sha: string; deployed_at: string; ttl_seconds?: number },
): Promise<IssueResult> {
  if (!env.RELEASE_MANIFEST_SIGNING_SECRET) {
    return { ok: false, error_code: "secret_unconfigured", reason: "server RELEASE_MANIFEST_SIGNING_SECRET not set" };
  }
  if (!params.agent_id || !params.build_sha || !params.deployed_at) {
    return { ok: false, error_code: "missing_identity", reason: "agent_id, build_sha, deployed_at all required" };
  }
  const registered = await isBuildRegistered(env, params.build_sha, params.deployed_at);
  if (!registered) {
    return { ok: false, error_code: "unknown_build", reason: `(${params.build_sha}, ${params.deployed_at}) not registered. CI must POST /v1/internal/register-build first; reverse-engineered or patched builds cannot self-register.` };
  }
  const ttl = Math.min(
    EXEC_TOKEN_MAX_TTL_SECONDS,
    Math.max(60, params.ttl_seconds ?? EXEC_TOKEN_DEFAULT_TTL_SECONDS),
  );
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${params.agent_id}|${params.build_sha}|${params.deployed_at}|${exp}`;
  const sig = await hmacHex(env.RELEASE_MANIFEST_SIGNING_SECRET, payload);
  const payloadB64 = btoa(payload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return {
    ok: true,
    token: `${payloadB64}.${sig}`,
    exp,
    agent_id: params.agent_id,
    build_sha: params.build_sha,
    deployed_at: params.deployed_at,
  };
}

export async function verifyExecToken(
  env: Pick<Env, "RELEASE_MANIFEST_SIGNING_SECRET">,
  token: string | null | undefined,
  expected_agent_id: string,
): Promise<VerifyResult> {
  if (!env.RELEASE_MANIFEST_SIGNING_SECRET) {
    return { ok: false, error_code: "secret_unconfigured", reason: "server RELEASE_MANIFEST_SIGNING_SECRET not set" };
  }
  if (!token) {
    return { ok: false, error_code: "missing_token", reason: "X-Unbrowse-Session header missing; mint via POST /v1/session/exec-token" };
  }
  const dot = token.indexOf(".");
  if (dot < 1 || dot >= token.length - 1) {
    return { ok: false, error_code: "malformed_token", reason: "expected '<payload-b64>.<sig-hex>'" };
  }
  const payloadB64 = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  let payload: string;
  try {
    payload = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return { ok: false, error_code: "malformed_token", reason: "payload not base64url" };
  }
  const parts = payload.split("|");
  if (parts.length !== 4) {
    return { ok: false, error_code: "malformed_token", reason: "payload not '<agent_id>|<build_sha>|<deployed_at>|<exp>'" };
  }
  const [agent_id, build_sha, deployed_at, expStr] = parts as [string, string, string, string];
  const exp = parseInt(expStr, 10);
  if (Number.isNaN(exp)) {
    return { ok: false, error_code: "malformed_token", reason: "exp not numeric" };
  }
  if (Math.floor(Date.now() / 1000) >= exp) {
    return { ok: false, error_code: "expired_token", reason: `exp=${exp} is in the past; re-issue via POST /v1/session/exec-token` };
  }
  if (agent_id !== expected_agent_id) {
    return { ok: false, error_code: "agent_mismatch", reason: `token agent_id=${agent_id} != caller agent_id=${expected_agent_id}` };
  }
  const expected = await hmacHex(env.RELEASE_MANIFEST_SIGNING_SECRET, payload);
  const expectedBytes = hexToBytes(expected);
  const providedBytes = hexToBytes(sigHex);
  if (!expectedBytes || !providedBytes || !constantTimeEqual(expectedBytes, providedBytes)) {
    return { ok: false, error_code: "signature_mismatch", reason: "HMAC mismatch; token forged or secret rotated" };
  }
  return { ok: true, agent_id, build_sha, deployed_at, exp };
}
