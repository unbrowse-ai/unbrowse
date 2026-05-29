/**
 * Settings-state service — v7.2.0-preview.0 (Day-3 Land worker B, 2026-05-28).
 *
 * Per-wallet durable preferences (default_proxy, headless, auth_capture_mode
 * and other user-named keys). Mirrors W23 session-state pattern + Day-2 §F
 * SETTINGS_STATE shape: Ed25519 schema gate + sha256-hashed settingKey + KV.
 *
 * Conforms to the `StatelessNamespace<TBody>` interface declared in Day-2
 * boundary §G. Worker A is writing the canonical interface file at
 * `services/stateless-substrate.ts` in parallel; until then this module
 * conforms to the §G SHAPE verbatim.
 *
 * Doctrine — Prov 16:9 — "A man's heart deviseth his way: but the Lord
 * directeth his steps." Settings are the user's deliberate preferences;
 * the wallet IS the access control and the trust root. No values cross
 * this surface — only pointers to vault items or literal-prefixed
 * non-secret enums (`literal:true`, `literal:headless`).
 *
 * Operator provisioning:
 *   bunx wrangler kv:namespace create SETTINGS_STATE
 *   bunx wrangler kv:namespace create SETTINGS_STATE --preview
 *
 * ─── KV namespace: SETTINGS_STATE ──────────────────────────────────────────
 *
 * Key shape:
 *   settings:<walletPubkey-hex-lowercase>:<settingKeyHash>
 *     where settingKeyHash = sha256(settingKey)[:32] — settingKey is
 *     user-named (e.g. "default_proxy", "headless"); hashing keeps the
 *     key namespace non-enumerable from a KV listing.
 *
 * Wallet-prefix is THE security boundary (Day-2 §H #2).
 *
 * TTL: indefinite — settings are durable preferences, not session-scoped.
 *
 * ─── Pointer-only invariant (Day-2 §F + A4) ────────────────────────────────
 *
 * `settingValuePointer` MUST start with a known pointer scheme:
 *   literal:  | op://  | keychain://  | bw://  | arg://  | unbrowse://
 *
 * The `literal:` scheme is allowed for non-secret settings (e.g.
 * `literal:true` for headless, `literal:geo.iproyal.com:12321` for the
 * non-secret proxy host). Raw strings without a scheme are rejected
 * (defense against accidental cleartext credentials).
 *
 * The forbidden-field gate ALSO rejects: cleartext_value, value,
 * cleartext, secret, password, cookie, header, url, path, query.
 */

import type { Env } from "../types.js";
import {
  hexToBytes,
  bytesToHex,
  canonicalize,
  deriveCacheKey as coreDeriveCacheKey,
  deriveShortKeyHash,
  verifyEd25519,
  verifyWalletChallenge,
  assertNoCleartext,
  type ValidationError as CoreValidationError,
} from "./covenant-core.js";

// Re-export the shared hex helpers under their historical names.
export { hexToBytes, bytesToHex };

// ─── Signature scheme discriminator ────────────────────────────────────────

export type SettingsStateSignatureScheme = "ed25519-v7.0" | "groth16-v7.3";

const SIGNATURE_HEX_LENGTH: Partial<Record<SettingsStateSignatureScheme, number>> = {
  "ed25519-v7.0": 128,
} as const;

// ─── Hex / base64 shape regexes (validation-only, not crypto) ──────────────

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ─── Body shape ────────────────────────────────────────────────────────────

export interface SettingsSetBody {
  walletPubkey: string;
  signatureScheme?: SettingsStateSignatureScheme;
  signature: string;
  nonce: string;
  settingKey: string;            // user-named, NOT hashed on the wire
  settingValuePointer: string;   // must start with a known pointer scheme
}

export interface StoredSettingsRow extends SettingsSetBody {
  received_at: number;
  verify_ok: boolean;
  cacheKey: string;              // sha256(sig)[:32]
  keyHash: string;               // sha256(settingKey)[:32]
}

// ─── Canonical JSON ────────────────────────────────────────────────────────

export function canonicalizeSignedFragment(body: SettingsSetBody): string {
  return JSON.stringify({
    settingKey: body.settingKey,
    settingValuePointer: body.settingValuePointer,
    nonce: body.nonce,
  });
}

export function canonicalizeFullBody(body: SettingsSetBody): string {
  return JSON.stringify({
    ...JSON.parse(canonicalizeSignedFragment(body)),
    walletPubkey: body.walletPubkey,
    signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
    signature: body.signature,
  });
}

// ─── Cache-key + setting-key hash derivation ───────────────────────────────

