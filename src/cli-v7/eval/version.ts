/**
 * `unbrowse eval version` — CLI version + build_sha + walletPubkey.
 *
 * 1:1 mapping (kind-map.ts row "eval version"):
 *   CLI subcommand  : eval version
 *   MCP tool        : unbrowse_version
 *   Covenant kind   : observe_version
 *   Verb            : eval
 *
 * Read-only identity surface. Emits the CLI version (package.json /
 * version.json), the live git short-SHA (RUNTIME_GIT_SHA), and the
 * x402 wallet PUBLIC key (32-byte hex, safe to print — Matt 6:6, the
 * private seed never leaves OS keychain / encrypted file fallback).
 *
 * Secret-redaction invariant (load-bearing — see W3 spec):
 *   - emits `walletPubkey` ONLY
 *   - NEVER emits `walletSecret`, `privateKey`, `seed`
 * The signer module's getWalletPubkey() returns a Uint8Array derived
 * fresh on each call; the seed is zeroed before return (signer.ts).
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
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  try {
    const pubkeyBytes = await getWalletPubkey();
    const walletPubkey = bytesToHex(pubkeyBytes);
    emit(
      {
        ok: true,
        subcommand: "eval version",
        covenant_kind: meta.covenant_kind,
        version: PACKAGE_VERSION,
        buildSha: RUNTIME_GIT_SHA,
        walletPubkey,
        signatureScheme: "ed25519-v7.0",
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
