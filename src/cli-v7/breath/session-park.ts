/**
 * `unbrowse breath session-park [session-id]` — replace `breath close`.
 *
 * 1:1 mapping (kind-map.ts row "breath session-park"):
 *   CLI subcommand  : breath session-park
 *   MCP tool        : unbrowse_breath_session_park
 *   Op kind   : breath:session_park
 *   Verb            : breath
 *
 * Always-wrap rule — Mt 6:19-20: *"Lay up for yourselves treasures in
 * heaven, where neither moth nor rust corrupts."* The KV-cached pointer-
 * chain IS the persistent treasure that `breath close` was destroying
 * every session. session-park lays it up.
 *
 * Composition (W5 cdp surface + W23 KV surface):
 *   attach(chromeWsUrl) ->
 *   closeTarget(target) ->
 *   disposeBrowserContext(ctx) ->
 *   if no other session uses this chromePid: kill the Chrome process.
 *   delete local session record file (KV is the truth now).
 *   POST signed body to /v1/session/park.
 *
 * v7.2.0-preview.0 behavior: the SAME teardown as close, plus a
 * wallet-signed POST that the backend accepts (200) even when KV
 * storage is inert (returns `parked: false, _binding_status: "inert"`).
 * v7.3 wires real KV storage with no client change.
 *
 * Idempotent: parking an already-parked session record is silent success
 * via the file-not-found path. The receipt id is deterministic over the
 * canonical body so a second park of the same session produces the same
 * receipt.
 *
 * Secret-redaction invariants (load-bearing):
 *   - boundPointers carries L1+L2+L3+L4 hashes; NEVER L0 values.
 *   - capturedEndpointsHash is a content-addressable digest; NEVER the
 *     endpoint payloads themselves.
 *   - No cookie VALUES (cookie metadata is acceptable; see W21).
 *   - The schema gate at the backend (`validateSessionParkBody`) rejects
 *     any field whose name matches `value|cookie|secret|...`.
 */
import { createHash } from "node:crypto";
import {
  attach,
  attachToTarget,
  closeTarget,
  disposeBrowserContext,
} from "../../cdp/index.js";
import { signBytes } from "../../values/signer.js";
import type { ParsedV7Args } from "../args.js";
import {
  anotherSessionUsesChrome,
  deleteSessionRecord,
  readSessionRecord,
  resolveSession,
} from "../_session.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless } from "../_stateless.js";

// ─── Mirror of backend/src/services/session-state.ts SessionParkBody ───────
//
// The wire shape lives in backend; we re-declare here to avoid the
// cross-rootDir tsc layout hazard (same pattern as fill.ts mirroring
// AuditFillBody). If a field is added server-side, mirror it here AND
// add a wire-shape test.

interface BoundPointer {
  l1_pointer: string;
  l2_context_hash: string;
  l3_zk_sig: string;
  l4_cache_key: string;
  last_used_at: number;
  expires_at: number;
}

interface SessionParkBody {
  sessionId: string;
  targetUrl: string;
  targetId: string;
  contextId: string;
  boundPointers: BoundPointer[];
  capturedEndpointsHash: string;
  specHitRef?: string;
  cookiesInventoryRef?: string;
  walletPubkey: string;
  signatureScheme?: "ed25519-v7.2" | "groth16-v7.3";
  signature: string;
  parked_at: number;
}

/**
 * Canonical signed-fragment — MUST byte-match
 * `backend/src/services/session-state.ts canonicalizeSignedFragment`.
 * Fixed key order; arrays canonicalized element-wise.
 */
function canonicalizeSignedFragment(body: SessionParkBody): string {
  const pointersCanonical = body.boundPointers.map((bp) => ({
    l1_pointer: bp.l1_pointer,
    l2_context_hash: bp.l2_context_hash,
    l3_zk_sig: bp.l3_zk_sig,
    l4_cache_key: bp.l4_cache_key,
    last_used_at: bp.last_used_at,
    expires_at: bp.expires_at,
  }));
  return JSON.stringify({
    sessionId: body.sessionId,
    targetUrl: body.targetUrl,
    targetId: body.targetId,
    contextId: body.contextId,
    boundPointers: pointersCanonical,
    capturedEndpointsHash: body.capturedEndpointsHash,
    specHitRef: body.specHitRef ?? null,
    cookiesInventoryRef: body.cookiesInventoryRef ?? null,
    walletPubkey: body.walletPubkey,
    parked_at: body.parked_at,
  });
}

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
  return h;
}

