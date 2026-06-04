/**
 * `unbrowse eval version` — CLI version + build_sha + walletPubkey.
 *
 * 1:1 mapping (kind-map.ts row "eval version"):
 *   CLI subcommand  : eval version
 *   MCP tool        : unbrowse_version
 *   Op kind   : eval:version
 *   Verb            : eval
 *
 * Read-only identity surface. Emits the CLI version (package.json /
 * version.json), the live git short-SHA (RUNTIME_GIT_SHA), and the
 * x402 wallet PUBLIC key (32-byte hex, safe to print — , the
 * private seed never leaves OS keychain / encrypted file fallback).
 *
 * Secret-redaction invariant (load-bearing — see W3 spec):
 *   - emits `walletPubkey` ONLY
 *   - NEVER emits `walletSecret`, `privateKey`, `seed`
 * The signer module's getWalletPubkey() returns a Uint8Array derived
 * fresh on each call; the seed is zeroed before return (signer.ts).
 *
 * W24.6 (2026-05-28): the prior env-gate around the audit emit was
 * purged — every version read emits a sig-keyed eval_read receipt.
 * Already pointer-safe — no state crossing the boundary.
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
  const meta = lookupKindMap("eval", "version")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval version",
      {
        summary:
          "CLI version + build_sha + walletPubkey (the x402 public key; safe to print).",
        usage: "unbrowse eval version [--json]",
        flags: [],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  try {
    const pubkeyBytes = await getWalletPubkey();
    const walletPubkey = bytesToHex(pubkeyBytes);

    // W24.2 — sig-keyed eval-read audit row. readKind=version is the
    // smallest possible pure identity surface; byteCount is the
    // pubkey+version envelope size. Forensic value: tracks which
    // version + which wallet asked "who am I" at time T.
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        readKind: "version" as const,
        byteCount: PACKAGE_VERSION.length + walletPubkey.length,
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
    const auditEmit = {
      ok: post.ok,
      cacheKey: post.cacheKey,
      receiptId: post.receiptId,
      httpStatus: post.httpStatus,
      bindingMissing: post.bindingMissing,
      errorHint: post.errorHint,
    };

    emit(
      {
        ok: true,
        subcommand: "eval version",
        op_kind: meta.op_kind,
        version: PACKAGE_VERSION,
        buildSha: RUNTIME_GIT_SHA,
        walletPubkey,
        signatureScheme: "ed25519-v7.0",
        audit_emit: auditEmit,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
