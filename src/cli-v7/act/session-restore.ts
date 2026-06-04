/**
 * `unbrowse act session-restore <session-id>` — restore a parked session.
 *
 * 1:1 mapping (kind-map.ts row "act session-restore"):
 *   CLI subcommand  : act session-restore
 *   MCP tool        : unbrowse_session_restore
 *   Op kind   : act:session_restore
 *   Verb            : act
 *
 * Always-wrap rule — Mt 6:19-20: the KV-cached pointer-chain laid up by
 * session-park is reached here through the owning wallet — the only key
 * that opens this storehouse. The KV row is wallet-prefixed; cross-
 * wallet enumeration is structurally impossible.
 *
 * Flow:
 *   1. Sign challenge: Ed25519 over `<sessionId> || ":" || timestamp`.
 *   2. GET /v1/session/restore/:id with WalletSig + X-Wallet-Pubkey +
 *      X-Wallet-Timestamp headers.
 *   3. 200 + row → spawn or attach Chrome, create context+target at the
 *      stored targetUrl, write a fresh local session record. Best-effort
 *      attach to the old chromeWsUrl via probeExistingCdp before falling
 *      back to spawnChrome.
 *   4. 404 → session_not_found (either parked under a different wallet
 *      and unreadable to this signer, or never existed).
 *   5. 503 → session_state_binding_inert (v7.2.0-preview.0 expected
 *      path until v7.3 provisions the namespace).
 *
 * v7.2.0-preview.0 behavior: the inert KV path (503) is the EXPECTED
 * shape because storage is not yet wired. The CLI surfaces it honestly
 * and EXITS WITHOUT spawning Chrome — there is nothing to restore.
 * v7.3 wave wires real KV and this code path produces a live restore.
 */
import {
  attach,
  createBrowserContext,
  createTarget,
  probeExistingCdp,
  spawnChrome,
} from "../../cdp/index.js";
import { signBytes } from "../../values/signer.js";
import type { ParsedV7Args } from "../args.js";
import {
  readSessionRecord,
  writeSessionRecord,
  type BrowseSessionRecord,
} from "../_session.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { emitBreathActStateless } from "../_act-audit.js";

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
  return h;
}

function getBackendUrl(): string {
  return (
    process.env.UNBROWSE_BACKEND_URL ||
    process.env.UNBROWSE_API_URL ||
    "https://beta-api.unbrowse.ai"
  );
}

interface RestoredRow {
  sessionId: string;
  targetUrl: string;
  targetId: string;
  contextId: string;
  boundPointers: unknown[];
  capturedEndpointsHash: string;
  specHitRef?: string;
  cookiesInventoryRef?: string;
  walletPubkey: string;
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("act", "session-restore")!;

