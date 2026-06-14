/**
 * src/proof/input-censor.ts — ZK-style censoring of tool-INPUT data.
 *
 * The proof/commitment module commits the RESPONSE (proof-of-data). This module
 * commits the REQUEST input: when an agent-driven write carries sensitive fields
 * (password, token, api_key, …) in its body, the live request still sends the
 * real value to the intended target, but any PERSISTED or PUBLISHED copy of the
 * route (skill-cache on disk, the shared marketplace) carries only a hash
 * commitment `sha256:<hex>` in place of the secret.
 *
 * The reusable route shape survives (the next caller supplies their own value,
 * verified against the commitment); the secret never crosses the persistence /
 * publish firmament in clear. This is the "input data passed as tools, censored
 * via zk" invariant: commit-and-send, never persist-in-clear.
 */
import { createHash } from "node:crypto";

/** Field-name patterns that mark a value as sensitive input (case-insensitive). */
const SENSITIVE_FIELD = new RegExp(
  [
    "pass(word|wd|phrase)?",
    "secret",
    "token",
    "api[_-]?key",
    "apikey",
    "auth(orization|_token)?",
    "access[_-]?key",
    "client[_-]?secret",
    "private[_-]?key",
    "mnemonic",
    "seed[_-]?phrase",
    "ssn",
    "credit[_-]?card",
    "card[_-]?number",
    "cvv",
    "pin",
    "otp",
    "session[_-]?id",
    "cookie",
  ].join("|"),
  "i",
);

/** A value already shaped like a vault pointer is sensitive by construction. */
function looksLikePointer(v: string): boolean {
  return /^(op|keychain|bw|arg|vault):\/\//.test(v);
}

/** sha256 commitment of a string value → "sha256:<hex>". */
export function commitValue(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD.test(name);
}

export type CensorResult<T> = {
  censored: T;
  /** field-path → commitment, e.g. "password" → "sha256:…". */
  commitments: Record<string, string>;
  didCensor: boolean;
};

/**
 * Deep-clone `body` and replace every sensitive leaf with its commitment.
 * A leaf is sensitive when its key matches SENSITIVE_FIELD, or its string value
 * is already a vault pointer. Non-sensitive values pass through unchanged.
 */
export function censorInputBody(body: unknown, prefix = ""): CensorResult<unknown> {
  const commitments: Record<string, string> = {};
  let didCensor = false;

  const walk = (val: unknown, keyName: string, path: string): unknown => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = walk(v, k, path ? `${path}.${k}` : k);
      }
      return out;
    }
    if (Array.isArray(val)) {
      return val.map((v, i) => walk(v, keyName, `${path}[${i}]`));
    }
    // leaf
    const sensitive =
      isSensitiveFieldName(keyName) ||
      (typeof val === "string" && looksLikePointer(val));
    if (sensitive && (typeof val === "string" || typeof val === "number" || typeof val === "boolean")) {
      const commitment = commitValue(String(val));
      commitments[path || keyName] = commitment;
      didCensor = true;
      return commitment;
    }
    return val;
  };

  const censored = walk(body, prefix, prefix);
  return { censored, commitments, didCensor };
}

/**
 * Censor every WRITE-endpoint body on a skill manifest for persistence/publish.
 * Returns a structurally-cloned skill with sensitive body leaves replaced by
 * commitments. Read endpoints (GET/HEAD) and bodyless endpoints are untouched.
 * Pure — does not mutate the input.
 */
export function censorSkillForPersistence<
  T extends { endpoints?: Array<Record<string, unknown>> },
>(skill: T): { skill: T; didCensor: boolean } {
  if (!skill || !Array.isArray(skill.endpoints)) return { skill, didCensor: false };
  let didCensor = false;
  const endpoints = skill.endpoints.map((ep) => {
    const method = String((ep as { method?: string }).method ?? "GET").toUpperCase();
    const body = (ep as { body?: unknown }).body;
    if ((method === "GET" || method === "HEAD") || body == null) return ep;
    const res = censorInputBody(body);
    if (!res.didCensor) return ep;
    didCensor = true;
    return {
      ...ep,
      body: res.censored,
      input_commitments: res.commitments,
    };
  });
  if (!didCensor) return { skill, didCensor: false };
  return { skill: { ...skill, endpoints } as T, didCensor: true };
}