export async function deriveCacheKey(signature: Uint8Array): Promise<string> {
  return coreDeriveCacheKey(signature);
}

export async function deriveCacheKeyHex(signatureHex: string): Promise<string> {
  return deriveCacheKey(hexToBytes(signatureHex));
}

export async function deriveSettingKeyHash(settingKey: string): Promise<string> {
  return deriveShortKeyHash(settingKey);
}

// ─── Pointer-scheme gate ───────────────────────────────────────────────────

const POINTER_SCHEMES = [
  "literal:",
  "op://",
  "keychain://",
  "bw://",
  "arg://",
  "unbrowse://",
];

function isValidPointer(p: string): boolean {
  if (p.length === 0 || p.length > 1024) return false;
  for (const prefix of POINTER_SCHEMES) {
    if (p.startsWith(prefix)) {
      // The remainder after the scheme must be non-empty (a bare
      // `literal:` or `op://` is a smuggling attempt).
      if (p.length === prefix.length) return false;
      return true;
    }
  }
  return false;
}

// ─── Schema validation ─────────────────────────────────────────────────────

export type ValidationError = CoreValidationError;

const SETTINGS_FORBIDDEN_REASON =
  "forbidden — settings-state carries pointer-only settingValuePointer (literal: / op:// / keychain:// etc.); never cleartext values";

/**
 * Settings-specific no-cleartext gate. Delegates the field-match to the shared
 * `assertNoCleartext` (covenant-core) and stamps the settings-state reason. The
 * covenant-core default forbidden list is a superset of settings-state's
 * historical list (including `cleartext_value`).
 */
function hasForbiddenField(body: Record<string, unknown>): ValidationError | null {
  const hit = assertNoCleartext(body);
  if (!hit) return null;
  return { field: hit.field, reason: SETTINGS_FORBIDDEN_REASON };
}

export function validateSettingsSetBody(raw: unknown): ValidationError | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { field: "$body", reason: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  const forbidden = hasForbiddenField(body);
  if (forbidden) return forbidden;

  for (const f of ["walletPubkey", "signature", "nonce", "settingKey", "settingValuePointer"]) {
    const v = body[f];
    if (typeof v !== "string" || v.length === 0) {
      return { field: f, reason: "required string field missing or empty" };
    }
  }

  // Signature scheme.
  const rawScheme = body.signatureScheme;
  if (rawScheme !== undefined && rawScheme !== null) {
    if (typeof rawScheme !== "string") {
      return { field: "signatureScheme", reason: "must be a string when present" };
    }
    if (!(rawScheme in SIGNATURE_HEX_LENGTH)) {
      return { field: "signatureScheme", reason: `unsupported scheme '${rawScheme}'` };
    }
  }
  const scheme: SettingsStateSignatureScheme = (rawScheme as SettingsStateSignatureScheme | undefined) ?? "ed25519-v7.0";

  // Wallet pubkey.
  const walletPubkey = body.walletPubkey as string;
  const walletClean = walletPubkey.startsWith("0x") ? walletPubkey.slice(2) : walletPubkey;
  if (walletClean.length !== 64 || !HEX_RE.test(walletClean)) {
    return { field: "walletPubkey", reason: "must be 32-byte hex (64 chars)" };
  }

  // Signature.
  const signature = body.signature as string;
  const sigClean = signature.startsWith("0x") ? signature.slice(2) : signature;
  const expectedLen = SIGNATURE_HEX_LENGTH[scheme];
  if (expectedLen === undefined) {
    return { field: "signatureScheme", reason: `scheme '${scheme}' has no pinned signature length yet` };
  }
  if (sigClean.length !== expectedLen || !HEX_RE.test(sigClean)) {
    return { field: "signature", reason: `must be ${expectedLen / 2}-byte ${scheme} hex (${expectedLen} chars)` };
  }

  // Nonce.
  const nonce = body.nonce as string;
  if (!BASE64_RE.test(nonce) || nonce.length < 43 || nonce.length > 44) {
    return { field: "nonce", reason: "must be base64-encoded 32 bytes (43-44 chars)" };
  }

  // settingKey — user-named string, bounded length.
  const settingKey = body.settingKey as string;
  if (settingKey.length > 128) {
    return { field: "settingKey", reason: "must be <= 128 chars" };
  }
  if (!/^[a-zA-Z0-9_\-.]+$/.test(settingKey)) {
    return {
      field: "settingKey",
      reason: "must match [a-zA-Z0-9_\\-.]+ (no whitespace, no special chars)",
    };
  }

  // settingValuePointer — pointer-only invariant.
  const ptr = body.settingValuePointer as string;
  if (!isValidPointer(ptr)) {
    return {
      field: "settingValuePointer",
      code: "not_a_pointer",
      reason:
        "must start with literal: | op:// | keychain:// | bw:// | arg:// | unbrowse:// — raw values are forbidden (use literal:<value> for non-secret settings)",
    };
  }

  return null;
}

