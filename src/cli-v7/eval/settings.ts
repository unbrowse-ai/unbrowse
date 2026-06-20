/**
 * `unbrowse eval settings` — wallet-scoped settings registry (KV).
 *
 * 1:1 mapping (kind-map.ts row "eval settings"):
 *   CLI subcommand  : eval settings
 *   MCP tool        : unbrowse_settings
 *   Op kind   : eval:settings
 *   Verb            : eval
 *
 * W24.6 (Lewis 2026-05-28 — "stateless is the only path"):
 *   Read/write travels through SETTINGS_STATE (KV) over postStateless.
 *   Delete goes through `DELETE /v1/settings/<keyHash>` (W24.7).
 *   Values MUST be pointer-shaped (literal: | op:// | keychain:// |
 *   bw:// | arg:// | unbrowse://) — Day-3 schema gate (backend) AND
 *   CLI-side pre-validation form defense-in-depth. The `literal:`
 *   scheme is the explicit user opt-in to publish a non-secret value
 *   by pointer (e.g. `literal:false` for headless, `literal:auto` for
 *   auth_capture_mode).
 *
 *   Reads return the stored `settingValuePointer` (a pointer registry,
 *   NOT a value cache — resolution happens at use-time elsewhere).
 *
 *   On backend 503 with `_binding_missing: "SETTINGS_STATE"`, a stash
 *   file is written under `~/.unbrowse/tmp/<sigHash>/settings-stash.json`
 *   for later replay.
 *
 * ─── Migration ────────────────────────────────────────────────────────────
 *
 * `migrateLegacySettings(opts)` is exported but NEVER auto-fired. The
 * operator opts in deliberately to migrate any pre-W24.6
 * `~/.unbrowse/settings.json` file into SETTINGS_STATE — each legacy
 * key/value gets wrapped as `literal:<value>` and POSTed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
// `readFile`, `writeFile`, `mkdir` are kept for stash + migration only.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless, type PostStatelessResult } from "../_stateless.js";
import { signBytes } from "../../values/signer.js";

/**
 * CLI-side pointer-prefix regex. Defense-in-depth alongside the
 * backend `isValidPointer` gate.
 *
 * Rule: the raw value MUST start with one of the six known schemes AND
 * the remainder after the scheme MUST be non-empty (a bare `literal:`
 * or `op://` is a smuggling attempt — rejected by the backend too).
 */
export const POINTER_PREFIX_REGEX =
  /^(literal:|op:\/\/|keychain:\/\/|bw:\/\/|arg:\/\/|unbrowse:\/\/).+$/;

export interface SettingsFile {
  default_proxy?: string;
  headless?: boolean;
  auth_capture_mode?: string;
  [k: string]: unknown;
}

function resolveHome(override?: string): string {
  if (override) return override;
  // U-3: honor UNBROWSE_HOME (unbrowse-specific home override; was documented but ignored),
  // then a runtime $HOME override (some tests / sandboxes set $HOME mid-process), then OS home.
  return process.env.UNBROWSE_HOME ?? process.env.HOME ?? homedir();
}

function legacySettingsPath(home?: string): string {
  return join(resolveHome(home), ".unbrowse", "settings.json");
}

function stashRoot(home?: string): string {
  return join(resolveHome(home), ".unbrowse", "tmp");
}

function getBackendUrl(): string | undefined {
  return process.env.UNBROWSE_BACKEND_URL || process.env.UNBROWSE_API_URL || undefined;
}

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
  return h;
}

/**
 * Derive a 32-char hex sha256 prefix of the setting key. Byte-identical
 * to backend's `deriveSettingKeyHash` (services/settings-state.ts).
 */
export function deriveSettingKeyHash(settingKey: string): string {
  return createHash("sha256").update(settingKey, "utf8").digest("hex").slice(0, 32);
}

/**
 * Read the pre-W24.6 `~/.unbrowse/settings.json` (if present) — used
 * ONLY by `migrateLegacySettings` to lift values into SETTINGS_STATE.
 * Returns `{}` when the file is absent (no migration to do).
 */