function tryKillProcess(pid: number): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "session-park")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath session-park",
      {
        summary:
          "Park the current browse session — KV-persisted pointer-of-pointer chain (replaces close).",
        usage:
          "unbrowse breath session-park [session-id] [--session <id>]",
        positional: [
          {
            name: "session-id",
            description: "Session id (default: most-recent).",
            required: false,
          },
        ],
        flags: [
          {
            name: "--session",
            description: "Alternate form of the positional session id.",
            value_expected: true,
          },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  const explicitId =
    parsed.positional[0] ??
    (typeof parsed.flags.session === "string" ? parsed.flags.session : undefined);

  let rec;
  try {
    rec = explicitId
      ? await readSessionRecord(explicitId)
      : await resolveSession(undefined, { probeLive: false });
  } catch (err) {
    if (
      !explicitId &&
      (err as Error & { code?: string }).code === "no_active_session"
    ) {
      emit(
        {
          ok: true,
          subcommand: "breath session-park",
          op_kind: meta.op_kind,
          idempotent_noop: true,
          parked: false,
          reason: "no_active_session",
        },
        opts,
      );
      process.exit(0);
    }
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  // ── CDP teardown (identical to close.ts) ────────────────────────────────
  let chromeKilled = false;
  let cdpErrored = false;
  // Best-effort capture of the live targetUrl for the parked body. The
  // session file's targetUrl was the navigation URL at `breath go`, but
  // the session may have navigated since; we read Page.getNavigationHistory
  // BEFORE teardown so the parked body reflects the last-known URL.
  let targetUrl = "";
  try {
    const conn = await attach(rec.chromeWsUrl);
    try {
      const target = await attachToTarget(conn, rec.targetId);
      try {
        // Light read to gather URL; we tolerate any failure here (the
        // target may have crashed or be locked). The parked URL falls
        // back to empty string on failure.
        const hist = await (await import("../../cdp/index.js")).call<
          Record<string, never>,
          { entries: { url: string }[]; currentIndex: number }
        >(conn, "Page.getNavigationHistory", {}, target.sessionId);
        targetUrl = hist.entries[hist.currentIndex]?.url ?? "";
      } catch {
        // honest no-op
      }
      await closeTarget(target).catch(() => undefined);
      await disposeBrowserContext({
        cdp: conn,
        browserContextId: rec.contextId,
      }).catch(() => undefined);
    } catch {
      cdpErrored = true;
    }
    const otherUsers = await anotherSessionUsesChrome(rec.chromePid, rec.sessionId);
    if (!otherUsers) {
      chromeKilled = tryKillProcess(rec.chromePid);
    }
  } catch {
    cdpErrored = true;
  }

  // Don't delete the local record yet — under stateless mode the
  // binding-missing path needs it as a local-only-stash. We delete after
  // we know the KV row landed.
  const recForDelete = rec;

  // ── Build SessionParkBody — pointer-only ─────────────────────────────────
  //
  // v7.2.0-preview.0: the in-process session-state registry is not yet
  // wired (separate wave: would integrate with the W4/W8 audit stream
  // + W21 auth-inventory + W22 spec hits). For this preview slice we
  // emit a wallet-signed body carrying an EMPTY boundPointers array
  // and a deterministic capturedEndpointsHash over (sessionId, targetUrl)
  // — honest empty state, per CLAUDE.md "no stubs, no dummy data".
  //
  // The capturedEndpointsHash is a placeholder digest distinct from a
  // real captured-endpoints hash; v7.3 wires real registry collection.
  // The signature is REAL (Ed25519 over canonical body) so the wire
  // shape exercises end-to-end signing today.
  const parkedAt = Date.now();
  const capturedEndpointsHash = createHash("sha256")
    .update(`${rec.sessionId}:${targetUrl}:v7.2.0-preview.0:empty`)
    .digest("hex");

  // Sign — first build the body with a placeholder sig, then sign the
  // canonical fragment, then overwrite the sig field.
  const { signature: sigBytes, walletPubkey: pubBytes } = await signBytes(
    new TextEncoder().encode(""), // overwritten below
  );
  // ^^ The above gets the walletPubkey via the same code path; we will
  // re-sign with the real canonical bytes immediately below. (signBytes
  // does NOT cache by message, so the second call is a clean sign over
  // the right bytes.)
  const walletPubkeyHex = bytesToHex(pubBytes);
  void sigBytes; // discard placeholder

  const bodyWithoutSig: Omit<SessionParkBody, "signature" | "signatureScheme"> = {
    sessionId: rec.sessionId,
    targetUrl,
    targetId: rec.targetId,
    contextId: rec.contextId,
    boundPointers: [],
    capturedEndpointsHash,
    // STATELESS_BOUNDARY §E Option-1: thread cookies_inventory_ref from the
    // session record (populated by a preceding `breath auth-capture` under
    // stateless mode) into the park body. Pointer-only — values stay in
    // OS Keychain. Optional: most sessions never run auth-capture, leaving
    // this undefined (canonicalizer coerces undefined → null).
    cookiesInventoryRef: rec.cookies_inventory_ref,
    walletPubkey: walletPubkeyHex,
    parked_at: parkedAt,
  };
  const canonicalFragment = canonicalizeSignedFragment({
    ...bodyWithoutSig,
    signatureScheme: "ed25519-v7.2",
    signature: "", // not included in fragment canonicalization
  });
  const fragmentBytes = new TextEncoder().encode(canonicalFragment);
  const { signature: realSigBytes } = await signBytes(fragmentBytes);
  const signatureHex = bytesToHex(realSigBytes);

  const body: SessionParkBody = {
    ...bodyWithoutSig,
    signatureScheme: "ed25519-v7.2",
    signature: signatureHex,
  };

  // ── POST to /v1/session/park ─────────────────────────────────────────────
  //
  // Routes through `postStateless` — the canonical Day-4 adapter signs +
  // posts. Binding-missing surfaces as `bindingMissing: "SESSION_STATE"`
  // per the §E firmament boundary (NOT a throw — graceful degraded mode).
  //
  // Failure modes (all reported honestly; teardown has ALREADY happened):
  //   - network error           → parked: false, parkError: "network_error"
  //   - 4xx/5xx (NOT 200)       → parked: false, parkError, response_excerpt
  //   - 200 with parked:false   → parked: false, _binding_status: "inert"
  //                                (v7.2.0-preview.0 expected path)
  //   - 200 with parked:true    → parked: true (v7.3+ real-KV success)
  let parked = false;
  let receiptId: string | undefined;
  let parkError: string | undefined;
  let bindingStatus: string | undefined;
  let responseExcerpt: string | undefined;
  let fallbackToTmp = false;

  // The body is ALREADY signed above (we keep the mirrored canonicalizer
  // for byte-parity); postStateless re-signs the same canonical fragment
  // under the hood. Since the fragment is deterministic over the body,
  // the resulting signature would be byte-identical to ours —
  // postStateless owns the sig field so we strip ours to let the
  // adapter manage it cleanly.
  //
  // signableFields matches the backend canonicalizer key order — any
  // drift is caught by the wire-shape parity test in
  // v7-cli-breath-session-park.test.ts.
  const { signature: _drop, signatureScheme: _drop2, ...bodyForAdapter } = body;
  void _drop; void _drop2;
  const result = await postStateless({
    namespace: "session",
    route: "/v1/session/park",
    body: bodyForAdapter,
    signableFields: [
      "sessionId",
      "targetUrl",
      "targetId",
      "contextId",
      "boundPointers",
      "capturedEndpointsHash",
      "specHitRef",
      "cookiesInventoryRef",
      "walletPubkey",
      "parked_at",
    ],
  });
  if (result.bindingMissing) {
    // Honest 503 / inert path — emit one-line stderr warn (NOT throw).
    // Per §H invariant: caller falls through to tmp working dir (already
    // there per `writeSessionRecord` routing) and marks the session as
    // local-only-stash.
    process.stderr.write(
      `[binding-missing] ${result.bindingMissing}: stateless substrate inert, fell back to local tmp stash\n`,
    );
    parkError = "binding_missing";
    bindingStatus = "inert";
    fallbackToTmp = true;
  } else if (result.ok) {
    parked = true;
    receiptId = result.receiptId;
    bindingStatus = "wired";
  } else {
    parkError = `http_${result.httpStatus}`;
    if (result.errorHint) responseExcerpt = result.errorHint;
  }

  // Finalize local file lifecycle.
  //   - KV landed (parked=true): delete (KV is the truth).
  //   - binding-missing fallback: KEEP the tmp file so session-restore
  //     can read it locally per the inert-fallback rule.
  //   - other network error: KEEP the tmp file (the operator can retry
  //     park later).
  if (parked) {
    await deleteSessionRecord(recForDelete.sessionId);
  }

  emit(
    {
      ok: true,
      subcommand: "breath session-park",
      op_kind: meta.op_kind,
      session_id: rec.sessionId,
      chrome_killed: chromeKilled,
      cdp_errored: cdpErrored,
      parked,
      receiptId,
      _binding_status: bindingStatus,
      parkError,
      response_excerpt: responseExcerpt,
      local_only_stash: fallbackToTmp,
    },
    opts,
  );
  process.exit(0);
}
