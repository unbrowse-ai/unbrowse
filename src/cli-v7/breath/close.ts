/**
 * `unbrowse breath close [session-id]` — close one browse session.
 *
 * 1:1 mapping (kind-map.ts row "breath close"):
 *   CLI subcommand  : breath close
 *   MCP tool        : unbrowse_close
 *   Covenant kind   : actuate_close
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
  const meta = lookupKindMap("breath", "close")!;

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
        covenant_kind: meta.covenant_kind,
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
      : await resolveSession(undefined);
  } catch (err) {
    // Explicit id miss is the load-bearing failure; no-active-session is
    // idempotent-ok for the no-arg form.
    if (!explicitId && (err as Error & { code?: string }).code === "no_active_session") {
      emit(
        { ok: true, subcommand: "breath close", covenant_kind: meta.covenant_kind, idempotent_noop: true },
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

  emit(
    {
      ok: true,
      subcommand: "breath close",
      covenant_kind: meta.covenant_kind,
      session_id: rec.sessionId,
      chrome_killed: chromeKilled,
      cdp_errored: cdpErrored,
    },
    opts,
  );
  process.exit(0);
}
