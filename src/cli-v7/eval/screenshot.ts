/**
 * `unbrowse eval screenshot` — PNG capture of the current page.
 *
 * 1:1 mapping (kind-map.ts row "eval screenshot"):
 *   CLI subcommand  : eval screenshot
 *   MCP tool        : unbrowse_screenshot
 *   Op kind   : eval:screenshot
 *   Verb            : eval
 *
 * Composition: attach the persisted session's Chrome via chromeWsUrl,
 * fire Page.captureScreenshot({format:"png"}), decode base64.
 *
 * Output modes:
 *   - --stdout: write raw PNG bytes to process.stdout for piping. Mutually
 *     exclusive with --json (refused at parse).
 *   - Default (W24.6 — stateless is the sole path): NEVER write under
 *     ~/.unbrowse/screenshots/. Compute
 *       blobSha256 = sha256(blob)
 *       sigKey     = sha256(signature_over_metadata)[:32]
 *     POST to /v1/screenshot/store and print `unbrowse-blob://<sigKey>`.
 *     On binding-missing (503), write to ~/.unbrowse/tmp/<sigKey>/screenshot.png
 *     so the bytes are still replay-recoverable (per A1's tmp-path
 *     exclusion — A1 falsifier excludes paths under a tmp segment).
 *
 * Doctrine:
 *   - Pointer-not-payload (contract 3c2dd353): the pointer URL IS the
 *     value the agent threads through subsequent tools.
 *   - A1 falsifier — `~/.unbrowse/screenshots/` MUST be empty/absent
 *     after a screenshot. The legal landing zones are
 *     `~/.unbrowse/tmp/<sigKey>/screenshot.png` (binding-missing fallback)
 *     and the backend KV row at `screenshot:<wallet>:<sigKey>:blob`.
 *   - Pointer scheme: `unbrowse-blob://<sigKey>` — `-blob` suffix
 *     distinguishes from W18 `unbrowse://` value pointers.
 *
 * Heb 4:13 — *"all things are naked and opened unto the eyes of him."*
 */
import { createHash } from "node:crypto";
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
import { postStateless } from "../_stateless.js";

interface CaptureScreenshotResult {
  data: string; // base64 PNG
}

function tmpScreenshotDir(sigKey: string): string {
  return join(homedir(), ".unbrowse", "tmp", sigKey);
}

/** sha256 of raw bytes → 64-char hex. */
function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256(url)[:32] hex — pointer-only urlHash. */
function urlHash32(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

/** Best-effort fetch of the current URL so we can urlHash it. Falls back to "". */
async function getCurrentUrlSafe(
  conn: unknown,
  sessionId: string,
): Promise<string> {
  try {
    const r = await call<
      { expression: string; returnByValue: boolean },
      { result: { value?: string } }
    >(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conn as any,
      "Runtime.evaluate",
      { expression: "window.location.href", returnByValue: true },
      sessionId,
    );
    const v = r?.result?.value;
    return typeof v === "string" && v.startsWith("http") ? v : "";
  } catch {
    return "";
  }
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
        op_kind: meta.op_kind,
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
        op_kind: meta.op_kind,
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

    // Pointer-indirection — NEVER under screenshots/.
    const blobSha256 = sha256HexBytes(pngBytes);
    const currentUrl = await getCurrentUrlSafe(conn, target.sessionId);
    const urlHashHex = urlHash32(currentUrl);
    const capturedAt = Date.now();

    // POST the metadata + blob; adapter signs the canonical fragment
    // over {sessionId, urlHash, blobSha256, capturedAt, nonce} — the
    // PNG bytes themselves do NOT enter the signed-fragment JSON, only
    // their content-hash (blobSha256). Sig over the hash → transitively
    // binds the bytes.
    const post = await postStateless({
      namespace: "screenshot",
      route: "/v1/screenshot/store",
      body: {
        sessionId: rec.sessionId,
        urlHash: urlHashHex,
        blobSha256,
        capturedAt,
        blobBase64: pngBytes.toString("base64"),
      },
      signableFields: [
        "sessionId",
        "urlHash",
        "blobSha256",
        "capturedAt",
        "nonce",
      ],
    });

    const sigKey = post.cacheKey; // sha256(sig)[:32] — byte-identical to backend
    const pointer = `unbrowse-blob://${sigKey}`;

    if (post.ok) {
      // Happy path — pointer-only, no local disk write.
      if (opts.json) {
        emit(
          {
            ok: true,
            subcommand: "eval screenshot",
            op_kind: meta.op_kind,
            session_id: rec.sessionId,
            target_id: rec.targetId,
            pointer,
            sigKey,
            blob_sha256: blobSha256,
            bytes: pngBytes.length,
            binding_status: "wired",
          },
          opts,
        );
      } else {
        // Plain mode prints the POINTER, not a path. A1 — pointer-only.
        process.stdout.write(pointer + "\n");
      }
      process.exit(0);
    }

    if (post.bindingMissing === "SCREENSHOT_BLOB") {
      // Binding-missing fallback — write to tmp/<sigKey>/ (NOT screenshots/).
      // A1 falsifier excludes paths with a tmp segment, so this is legal.
      const dir = tmpScreenshotDir(sigKey);
      await mkdir(dir, { recursive: true });
      const path = join(dir, "screenshot.png");
      await writeFile(path, pngBytes, { mode: 0o600 });
      process.stderr.write(
        `warn: screenshot backend binding missing — wrote tmp file (replay-only): ${path}\n`,
      );

      if (opts.json) {
        emit(
          {
            ok: true,
            subcommand: "eval screenshot",
            op_kind: meta.op_kind,
            session_id: rec.sessionId,
            target_id: rec.targetId,
            pointer,
            sigKey,
            blob_sha256: blobSha256,
            bytes: pngBytes.length,
            binding_status: "missing",
            tmp_replay_path: path,
            warning: "SCREENSHOT_BLOB binding absent — bytes stored locally for replay",
          },
          opts,
        );
      } else {
        process.stdout.write(pointer + "\n");
      }
      process.exit(0);
    }

    // Non-binding-missing POST failure — surface as honest error. The
    // bytes are LOST in this branch by design: a 4xx/5xx that isn't
    // binding-missing means schema rejection or sig-verify fail; either
    // way the agent should not silently get a stale local file.
    emit(
      {
        error: "screenshot_post_failed",
        subcommand: "eval screenshot",
        op_kind: meta.op_kind,
        sigKey,
        http_status: post.httpStatus,
        error_hint: post.errorHint,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
