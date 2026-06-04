/**
 * `unbrowse eval status` — current sessions + walletPubkey + version.
 *
 * 1:1 mapping (kind-map.ts row "eval status"):
 *   CLI subcommand  : eval status
 *   MCP tool        : unbrowse_health
 *   Op kind   : eval:status
 *   Verb            : eval
 *
 * Composes `listSessions()` (from ./sessions.ts) with the version + wallet
 * identity surface. Read-only. Returns even with zero active sessions (the
 * JSON shape is stable so agents can pattern-match `sessions.length === 0`
 * vs error).
 *
 * platform surfaces (W24.6 — stateless is the sole path):
 *   - `sessions` is sourced the same way as `eval sessions` — via
 *     `listSessions()` which walks `~/.unbrowse/tmp/<sigHash>/*.json`.
 *     The canonical wallet-listed KV view (`GET /v1/session/
 *     list-by-wallet`) does NOT yet exist (v7.3 follow-up); the
 *     listing gap is surfaced as `_stateless_listing_gap` so the
 *     caller knows the count is local-tmp.
 *   - `chromeProcesses` is local process inspection — process PID
 *     reachability is intrinsically a host-local query.
 *   - `walletPubkey` is local signer output.
 *
 * Secret-redaction invariant: emits `walletPubkey` ONLY, never the seed.
 */
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { PACKAGE_VERSION, RUNTIME_GIT_SHA } from "../../version.js";
import { getWalletPubkey } from "../../values/signer.js";
import { listSessions } from "./sessions.js";
import { postStateless } from "../_stateless.js";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function handler(
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<void> {
  const meta = lookupKindMap("eval", "status")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval status",
      {
        summary:
          "Current sessions + chrome liveness + walletPubkey + version.",
        usage: "unbrowse eval status [--session <id>]",
        flags: [
          {
            name: "--session",
            description: "Restrict to a single session id.",
            value_expected: true,
          },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  try {
    const rows = await listSessions();
    const filter =
      typeof parsed.flags.session === "string"
        ? parsed.flags.session
        : undefined;
    const sessions = filter
      ? rows.filter((r) => r.sessionId === filter)
      : rows;
    // Distinct chrome pids alive — multiple sessions may share one Chrome.
    // Process-PID liveness is intrinsically a host-local query, so this
    // count stays local even under stateless mode.
    const chromeProcesses = new Set(
      sessions.filter((r) => r.alive).map((r) => r.chromePid),
    ).size;

    const pubkeyBytes = await getWalletPubkey();
    const walletPubkey = bytesToHex(pubkeyBytes);

    const envelope: Record<string, unknown> = {
      ok: true,
      subcommand: "eval status",
      op_kind: meta.op_kind,
      version: PACKAGE_VERSION,
      buildSha: RUNTIME_GIT_SHA,
      walletPubkey,
      signatureScheme: "ed25519-v7.0",
      chromeProcesses,
      sessions: sessions.map((r) => ({
        id: r.sessionId,
        createdAt: r.createdAt,
        chromePid: r.chromePid,
        targetAlive: r.alive,
      })),
      // Same gap envelope as eval/sessions.ts — keeps the agent's model
      // consistent across the two surfaces.
      _stateless_listing_gap: {
        endpoint: "/v1/session/list-by-wallet",
        status: "not_yet_implemented",
        wave_hint:
          "v7.2.0-preview.0 only ships /v1/session/{park,restore/:id}. " +
          "Session count reflects local-tmp bridge records only; " +
          "wallet-scoped KV enumeration ships in v7.3.",
        local_tmp_scan: true,
      },
    };

    // W24.2 — sig-keyed eval-read audit row. readKind=status is a
    // composed identity+sessions read; no Chrome tab dependency.
    // byteCount is the envelope size at emit time.
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        readKind: "status" as const,
        byteCount: JSON.stringify(envelope).length,
      },
      signableFields: [
        "sessionId",
        "urlHash",
        "readKind",
        "byteCount",
        "selectorHash",
        "nonce",
      ],
    });
    envelope.audit_emit = {
      ok: post.ok,
      cacheKey: post.cacheKey,
      receiptId: post.receiptId,
      httpStatus: post.httpStatus,
      bindingMissing: post.bindingMissing,
      errorHint: post.errorHint,
    };

    emit(envelope, opts);
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
