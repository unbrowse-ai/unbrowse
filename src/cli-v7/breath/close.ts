/**
 * `unbrowse breath close [session-id]` — close one browse session.
 *
 * 1:1 mapping (kind-map.ts row "breath close"):
 *   CLI subcommand  : breath close
 *   MCP tool        : unbrowse_close
 *   Op kind   : breath:close
 *   Verb            : breath
 *
 * Composition (W5 cdp surface):
 *   attach(chromeWsUrl) ->
 *   closeTarget(target) ->
 *   disposeBrowserContext(ctx) ->
 *   if no other session uses this chromePid: kill the Chrome process.
 *   delete session record file.
 *
 * Idempotent: closing an already-deleted session record is silent success
 * (the file-not-found path), but missing-on-disk + no-process-found is
 * surfaced as a `no_active_session` error envelope when the agent supplied
 * an explicit id.
 */
import {
  attach,
  attachToTarget,
  closeTarget,
  disposeBrowserContext,
} from "../../cdp/index.js";
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
import { emitBreathActStateless } from "../_breath-audit.js";

function tryKillProcess(pid: number): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * v7.2.0-preview.0 deprecation notice (W23, 2026-05-28).
 *
 * Per `feedback_close_is_antipattern_persistent_session.md` — `breath close`
 * destroys the pointer-of-pointer chain that the user paid the browser-open
 * cost to acquire. Replacement: `breath session-park` (KV-persisted,
 * wallet-gated). v7.2 keeps close working with a stderr notice; v7.3 makes
 * it an alias; v8 removes it.
 *
 * Mt 6:19-20 — *"Lay up not for yourselves treasures upon earth, where
 * moth and rust corrupt... but lay up for yourselves treasures in heaven."*
 * close destroys the treasure; session-park lays it up.
 */
const DEPRECATION_NOTICE =
  "[deprecation] unbrowse breath close is being replaced by session-park (KV-persisted). v7.3 removes the close alias. Use 'unbrowse breath session-park' for forward-compat.";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "close")!;

  // Stderr one-liner (NOT stdout — agents parsing stdout JSON are
  // unaffected). Fires on every non-help invocation.
  if (!parsed.wantsHelp) {
    process.stderr.write(DEPRECATION_NOTICE + "\n");
  }

  if (parsed.wantsHelp) {
    helpExit(
      "breath close",
      {
        summary: "Close the current browse session; drain capture pipeline.",
        usage: "unbrowse breath close [session-id] [--session <id>]",
        positional: [
          { name: "session-id", description: "Session id (default: most-recent).", required: false },
        ],
        flags: [
          { name: "--session", description: "Alternate form of the positional session id.", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  const explicitId = parsed.positional[0]
    ?? (typeof parsed.flags.session === "string" ? parsed.flags.session : undefined);

  let rec;
  try {
    rec = explicitId
      ? await readSessionRecord(explicitId)
      : await resolveSession(undefined, { probeLive: false });
  } catch (err) {
    // Explicit id miss is the load-bearing failure; no-active-session is
    // idempotent-ok for the no-arg form.
    if (!explicitId && (err as Error & { code?: string }).code === "no_active_session") {
      emit(
        { ok: true, subcommand: "breath close", op_kind: meta.op_kind, idempotent_noop: true },
        opts,
      );
      process.exit(0);
    }
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  let chromeKilled = false;
  let cdpErrored = false;
  try {
    const conn = await attach(rec.chromeWsUrl);
    try {
      const target = await attachToTarget(conn, rec.targetId);
      await closeTarget(target).catch(() => undefined);
      await disposeBrowserContext({
        cdp: conn,
        browserContextId: rec.contextId,
      }).catch(() => undefined);
    } catch {
      cdpErrored = true;
    }
    // Decide whether to SIGTERM Chrome. Only if no other session record
    // still claims this pid.
    const otherUsers = await anotherSessionUsesChrome(rec.chromePid, rec.sessionId);
    if (!otherUsers) {
      chromeKilled = tryKillProcess(rec.chromePid);
    }
  } catch {
    cdpErrored = true;
  }

  await deleteSessionRecord(rec.sessionId);

  // W24.2 — emit a sig-keyed `teardown` breath-act receipt.
  // Pre-deletion URL is unknown (chrome may already be dead); leave
  // currentUrl empty so urlHash stays absent.
  const teardownAudit = await emitBreathActStateless({
    sessionId: rec.sessionId,
    actType: "teardown",
    selector: null,
    currentUrl: "",
  });

  emit(
    {
      ok: true,
      subcommand: "breath close",
      op_kind: meta.op_kind,
      session_id: rec.sessionId,
      chrome_killed: chromeKilled,
      cdp_errored: cdpErrored,
      audit: {
        ok: teardownAudit.ok,
        idempotent: teardownAudit.idempotent,
        binding_missing: teardownAudit.bindingMissing,
        receipt_id: teardownAudit.receiptId,
        cache_key: teardownAudit.cacheKey,
        variant: "breath-act",
        act_type: "teardown",
      },
    },
    opts,
  );
  process.exit(0);
}
