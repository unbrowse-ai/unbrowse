/**
 * `unbrowse act go <url>` — navigate.
 *
 * 1:1 mapping (kind-map.ts row "act go"):
 *   CLI subcommand  : act go
 *   MCP tool        : unbrowse_go
 *   Op kind   : act:navigate
 *   Verb            : act
 *
 * Composition (W5 cdp surface):
 *   spawnChrome ->                                 // ensure browser
 *   createBrowserContext(conn) ->                  // fresh cookie jar
 *   createTarget(conn, url, { browserContextId }) ->  // new tab attached
 *   (sessionId is on the Target; Page.navigate already fired by createTarget
 *    in the W5 contract).
 *
 * Persists a pointer-only record under ~/.unbrowse/sessions/<id>.json so a
 * subsequent `act fill` / `eval snap` / `act close` can re-attach
 * across stateless CLI invocations.
 *
 * Secret-redaction: this handler does NOT touch values. Stdout carries the
 * sessionId and (in --json mode) the pointer fields only.
 */
import { randomUUID } from "node:crypto";

import {
  attach,
  createBrowserContext,
  createTarget,
  spawnChrome,
} from "../../cdp/index.js";
import type { ParsedV7Args } from "../args.js";
import {
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

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("act", "go")!; // safe — kind-map invariant

  if (parsed.wantsHelp) {
    helpExit(
      "act go",
      {
        summary: "Navigate the current session to a URL.",
        usage: "unbrowse act go <url> [--session <id>] [--proxy <url>] [--timeout <ms>]",
        positional: [
          { name: "url", description: "Absolute URL (http://, https://).", required: true },
        ],
        flags: [
          { name: "--proxy", description: "Override proxy for this navigation.", value_expected: true },
          { name: "--timeout", description: "Wall-clock timeout in ms (default: 30000).", value_expected: true },
          { name: "--ws", description: "Attach to existing Chrome at this ws:// endpoint.", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "act",
      },
      opts,
    );
  }

  const url = parsed.positional[0];
  if (!url) {
    emit(
      {
        error: "missing_positional",
        subcommand: "act go",
        required: ["url"],
        got: parsed.positional,
        op_kind: meta.op_kind,
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  try {
    // W5 surface: attach to a user-supplied ws endpoint or spawn a fresh
    // browser. The CDPConnection carries chromeBin/pid/endpoint as pointer
    // fields we persist below.
    const wsEndpoint = typeof parsed.flags.ws === "string" ? parsed.flags.ws : undefined;
    const conn = wsEndpoint
      ? await attach(wsEndpoint)
      : await spawnChrome({ headless: true, perContextProxy: true });

    const ctx = await createBrowserContext(conn);
    const target = await createTarget(conn, url, { browserContextId: ctx.browserContextId });

    const sessionId = randomUUID();
    const rec: BrowseSessionRecord = {
      sessionId,
      contextId: ctx.browserContextId,
      targetId: target.targetId,
      chromeWsUrl: conn.endpoint,
      chromePid: conn.pid,
      createdAt: Date.now(),
    };
    await writeSessionRecord(rec);

    // W24.2 — emit a sig-keyed `navigate` act-act receipt. Selector
    // is undefined (navigation has no DOM target); the URL flows through
    // urlHash inside the helper. Best-effort: binding-missing surfaces
    // in the envelope, never blocks the navigation.
    const navAudit = await emitBreathActStateless({
      sessionId,
      actType: "navigate",
      selector: null,
      currentUrl: url,
    });

    emit(
      {
        ok: true,
        subcommand: "act go",
        op_kind: meta.op_kind,
        session_id: sessionId,
        target_id: target.targetId,
        context_id: ctx.browserContextId,
        chrome_ws_url: conn.endpoint,
        url,
        audit: {
          ok: navAudit.ok,
          idempotent: navAudit.idempotent,
          binding_missing: navAudit.bindingMissing,
          receipt_id: navAudit.receiptId,
          cache_key: navAudit.cacheKey,
          variant: "act-act",
          act_type: "navigate",
        },
      },
      opts,
    );
    // Intentionally do NOT close the connection — Chrome stays alive for
    // subsequent CLI invocations to re-attach via chromeWsUrl.
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
