/**
 * `unbrowse eval status` — current sessions + walletPubkey + version.
 *
 * 1:1 mapping (kind-map.ts row "eval status"):
 *   CLI subcommand  : eval status
 *   MCP tool        : unbrowse_health
 *   Covenant kind   : observe_status
 *   Verb            : eval
 *
 * Composes `listSessions()` (from ./sessions.ts) with the
 * version + wallet identity surface. Read-only. Returns even with zero
 * active sessions (the JSON shape is stable so agents can pattern-match
 * `sessions.length === 0` vs error).
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
        covenant_kind: meta.covenant_kind,
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
    const chromeProcesses = new Set(
      sessions.filter((r) => r.alive).map((r) => r.chromePid),
    ).size;

    const pubkeyBytes = await getWalletPubkey();
    const walletPubkey = bytesToHex(pubkeyBytes);

    emit(
      {
        ok: true,
        subcommand: "eval status",
        covenant_kind: meta.covenant_kind,
        version: PACKAGE_VERSION,
        buildSha: RUNTIME_GIT_SHA,
        walletPubkey,
        chromeProcesses,
        sessions: sessions.map((r) => ({
          id: r.sessionId,
          createdAt: r.createdAt,
          chromePid: r.chromePid,
          targetAlive: r.alive,
        })),
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