export async function readSettings(home?: string): Promise<SettingsFile> {
  try {
    const raw = await readFile(legacySettingsPath(home), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SettingsFile;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Pre-validation: the value MUST be pointer-shaped. Returns `null`
 * when accepted, otherwise an error code.
 *
 * SETTINGS_STATE is a per-wallet preferences namespace where the
 * settingKey is user-named (matches Day-3 schema's `[a-zA-Z0-9_\-.]+`
 * regex). Backend re-validates everything.
 */
export function rejectionReasonStateless(settingKey: string, rawValue: string): string | null {
  if (!settingKey || settingKey.length === 0) return "missing_setting_key";
  if (settingKey.length > 128) return "setting_key_too_long";
  if (!/^[a-zA-Z0-9_\-.]+$/.test(settingKey)) return "setting_key_invalid_chars";
  if (!POINTER_PREFIX_REGEX.test(rawValue)) return "value_is_not_pointer";
  if (rawValue.length > 1024) return "value_too_long";
  return null;
}

// ─── Stash on binding-missing ──────────────────────────────────────────────

interface StashRecord {
  written_at: number;
  settingKey: string;
  settingValuePointer: string;
  cacheKey: string;
  reason: "binding_missing" | "http_failure";
  httpStatus: number;
  bindingMissing?: string;
}

async function writeStash(cacheKey: string, record: StashRecord, home?: string): Promise<string> {
  // Use cacheKey (or a sigHash-equivalent) as the directory namespace so
  // each stash is content-addressed and never collides.
  const sigHash = cacheKey || createHash("sha256")
    .update(`${record.settingKey}:${record.settingValuePointer}:${record.written_at}`)
    .digest("hex")
    .slice(0, 32);
  const dir = join(stashRoot(home), sigHash);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "settings-stash.json");
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return path;
}

// ─── Stateless POST (write) ────────────────────────────────────────────────

async function postSettingsStateless(
  settingKey: string,
  settingValuePointer: string,
): Promise<PostStatelessResult> {
  return postStateless({
    namespace: "settings",
    route: "/v1/settings/set",
    body: {
      settingKey,
      settingValuePointer,
    },
    signableFields: ["settingKey", "settingValuePointer", "nonce"],
    apiBaseUrl: getBackendUrl(),
  });
}

// ─── Stateless GET (read) ──────────────────────────────────────────────────

interface SettingsGetAck {
  ok?: boolean;
  keyHash?: string;
  row?: {
    settingKey?: string;
    settingValuePointer?: string;
    received_at?: number;
    cacheKey?: string;
    keyHash?: string;
  };
  _binding_status?: string;
  _binding_missing?: string;
  error?: string;
  reason?: string;
}

async function getSettingsStateless(
  settingKey: string,
): Promise<{
  ok: boolean;
  httpStatus: number;
  keyHash: string;
  row?: SettingsGetAck["row"];
  bindingMissing?: string;
  errorCode?: string;
  errorReason?: string;
}> {
  const keyHash = deriveSettingKeyHash(settingKey);
  const timestampMs = Date.now();
  const message = new TextEncoder().encode(`${keyHash}:${timestampMs}`);
  const { signature: sigBytes, walletPubkey: pubBytes } = await signBytes(message);
  const sigHex = bytesToHex(sigBytes);
  const pubHex = bytesToHex(pubBytes);

  const base = (getBackendUrl() ?? "https://beta-api.unbrowse.ai").replace(/\/$/, "");
  const url = `${base}/v1/settings/get/${keyHash}`;

  let httpStatus = 0;
  let ack: SettingsGetAck = {};
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `WalletSig ${sigHex}`,
        "X-Wallet-Pubkey": pubHex,
        "X-Wallet-Timestamp": String(timestampMs),
      },
    });
    httpStatus = res.status;
    try {
      ack = (await res.json()) as SettingsGetAck;
    } catch {
      ack = {};
    }
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      keyHash,
      errorCode: "network_error",
      errorReason: (err as Error).message?.slice(0, 200),
    };
  }

  if (httpStatus === 503 && typeof ack._binding_missing === "string") {
    return {
      ok: false,
      httpStatus,
      keyHash,
      bindingMissing: ack._binding_missing,
    };
  }

  if (httpStatus >= 200 && httpStatus < 300 && ack.row) {
    return { ok: true, httpStatus, keyHash, row: ack.row };
  }

  return {
    ok: false,
    httpStatus,
    keyHash,
    errorCode: ack.error ?? `http_${httpStatus}`,
    errorReason: ack.reason,
  };
}

// ─── Stateless DELETE (W24.7) ──────────────────────────────────────────────

interface SettingsDeleteAck {
  ok?: boolean;
  deleted?: boolean;
  idempotent?: boolean;
  cacheKey?: string;
  _binding_status?: string;
  _binding_missing?: string;
  error?: string;
  reason?: string;
}