  if (parsed.wantsHelp) {
    helpExit(
      "act session-restore",
      {
        summary:
          "Restore a previously parked session — KV read, wallet-signed challenge, rebuild local session record.",
        usage:
          "unbrowse act session-restore <session-id> [--ws <existing-chrome-ws>]",
        positional: [
          {
            name: "session-id",
            description: "Session id to restore (from a prior session-park).",
            required: true,
          },
        ],
        flags: [
          {
            name: "--ws",
            description:
              "Attach to an existing Chrome at this ws:// endpoint rather than spawning a fresh browser.",
            value_expected: true,
          },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "act",
      },
      opts,
    );
  }

  const sessionId = parsed.positional[0];
  if (!sessionId) {
    emit(
      {
        error: "missing_positional",
        subcommand: "act session-restore",
        required: ["session-id"],
        op_kind: meta.op_kind,
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  // ── Build + sign challenge ──────────────────────────────────────────────
  const timestampMs = Date.now();
  const message = new TextEncoder().encode(`${sessionId}:${timestampMs}`);
  const { signature: sigBytes, walletPubkey: pubBytes } = await signBytes(message);
  const sigHex = bytesToHex(sigBytes);
  const pubHex = bytesToHex(pubBytes);

  // ── GET /v1/session/restore/:id ─────────────────────────────────────────
  let row: RestoredRow | undefined;
  let bindingStatus: string | undefined;
  let restoreError: string | undefined;
  let httpStatus = 0;
  try {
    const res = await fetch(
      `${getBackendUrl()}/v1/session/restore/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `WalletSig ${sigHex}`,
          "X-Wallet-Pubkey": pubHex,
          "X-Wallet-Timestamp": String(timestampMs),
        },
      },
    );
    httpStatus = res.status;
    if (res.status === 200) {
      const ack = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        row?: RestoredRow;
        _binding_status?: string;
      };
      row = ack.row;
      bindingStatus = ack._binding_status;
    } else if (res.status === 503) {
      // v7.2.0-preview.0 expected: SESSION_STATE binding inert.
      restoreError = "session_state_binding_inert";
      bindingStatus = "inert";
      // Inert-fallback: try the local-only stash that session-park
      // left behind under ~/.unbrowse/tmp/<sigHash>/. Surface a stderr
      // note that the row is coming from the local stash, not the KV
      // platform.
      try {
        const localRec = await readSessionRecord(sessionId);
        process.stderr.write(
          `[binding-missing] SESSION_STATE: serving local-only-stash for ${sessionId}\n`,
        );
        row = {
          sessionId: localRec.sessionId,
          targetUrl: "",
          targetId: localRec.targetId,
          contextId: localRec.contextId,
          boundPointers: [],
          capturedEndpointsHash: "",
          cookiesInventoryRef: localRec.cookies_inventory_ref,
          walletPubkey: "",
        };
        bindingStatus = "local-only-stash";
        restoreError = undefined;
      } catch {
        // No local stash either — fall through to honest no-op below.
      }
    } else if (res.status === 404) {
      restoreError = "session_not_found";
    } else if (res.status === 401) {
      restoreError = "unauthorized";
    } else if (res.status === 403) {
      restoreError = "wallet_mismatch";
    } else {
      restoreError = `http_${res.status}`;
    }
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  if (!row) {
    // Honest no-op: report and exit. No Chrome spawn happens because
    // there is nothing to restore. v7.2.0-preview.0 expected exit
    // path until v7.3 wires real storage.
    emit(
      {
        ok: false,
        subcommand: "act session-restore",
        op_kind: meta.op_kind,
        session_id: sessionId,
        restored: false,
        restoreError,
        http_status: httpStatus,
        _binding_status: bindingStatus,
      },
      opts,
    );
    process.exit(0);
  }

  // ── Rebuild Chrome + local session record ───────────────────────────────
  //
  // Best-effort: try to attach to a user-supplied --ws first (lets the
  // agent reuse a long-lived Chrome). Otherwise spawn fresh. The target
  // is re-created at the stored targetUrl; the original targetId is
  // documented as stale and a fresh one is minted.
  let restored = false;
  let chromeWsUrl = "";
  let newTargetId = "";
  let newContextId = "";
  try {
    const wsHint = typeof parsed.flags.ws === "string" ? parsed.flags.ws : undefined;
    const aliveWs =
      wsHint && (await probeExistingCdp(wsHint).catch(() => false)) ? wsHint : undefined;
    const conn = aliveWs
      ? await attach(aliveWs)
      : await spawnChrome({ headless: true, perContextProxy: true });
    const ctx = await createBrowserContext(conn);
    const target = await createTarget(conn, row.targetUrl, {
      browserContextId: ctx.browserContextId,
    });
    chromeWsUrl = conn.endpoint;
    newTargetId = target.targetId;
    newContextId = ctx.browserContextId;

    // The restored sessionId is preserved so the agent's existing
    // references stay valid — this is the WHOLE POINT of session-park
    // / session-restore (no rebrowse round-trip).
    const rec: BrowseSessionRecord = {
      sessionId: row.sessionId,
      contextId: newContextId,
      targetId: newTargetId,
      chromeWsUrl,
      chromePid: conn.pid,
      createdAt: Date.now(),
    };
    await writeSessionRecord(rec);
    restored = true;
  } catch (err) {
    emit(
      {
        ok: false,
        subcommand: "act session-restore",
        op_kind: meta.op_kind,
        session_id: sessionId,
        restored: false,
        restoreError: `chrome_restore_failed: ${(err as Error).message ?? String(err)}`,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  // W24.2 — emit a sig-keyed `session-restore` act-act receipt.
  // The restored sessionId is preserved (whole point of park/restore),
  // so the witness id binds to the agent's existing identifier. The
  // restored targetUrl flows through urlHash; selector overload: pass
  // the capturedEndpointsHash (already a hex string) which the helper
  // sha256-hashes again — a stable forensic fingerprint of "which
  // session shape was restored" without revealing the captured payload.
  const restoreAudit = await emitBreathActStateless({
    sessionId: row.sessionId,
    actType: "session-restore",
    selector: row.capturedEndpointsHash || null,
    currentUrl: row.targetUrl,
  });

  emit(
    {
      ok: true,
      subcommand: "act session-restore",
      op_kind: meta.op_kind,
      session_id: sessionId,
      target_id: newTargetId,
      context_id: newContextId,
      chrome_ws_url: chromeWsUrl,
      restored,
      boundPointersCount: Array.isArray(row.boundPointers) ? row.boundPointers.length : 0,
      capturedEndpointsHash: row.capturedEndpointsHash,
      _binding_status: bindingStatus,
      audit: {
        ok: restoreAudit.ok,
        idempotent: restoreAudit.idempotent,
        binding_missing: restoreAudit.bindingMissing,
        receipt_id: restoreAudit.receiptId,
        cache_key: restoreAudit.cacheKey,
        variant: "act-act",
        act_type: "session-restore",
      },
    },
    opts,
  );
  process.exit(0);
}
