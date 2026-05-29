/**
 * `unbrowse eval markdown` — readable-markdown view of the current page.
 *
 * 1:1 mapping (kind-map.ts row "eval markdown"):
 *   CLI subcommand  : eval markdown
 *   MCP tool        : unbrowse_markdown
 *   Op kind   : eval:markdown
 *   Verb            : eval
 *
 * Composition: attach to the persisted session's Chrome via chromeWsUrl,
 * Runtime.evaluate `document.body.outerHTML`, run it through turndown
 * (existing dep — pattern lifted from src/cli.ts:2731), strip script/
 * style/noscript first, truncate to 10KB unless --raw. Pointer-only:
 * no value-bearing state is persisted; eval verbs are observation, not
 * audit (so no audit POST).
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

const DEFAULT_TRUNCATE_BYTES = 10 * 1024;

/** Strip script/style/noscript/iframe/svg/link/meta + comments + DOCTYPE
 *  before handing HTML to turndown. Matches the v6 cli.ts:2734 pattern. */
function stripPreamble(html: string): string {
  return html
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[^>]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*?>[\s\S]*?<\/noscript>/gi, "");
}

/** HTML -> Markdown via turndown. Pulled out so the test can also call it. */
export async function htmlToMarkdown(html: string): Promise<string> {
  // Dynamic import — matches v6 src/cli.ts:2731 pattern.
  const mod = await import("turndown");
  const TurndownService = (mod as unknown as { default: new (opts?: Record<string, unknown>) => {
    remove: (tags: string[]) => void;
    turndown: (html: string) => string;
  } }).default;
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.remove(["script", "style", "noscript", "iframe", "svg", "link", "meta"]);
  return turndown.turndown(stripPreamble(html));
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "markdown")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval markdown",
      {
        summary: "Readable-markdown view of the current page.",
        usage: "unbrowse eval markdown [--session <id>] [--raw]",
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--raw", description: "Skip 10KB truncation; return full markdown." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const raw = parsed.flags.raw === true;

  try {
    const rec = await resolveSession(sessionFlag);
    const conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);

    const evalResult = await call<
      { expression: string; returnByValue: boolean },
      RuntimeEvaluateResult
    >(
      conn,
      "Runtime.evaluate",
      {
        expression: "document.body ? document.body.outerHTML : ''",
        returnByValue: true,
      },
      target.sessionId,
    );

    const html = typeof evalResult.result?.value === "string"
      ? (evalResult.result.value as string)
      : "";

    const fullMd = html ? await htmlToMarkdown(html) : "";
    const truncated = !raw && fullMd.length > DEFAULT_TRUNCATE_BYTES;
    const md = truncated ? fullMd.slice(0, DEFAULT_TRUNCATE_BYTES) : fullMd;

    // A2 — sig-keyed audit row. The markdown bytes travel to stdout
    // as before; the wire carries only metadata (urlHash, byteCount).
    // Best-effort: failure surfaces in `audit_emit` envelope but does
    // NOT block the read.
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
        readKind: "markdown" as const,
        byteCount: md.length,
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
          subcommand: "eval markdown",
          op_kind: meta.op_kind,
          session_id: rec.sessionId,
          target_id: rec.targetId,
          bytes: md.length,
          truncated,
          markdown: md,
          audit_emit: auditEmit,
        },
        opts,
      );
    } else {
      process.stdout.write(md + (md.endsWith("\n") ? "" : "\n"));
    }
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
