/**
 * `unbrowse eval screenshot` — PNG capture of the current page.
 *
 * 1:1 mapping (kind-map.ts row "eval screenshot"):
 *   CLI subcommand  : eval screenshot
 *   MCP tool        : unbrowse_screenshot
 *   Covenant kind   : observe_screenshot
 *   Verb            : eval
 *
 * Composition: attach the persisted session's Chrome via chromeWsUrl,
 * fire Page.captureScreenshot({format:"png"}), decode base64.
 *
 * Output modes:
 *   - default: write to ~/.unbrowse/screenshots/<sessionId>-<ts>.png and
 *     print the path (or a JSON envelope with the path under --json).
 *   - --stdout: write raw PNG bytes to process.stdout for piping. Mutually
 *     exclusive with --json (refused at parse).
 *
 * Pointer-only: the path IS the pointer; the bytes are local on-disk under
 * the user's $HOME. No audit POST (read-only).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { attach, attachToTarget, call } from "../../cdp/index.js";
import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";

interface CaptureScreenshotResult {
  data: string; // base64 PNG
}

function screenshotsDir(): string {
  return join(homedir(), ".unbrowse", "screenshots");
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "screenshot")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval screenshot",
      {
        summary: "Page.captureScreenshot PNG of the current page.",
        usage: "unbrowse eval screenshot [--session <id>] [--stdout]",
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--stdout", description: "Write raw PNG bytes to stdout (for piping). Disables JSON output." },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const toStdout = parsed.flags.stdout === true;

  if (toStdout && opts.json) {
    emit(
      {
        error: "incompatible_flags",
        subcommand: "eval screenshot",
        detail: "--stdout writes raw PNG bytes; cannot combine with --json",
        covenant_kind: meta.covenant_kind,
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  try {
    const rec = await resolveSession(sessionFlag);
    const conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);

    const result = await call<{ format: string }, CaptureScreenshotResult>(
      conn,
      "Page.captureScreenshot",
      { format: "png" },
      target.sessionId,
    );

    const pngBytes = Buffer.from(result.data ?? "", "base64");

    if (toStdout) {
      process.stdout.write(pngBytes);
      process.exit(0);
    }

    await mkdir(screenshotsDir(), { recursive: true });
    const ts = Date.now();
    const path = join(screenshotsDir(), `${rec.sessionId}-${ts}.png`);
    await writeFile(path, pngBytes, { mode: 0o600 });

    if (opts.json) {
      emit(
        {
          ok: true,
          subcommand: "eval screenshot",
          covenant_kind: meta.covenant_kind,
          session_id: rec.sessionId,
          target_id: rec.targetId,
          path,
          bytes: pngBytes.length,
        },
        opts,
      );
    } else {
      process.stdout.write(path + "\n");
    }
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