// ─── Ed25519 verification ──────────────────────────────────────────────────

export async function verifySettingsSetSignature(body: SettingsSetBody): Promise<boolean> {
  const canonical = canonicalizeSignedFragment(body);
  const dataBytes = new TextEncoder().encode(canonical);
  return verifyEd25519(body.walletPubkey, body.signature, dataBytes);
}

/**
 * Verify the read-challenge sig: Ed25519 over `<keyHash> || ":" || <ts>`
 * under the supplied walletPubkey. Mirrors session-state's
 * verifyRestoreChallenge. Delegates to covenant-core's
 * `verifyWalletChallenge`, which builds the identical `<challenge>:<ts>`
 * colon-joined message (keyHash is the challenge token here).
 */
export async function verifyReadChallenge(
  keyHash: string,
  timestampMs: number,
  walletPubkeyHex: string,
  sigHex: string,
): Promise<boolean> {
  return verifyWalletChallenge(keyHash, sigHex, walletPubkeyHex, timestampMs);
}

/**
 * Canonical signed-payload for the DELETE challenge.
 * Stable JSON object so the CLI W24.6 purge wave can reproduce it
 * exactly: `{"keyHash":"<32hex>","timestamp_unix_ms":<int>}` with
 * key order keyHash → timestamp_unix_ms. Built via covenant-core's
 * insertion-order `canonicalize` (the field set + order are unchanged).
 */
export function canonicalDeleteChallenge(
  keyHash: string,
  timestampMs: number,
): string {
  return canonicalize({
    keyHash,
    timestamp_unix_ms: timestampMs,
  });
}

/**
 * Verify the DELETE-challenge sig: Ed25519 over the canonical JSON
 * `{"keyHash":<keyHash>,"timestamp_unix_ms":<ts>}` under the supplied
 * walletPubkey. Mirrors verifyReadChallenge but uses a canonical JSON
 * payload (W24.7 spec).
 */
export async function verifyDeleteChallenge(
  keyHash: string,
  timestampMs: number,
  walletPubkeyHex: string,
  sigHex: string,
): Promise<boolean> {
  const message = canonicalDeleteChallenge(keyHash, timestampMs);
  const messageBytes = new TextEncoder().encode(message);
  return verifyEd25519(walletPubkeyHex, sigHex, messageBytes);
}

// ─── KV key derivation ─────────────────────────────────────────────────────

export function settingsKeyPrefix(walletPubkey: string): string {
  const wallet = walletPubkey.toLowerCase().replace(/^0x/, "");
  return `settings:${wallet}:`;
}

export function settingsPrimaryKey(walletPubkey: string, keyHash: string): string {
  return `${settingsKeyPrefix(walletPubkey)}${keyHash}`;
}

// ─── KV storage ────────────────────────────────────────────────────────────

export class BindingMissingError extends Error {
  readonly code = "settings_state_binding_missing";
  readonly namespace = "SETTINGS_STATE";
  constructor() {
    super(
      "env.SETTINGS_STATE is undefined — operator must run `bunx wrangler kv:namespace create SETTINGS_STATE` (and `--preview`), then paste the ids into backend/wrangler.toml.",
    );
    this.name = "BindingMissingError";
  }
}

function requireSettingsState(env: Env): KVNamespace {
  if (!env.SETTINGS_STATE) throw new BindingMissingError();
  return env.SETTINGS_STATE;
}

/**
 * Persist a settings row. Idempotent on cacheKey = sha256(sig)[:32].
 * NOTE: a re-POST overwrites the row at the same primaryKey (which is
 * keyed by `settingKey`, not by `cacheKey`) — settings are
 * last-writer-wins per (wallet, settingKey). Idempotency at the
 * substrate level means: the SAME body produces the same cacheKey and
 * the route reports `idempotent: true` so callers know they didn't
 * just clobber a value.
 */
