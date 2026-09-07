import { nanoid } from "nanoid";
import type { Env } from "../types.js";
import { skillsKV, statsKV } from "./kv.js";

/**
 * Domain verification via .well-known HTTP probe.
 *
 * Flow:
 *   1. Publisher calls `POST /v1/skills/by-domain/:domain/verify/challenge`.
 *      Server issues a token (`unbrowse-verify-<nanoid>`), stores it under
 *      `verify-challenge:<domain>`, and returns the path the publisher must
 *      serve (`https://<domain>/.well-known/<token>`) along with the body
 *      string the publisher must place at that path.
 *   2. Publisher places the body at the path on their domain.
 *   3. Publisher calls `POST /v1/skills/by-domain/:domain/verify/probe`.
 *      Server fetches `https://<domain>/.well-known/<token>` with strict
 *      timeouts and SSRF guards, compares the body, and on success stamps
 *      `domain_verified: true` + `domain_verified_at` on the skill record.
 *
 * Security boundary:
 *   - Tokens are 21-char nanoid, single-use, 30-minute TTL.
 *   - Probe runs `https://` only (no http downgrade), no redirects, no
 *     credentials, 5-second timeout, body capped at 4 KB.
 *   - The probe URL is `https://<domain>/.well-known/<token>` — no path
 *     placeholder a publisher could redirect away.
 *   - We resolve hostname against a private-IP blocklist before fetching so
 *     a domain like `localhost` or an attacker-controlled DNS pointing at
 *     internal infra cannot trigger SSRF.
 */

const CHALLENGE_TTL_SECONDS = 30 * 60;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_BODY_BYTES = 4 * 1024;

const PRIVATE_HOST_RE =
  /^(localhost|127\.|::1|fe80:|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|fc00::|fd00:)/i;
const NUMERIC_HOST_RE = /^\d+$/;
const HEX_HOST_RE = /^0x[0-9a-f]+$/i;

export interface DomainChallenge {
  domain: string;
  token: string;
  body: string;
  path: string;
  expected_url: string;
  agent_id: string;
  created_at: string;
  expires_at: string;
}

function challengeKey(domain: string): string {
  return `verify-challenge:${domain.toLowerCase()}`;
}

function isProbeHostAllowed(env: Env, host: string): boolean {
  const skipList = ((env as { DOMAIN_VERIFY_SKIP?: string }).DOMAIN_VERIFY_SKIP ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (skipList.includes(host.toLowerCase())) return true;
  if (PRIVATE_HOST_RE.test(host)) return false;
  if (NUMERIC_HOST_RE.test(host)) return false;
  if (HEX_HOST_RE.test(host)) return false;
  return true;
}

export async function issueDomainChallenge(
  env: Env,
  domain: string,
  agentId: string,
): Promise<DomainChallenge> {
  const token = `unbrowse-verify-${nanoid()}`;
  const body = `unbrowse-domain-control:${domain.toLowerCase()}:${token}`;
  const path = `/.well-known/${token}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000);
  const challenge: DomainChallenge = {
    domain: domain.toLowerCase(),
    token,
    body,
    path,
    expected_url: `https://${domain.toLowerCase()}${path}`,
    agent_id: agentId,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  await statsKV(env).put(challengeKey(domain), JSON.stringify(challenge), {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });
  return challenge;
}

export async function loadDomainChallenge(
  env: Env,
  domain: string,
): Promise<DomainChallenge | null> {
  const raw = await statsKV(env).get(challengeKey(domain)) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DomainChallenge;
  } catch {
    return null;
  }
}

export async function clearDomainChallenge(env: Env, domain: string): Promise<void> {
  await statsKV(env).delete(challengeKey(domain)).catch(() => {});
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  reason?: string;
  detail?: string;
}

export async function probeDomain(
  env: Env,
  challenge: DomainChallenge,
): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(challenge.expected_url);
  } catch (err) {
    return { ok: false, reason: "invalid_probe_url", detail: (err as Error).message };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "https_only", detail: parsed.protocol };
  }
  if (!isProbeHostAllowed(env, parsed.hostname)) {
    return { ok: false, reason: "host_blocked", detail: parsed.hostname };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "manual", // we don't follow — a redirect to attacker.com is a fail
      signal: controller.signal,
      headers: {
        "User-Agent": "unbrowse-domain-verify/1.0 (+https://unbrowse.ai/security)",
        Accept: "text/plain",
      },
    });
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, reason: "redirect_not_allowed" };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, reason: "non_200" };
    }
    const text = (await res.text()).slice(0, MAX_PROBE_BODY_BYTES).trim();
    if (text !== challenge.body.trim()) {
      return {
        ok: false,
        status: res.status,
        reason: "body_mismatch",
        detail: `expected ${challenge.body.length} chars, got ${text.length}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: "fetch_failed", detail: (err as Error).message };
  }
}

/** Mark the latest skill for `domain` as verified. Returns true on success. */
export async function markDomainVerified(env: Env, domain: string): Promise<boolean> {
  // Find the canonical skill record for this domain via the existing index.
  const kv = skillsKV(env);
  const target = domain.toLowerCase();
  const skillId = await kv.get(`domain-idx:${target}`) as string | null;
  if (!skillId) return false;
  const raw = await kv.get(`skill:${skillId}`) as string | null;
  if (!raw) return false;
  let skill: Record<string, unknown>;
  try { skill = JSON.parse(raw) as Record<string, unknown>; } catch { return false; }
  skill.domain_verified = true;
  skill.domain_verified_at = new Date().toISOString();
  await kv.put(`skill:${skillId}`, JSON.stringify(skill));
  return true;
}
