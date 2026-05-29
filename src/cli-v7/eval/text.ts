/**
 * `unbrowse eval text [selector]` — selector-scoped innerText or full body text.
 *
 * 1:1 mapping (kind-map.ts row "eval text"):
 *   CLI subcommand  : eval text
 *   MCP tool        : unbrowse_text
 *   Op kind   : eval:text
 *   Verb            : eval
 *
 * Composition: attach to the persisted session via chromeWsUrl, run a single
 * Runtime.evaluate that resolves `document.querySelector(selector).innerText`
 * server-side (selector is JSON-encoded into the expression so users can't
 * break out of the string). With no selector, falls back to
 * `document.body.innerText`. Returns plain text (no markdown, no HTML).
 *
 * Read-only — no audit POST.
 */
import { createHash } from "node:crypto";

import { attach, attachToTarget, call } from "../../cdp/index.js";
import type { RuntimeEvaluateResult } from "../../cdp/types.js";
import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless } from "../_stateless.js";

function urlHash32(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function selectorHashHex(selector: string): string {
  return createHash("sha256").update(selector).digest("hex");
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "text")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval text",
      {
        summary: "Stripped page text or selector-scoped innerText.",
        usage: "unbrowse eval text [selector] [--session <id>]",
        positional: [
          { name: "selector", description: "CSS selector (default: document.body).", required: false },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const selector = parsed.positional[0] ?? "";

  try {
    const rec = await resolveSession(sessionFlag);
    const conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);

    // JSON.stringify the selector so it survives interpolation safely.
    // No-selector path returns body.innerText (the canonical full-text view).
    const expression = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText ?? el.textContent ?? "") : null; })()`
      : `document.body ? (document.body.innerText ?? document.body.textContent ?? "") : ""`;

    const evalResult = await call<
      { expression: string; returnByValue: boolean },
      RuntimeEvaluateResult
    >(
      conn,
      "Runtime.evaluate",
      { expression, returnByValue: true },
      target.sessionId,
    );

    const value = evalResult.result?.value;
    const text = typeof value === "string" ? value : "";
    const found = value !== null;

    // A2 — sig-keyed audit row. The text bytes go to stdout as before;
    // the wire carries metadata only (urlHash, byteCount, selectorHash
    // when selector-scoped). Selector string never leaves the CLI; only
    // its sha256-hex does. Best-effort emit.
    let currentUrl = "";
    try {
      const r = await call<{ expression: string; returnByValue: boolean }, RuntimeEvaluateResult>(
        conn,
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        target.sessionId,
      );
      if (typeof r.result?.value === "string") currentUrl = r.result.value;
    } catch { /* best-effort URL capture */ }
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        sessionId: rec.sessionId,
        urlHash: urlHash32(currentUrl),
        readKind: "text" as const,
        byteCount: text.length,
        ...(selector ? { selectorHash: selectorHashHex(selector) } : {}),
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

    if (opts.json) {
      emit(
        {
          ok: true,
          subcommand: "eval text",
          op_kind: meta.op_kind,
          session_id: rec.sessionId,
          target_id: rec.targetId,
          selector: selector || null,
          found,
          bytes: text.length,
          text,
          audit_emit: auditEmit,
        },
        opts,
      );
    } else {
      process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    }
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