/**
 * Wallet-signed purge against `DELETE /v1/settings/<keyHash>` (W24.7).
 * Canonical signed JSON is `{"keyHash":"<hex>","timestamp_unix_ms":<int>}`
 * — byte-equivalent to backend's `canonicalDeleteChallenge`.
 */
async function deleteSettingsStateless(
  settingKey: string,
): Promise<{
  ok: boolean;
  httpStatus: number;
  keyHash: string;
  deleted: boolean;
  cacheKey?: string;
  bindingMissing?: string;
  errorCode?: string;
  errorReason?: string;
}> {
  const keyHash = deriveSettingKeyHash(settingKey);
  const timestampMs = Date.now();
  const canonical = JSON.stringify({
    keyHash,
    timestamp_unix_ms: timestampMs,
  });
  const message = new TextEncoder().encode(canonical);
  const { signature: sigBytes, walletPubkey: pubBytes } = await signBytes(message);
  const sigHex = bytesToHex(sigBytes);
  const pubHex = bytesToHex(pubBytes);

  const base = (getBackendUrl() ?? "https://beta-api.unbrowse.ai").replace(/\/$/, "");
  const url = `${base}/v1/settings/${keyHash}`;

  let httpStatus = 0;
  let ack: SettingsDeleteAck = {};
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `WalletSig ${sigHex}`,
        "X-Wallet-Pubkey": pubHex,
        "X-Wallet-Timestamp": String(timestampMs),
      },
    });
    httpStatus = res.status;
    try {
      ack = (await res.json()) as SettingsDeleteAck;
    } catch {
      ack = {};
    }
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      keyHash,
      deleted: false,
      errorCode: "network_error",
      errorReason: (err as Error).message?.slice(0, 200),
    };
  }

  if (httpStatus === 503 && typeof ack._binding_missing === "string") {
    return {
      ok: false,
      httpStatus,
      keyHash,
      deleted: false,
      cacheKey: ack.cacheKey,
      bindingMissing: ack._binding_missing,
    };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      ok: true,
      httpStatus,
      keyHash,
      deleted: ack.deleted === true,
      cacheKey: ack.cacheKey,
    };
  }

  return {
    ok: false,
    httpStatus,
    keyHash,
    deleted: false,
    cacheKey: ack.cacheKey,
    errorCode: ack.error ?? `http_${httpStatus}`,
    errorReason: ack.reason,
  };
}

// ─── Migration helper (opt-in, NOT auto-fired) ─────────────────────────────

export interface MigrationResult {
  attempted: number;
  ok: number;
  stashed: number;
  rejected: number;
  details: Array<{
    settingKey: string;
    valuePointer: string;
    outcome: "ok" | "stashed" | "rejected" | "error";
    cacheKey?: string;
    bindingMissing?: string;
    rejectionReason?: string;
    httpStatus?: number;
  }>;
}

/**
 * Opt-in migration of legacy `~/.unbrowse/settings.json` → SETTINGS_STATE.
 *
 * Wraps each value as `literal:<json-stringified-value>` (preserves
 * boolean/string shape on the way through the pointer). Operator runs
 * this deliberately — there is no auto-fire path. Returns a per-key
 * outcome report so the caller can judge in-thread.
 *
 * The legacy file is NOT deleted by this helper; the operator decides
 * whether to remove it after verifying the KV row reads back correctly.
 */