export async function persistSettingsRow(
  env: Env,
  body: SettingsSetBody,
  verifyOk: boolean,
  nowMs: number = Date.now(),
): Promise<{ cacheKey: string; keyHash: string; primaryKey: string; idempotent: boolean }> {
  const kv = requireSettingsState(env);
  const cacheKey = await deriveCacheKeyHex(body.signature);
  const keyHash = await deriveSettingKeyHash(body.settingKey);
  const primaryKey = settingsPrimaryKey(body.walletPubkey, keyHash);

  // Idempotency probe — same body produces same cacheKey; check if
  // existing row carries the same cacheKey.
  const existing = await kv.get(primaryKey);
  if (existing) {
    try {
      const existingRow = JSON.parse(existing) as StoredSettingsRow;
      if (existingRow.cacheKey === cacheKey) {
        return { cacheKey, keyHash, primaryKey, idempotent: true };
      }
    } catch {
      // Corrupt — overwrite.
    }
  }

  const storedRow: StoredSettingsRow = {
    ...body,
    signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
    received_at: nowMs,
    verify_ok: verifyOk,
    cacheKey,
    keyHash,
  };

  // No TTL — settings are durable preferences.
  await kv.put(primaryKey, JSON.stringify(storedRow));

  return { cacheKey, keyHash, primaryKey, idempotent: false };
}

/**
 * Read one settings row by (walletPubkey, keyHash). Wallet-prefix
 * isolation is structural; defense-in-depth re-checks the stored
 * walletPubkey matches the caller's.
 */
export async function readSettingsRow(
  env: Env,
  walletPubkey: string,
  keyHash: string,
): Promise<StoredSettingsRow | null> {
  const kv = requireSettingsState(env);
  const key = settingsPrimaryKey(walletPubkey, keyHash);
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSettingsRow;
    // Defense-in-depth — should be unreachable given wallet-prefix
    // isolation, but Day-2 §G #5 requires the explicit re-check.
    const stored = parsed.walletPubkey?.toLowerCase().replace(/^0x/, "") ?? "";
    const caller = walletPubkey.toLowerCase().replace(/^0x/, "");
    if (stored !== caller) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete one settings row by (walletPubkey, keyHash). Idempotent —
 * `{deleted: false, idempotent: true}` when no row exists at the
 * structural key. Defense-in-depth wallet-match: if a row exists
 * whose stored walletPubkey does not match the caller's, returns
 * `{deleted: false, wallet_mismatch: true}` so the route can render
 * 403 instead of silently deleting another wallet's row (should be
 * unreachable given wallet-prefix isolation, but Day-2 §G #5).
 *
 * Mirrors W8's persistAuditRow shape (returns a structured outcome
 * object rather than throwing on the absent case — the absent path
 * is a valid, idempotent answer).
 */
export async function deleteSettingsRow(
  env: Env,
  walletPubkey: string,
  keyHash: string,
): Promise<
  | { deleted: true; primaryKey: string }
  | { deleted: false; idempotent: true; primaryKey: string }
  | { deleted: false; wallet_mismatch: true; primaryKey: string }
> {
  const kv = requireSettingsState(env);
  const primaryKey = settingsPrimaryKey(walletPubkey, keyHash);
  const existing = await kv.get(primaryKey);
  if (!existing) {
    return { deleted: false, idempotent: true, primaryKey };
  }
  try {
    const parsed = JSON.parse(existing) as StoredSettingsRow;
    const stored = parsed.walletPubkey?.toLowerCase().replace(/^0x/, "") ?? "";
    const caller = walletPubkey.toLowerCase().replace(/^0x/, "");
    if (stored !== caller) {
      return { deleted: false, wallet_mismatch: true, primaryKey };
    }
  } catch {
    // Corrupt row at our prefix — owned by us by structural rule, fall through and delete.
  }
  await kv.delete(primaryKey);
  return { deleted: true, primaryKey };
}

/**
 * List settings rows for one wallet. Same defense-in-depth as
 * readSettingsRow.
 */
export async function listSettingsByWallet(
  env: Env,
  walletPubkey: string,
  limit: number,
): Promise<StoredSettingsRow[]> {
  const kv = requireSettingsState(env);
  const prefix = settingsKeyPrefix(walletPubkey);
  const listed = await kv.list({ prefix, limit });
  if (listed.keys.length === 0) return [];
  const values = await Promise.all(listed.keys.map((k) => kv.get(k.name)));
  const rows: StoredSettingsRow[] = [];
  for (const v of values) {
    if (!v) continue;
    try {
      const parsed = JSON.parse(v) as StoredSettingsRow;
      const stored = parsed.walletPubkey?.toLowerCase().replace(/^0x/, "") ?? "";
      const caller = walletPubkey.toLowerCase().replace(/^0x/, "");
      if (stored !== caller) continue;
      rows.push(parsed);
    } catch {
      continue;
    }
  }
  return rows;
}