export async function migrateLegacySettings(home?: string): Promise<MigrationResult> {
  const result: MigrationResult = {
    attempted: 0,
    ok: 0,
    stashed: 0,
    rejected: 0,
    details: [],
  };
  const legacy = await readSettings(home);
  for (const [k, v] of Object.entries(legacy)) {
    if (v === undefined || v === null) continue;
    result.attempted++;
    const raw = typeof v === "string" ? v : JSON.stringify(v);
    const pointer = `literal:${raw}`;
    const reason = rejectionReasonStateless(k, pointer);
    if (reason) {
      result.rejected++;
      result.details.push({
        settingKey: k,
        valuePointer: pointer,
        outcome: "rejected",
        rejectionReason: reason,
      });
      continue;
    }
    try {
      const post = await postSettingsStateless(k, pointer);
      if (post.ok) {
        result.ok++;
        result.details.push({
          settingKey: k,
          valuePointer: pointer,
          outcome: "ok",
          cacheKey: post.cacheKey,
          httpStatus: post.httpStatus,
        });
      } else if (post.bindingMissing) {
        await writeStash(post.cacheKey, {
          written_at: Date.now(),
          settingKey: k,
          settingValuePointer: pointer,
          cacheKey: post.cacheKey,
          reason: "binding_missing",
          httpStatus: post.httpStatus,
          bindingMissing: post.bindingMissing,
        }, home);
        result.stashed++;
        result.details.push({
          settingKey: k,
          valuePointer: pointer,
          outcome: "stashed",
          cacheKey: post.cacheKey,
          bindingMissing: post.bindingMissing,
          httpStatus: post.httpStatus,
        });
      } else {
        result.details.push({
          settingKey: k,
          valuePointer: pointer,
          outcome: "error",
          cacheKey: post.cacheKey,
          httpStatus: post.httpStatus,
        });
      }
    } catch (err) {
      result.details.push({
        settingKey: k,
        valuePointer: pointer,
        outcome: "error",
        rejectionReason: (err as Error).message?.slice(0, 200),
      });
    }
  }
  return result;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "settings")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval settings",
      {
        summary: meta.summary,
        usage: "unbrowse eval settings [--set key=value] [--unset key] [--get key]",
        flags: [
          { name: "--set", description: "Set `key=value` (pointer-prefixed value: literal:|op://|keychain://|bw://|arg://|unbrowse://).", value_expected: true },
          { name: "--unset", description: "Remove a key (DELETE /v1/settings/<keyHash>).", value_expected: true },
          { name: "--get", description: "Read a single key — returns the stored pointer.", value_expected: true },
          { name: "--include-env", description: "Include resolved env-var names (not values)." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const setFlag = typeof parsed.flags.set === "string" ? parsed.flags.set : undefined;
  const unsetFlag = typeof parsed.flags.unset === "string" ? parsed.flags.unset : undefined;
  const getFlag = typeof parsed.flags.get === "string" ? parsed.flags.get : undefined;
  const includeEnv = parsed.flags["include-env"] === true;

  try {
    if (setFlag) {
      const eq = setFlag.indexOf("=");
      if (eq < 0) {
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            error: "bad_set_syntax",
            hint: "Use --set key=value (value must be pointer-prefixed: literal:|op://|keychain://|bw://|arg://|unbrowse://).",
          },
          opts,
        );
        process.exit(EX_USAGE);
      }
      const settingKey = setFlag.slice(0, eq);
      const settingValuePointer = setFlag.slice(eq + 1);

      // CLI-side pointer-prefix gate (defense-in-depth; backend re-checks).
      const reason = rejectionReasonStateless(settingKey, settingValuePointer);
      if (reason) {
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            error: reason,
            key: settingKey,
            hint:
              reason === "value_is_not_pointer"
                ? "Settings carry pointers only. Use a known scheme: literal: | op:// | keychain:// | bw:// | arg:// | unbrowse://. For non-secret values: literal:<value> (e.g. literal:false)."
                : reason.startsWith("setting_key_")
                  ? "settingKey must match [a-zA-Z0-9_\\-.]+ and be ≤ 128 chars."
                  : "value too long (>1024 chars).",
            pointer_prefix_regex: POINTER_PREFIX_REGEX.source,
          },
          opts,
        );
        process.exit(EX_USAGE);
      }

      const post = await postSettingsStateless(settingKey, settingValuePointer);
      if (post.ok) {
        emit(
          {
            ok: true,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            action: "set",
            settingKey,
            keyHash: deriveSettingKeyHash(settingKey),
            cacheKey: post.cacheKey,
            receiptId: post.receiptId,
            idempotent: post.idempotent,
            http_status: post.httpStatus,
          },
          opts,
        );
        process.exit(0);
      }

      // Binding missing → write stash, emit warning to stderr.
      if (post.bindingMissing) {
        const stashPath = await writeStash(post.cacheKey, {
          written_at: Date.now(),
          settingKey,
          settingValuePointer,
          cacheKey: post.cacheKey,
          reason: "binding_missing",
          httpStatus: post.httpStatus,
          bindingMissing: post.bindingMissing,
        });
        try {
          process.stderr.write(
            `[unbrowse settings] SETTINGS_STATE binding missing on backend; stashed at ${stashPath} (cacheKey=${post.cacheKey})\n`,
          );
        } catch {
          /* stderr is best-effort */
        }
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            action: "set",
            error: "binding_missing",
            binding_missing: post.bindingMissing,
            stash_path: stashPath,
            cacheKey: post.cacheKey,
            http_status: post.httpStatus,
            hint: "Operator must provision SETTINGS_STATE via `bunx wrangler kv:namespace create SETTINGS_STATE` and re-deploy; the stash file is replayable.",
          },
          opts,
        );
        process.exit(EX_GENERIC);
      }

      emit(
        {
          ok: false,
          subcommand: "eval settings",
          op_kind: meta.op_kind,
          action: "set",
          error: post.errorHint ?? `http_${post.httpStatus}`,
          cacheKey: post.cacheKey,
          http_status: post.httpStatus,
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }

    if (unsetFlag) {
      // W24.7 — wallet-signed DELETE /v1/settings/<keyHash>.
      const reason = rejectionReasonStateless(unsetFlag, "literal:probe");
      if (reason && reason.startsWith("setting_key_")) {
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            action: "unset",
            error: reason,
            key: unsetFlag,
          },
          opts,
        );
        process.exit(EX_USAGE);
      }
      const del = await deleteSettingsStateless(unsetFlag);
      if (del.ok) {
        emit(
          {
            ok: true,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            action: "unset",
            settingKey: unsetFlag,
            keyHash: del.keyHash,
            deleted: del.deleted,
            cacheKey: del.cacheKey,
            http_status: del.httpStatus,
          },
          opts,
        );
        process.exit(0);
      }
      if (del.bindingMissing) {
        try {
          process.stderr.write(
            `[unbrowse settings] SETTINGS_STATE binding missing on backend (delete path); operator must provision.\n`,
          );
        } catch {
          /* best-effort */
        }
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            action: "unset",
            error: "binding_missing",
            binding_missing: del.bindingMissing,
            keyHash: del.keyHash,
            cacheKey: del.cacheKey,
            http_status: del.httpStatus,
          },
          opts,
        );
        process.exit(EX_GENERIC);
      }
      emit(
        {
          ok: false,
          subcommand: "eval settings",
          op_kind: meta.op_kind,
          action: "unset",
          error: del.errorCode ?? `http_${del.httpStatus}`,
          reason: del.errorReason,
          keyHash: del.keyHash,
          cacheKey: del.cacheKey,
          http_status: del.httpStatus,
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }

    // Read path — `--get <key>` OR no flags.
    if (getFlag) {
      const reason = rejectionReasonStateless(getFlag, "literal:probe");
      if (reason && reason.startsWith("setting_key_")) {
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            action: "get",
            error: reason,
            key: getFlag,
          },
          opts,
        );
        process.exit(EX_USAGE);
      }
      const got = await getSettingsStateless(getFlag);
      if (got.ok && got.row) {
        emit(
          {
            ok: true,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            action: "get",
            settingKey: getFlag,
            keyHash: got.keyHash,
            settingValuePointer: got.row.settingValuePointer,
            received_at: got.row.received_at,
            http_status: got.httpStatus,
          },
          opts,
        );
        process.exit(0);
      }
      if (got.bindingMissing) {
        try {
          process.stderr.write(
            `[unbrowse settings] SETTINGS_STATE binding missing on backend (read path); operator must provision.\n`,
          );
        } catch {
          /* best-effort */
        }
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            op_kind: meta.op_kind,
            action: "get",
            error: "binding_missing",
            binding_missing: got.bindingMissing,
            keyHash: got.keyHash,
            http_status: got.httpStatus,
          },
          opts,
        );
        process.exit(EX_GENERIC);
      }
      emit(
        {
          ok: false,
          subcommand: "eval settings",
          op_kind: meta.op_kind,
          action: "get",
          error: got.errorCode ?? `http_${got.httpStatus}`,
          reason: got.errorReason,
          keyHash: got.keyHash,
          http_status: got.httpStatus,
        },
        opts,
      );
      process.exit(got.httpStatus === 404 ? 0 : EX_GENERIC);
    }

    // No --set / --unset / --get: report hint.
    emit(
      {
        ok: true,
        subcommand: "eval settings",
        op_kind: meta.op_kind,
        pointer_prefix_regex: POINTER_PREFIX_REGEX.source,
        hint: "Use --set <key>=<pointer>, --unset <key>, or --get <key>.",
        env_names: includeEnv
          ? Object.keys(process.env)
              .filter((k) => k.startsWith("UNBROWSE_") || k === "KURI_HEADLESS" || k === "HEADLESS")
              .sort()
          : undefined,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
