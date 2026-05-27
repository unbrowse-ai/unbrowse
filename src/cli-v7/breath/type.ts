/**
 * `unbrowse breath type <text-or-pointer>` — value-bearing text input.
 *
 * 1:1 mapping (kind-map.ts row "breath type"):
 *   CLI subcommand  : breath type
 *   MCP tool        : unbrowse_type
 *   Covenant kind   : actuate_type
 *   Verb            : breath
 *
 * Two paths:
 *   POINTER PATH    : arg starts with op:// | keychain:// | bw:// | arg://
 *                     -> resolve via src/values/, Input.insertText, audit POST
 *                     (variant=fill — type is morally a fill at the focus).
 *   LITERAL PATH    : anything else
 *                     -> Input.insertText directly, NO audit POST.
 *                     Caller is explicit about plaintext; the value may be
 *                     echoed because they passed it on the command line.
 *                     For anything sensitive, use `arg://<key> --arg <key>=<v>`.
 *
 * Secret-redaction invariants on the POINTER PATH mirror breath/fill.ts:
 *   - Value -> string conversion is scope-local in a try/finally with
 *     safeZero immediately after Input.insertText.
 *   - Pointer is the only surface that touches stdout/stderr/audit body.
 *
 * Exit codes match fill.ts:
 *   0   success — insertText happened AND (literal path: always) OR
 *                 (pointer path: audit POST returned 2xx)
 *   65  EX_CDP / EX_DATAERR — CDP layer failed
 *   70  EX_SOFTWARE         — value-store adapter failed (pointer path only)
 *   1   generic failure (audit POST non-2xx, network error)
 */
import { randomBytes, createHash } from "node:crypto";

import { attach, attachToTarget, call } from "../../cdp/index.js";
import { resolve as resolveValue, safeZero, looksLikePointer } from "../../values/index.js";

// Mirror of backend/src/services/audit.ts AuditFillBody — kept in sync by
// the same convention fill.ts uses (no cross-rootDir imports).
type AuditVariant = "fill" | "header-inject" | "payload-field";
type SignatureScheme = "ed25519-v7.0" | "groth16-v7.3";
interface AuditFillBody {
  pointer: string;
  nonce: string;
  contextHash: string;
  commitment: string;
  walletPubkey: string;
  signatureScheme?: SignatureScheme;
  signature: string;
  variant: AuditVariant;
  urlHash?: string;
  selectorHash?: string;
  headerNameHash?: string;
  payloadPath?: string;
}
function canonicalizeSignedFragment(
  body: Pick<AuditFillBody, "pointer" | "nonce" | "contextHash" | "commitment">,
): string {
  return JSON.stringify({
    pointer: body.pointer,
    nonce: body.nonce,
    contextHash: body.contextHash,
    commitment: body.commitment,
  });
}

import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import {
  EX_GENERIC,
  EX_SOFTWARE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";

const EX_CDP = 65;
const FIVE_MINUTES_MS = 300_000;

/**
 * Derive the v7 type contextHash. Same shape as fill.ts:deriveContextHash but
 * the "selector" slot is the literal string "__focus__" because `type` writes
 * into the current focus (no explicit selector).
 */
function deriveContextHash(
  sessionId: string,
  url: string,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / FIVE_MINUTES_MS).toString();
  const payload = `${sessionId}:__focus__:${url}:${bucket}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
  return h;
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

function parseArgScope(parsed: ParsedV7Args): Record<string, string> {
  const out: Record<string, string> = {};
  const scope = parsed.flags["argScope"] ?? parsed.flags["arg-scope"];
  if (typeof scope === "string") {
    try {
      const parsedJson = JSON.parse(scope) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsedJson)) {
        if (typeof v === "string") out[k] = v;
      }
    } catch {
      // ignore malformed JSON
    }
  }
  const single = parsed.flags["arg"];
  if (typeof single === "string") {
    const eq = single.indexOf("=");
    if (eq > 0) out[single.slice(0, eq)] = single.slice(eq + 1);
  }
  return out;
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "type")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath type",
      {
        summary: "Type text or dereference a value pointer into the current focus.",
        usage: "unbrowse breath type <text-or-pointer> [--session <id>] [--arg key=value] [--argScope <json>]",
        positional: [
          {
            name: "text-or-pointer",
            description:
              "Literal text to type, OR a value pointer (op://|keychain://|bw://|arg://). "
              + "Literal text is NOT auditable and is echoed in CLI output — "
              + "for anything sensitive use `arg://<key> --arg <key>=<value>`.",
            required: true,
          },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--arg", description: "Single arg-scope key (key=value form).", value_expected: true },
          { name: "--argScope", description: "Full arg-scope object as JSON.", value_expected: true },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  const textOrPointer = parsed.positional[0];
  if (!textOrPointer) {
    emit(
      {
        error: "missing_positional",
        subcommand: "breath type",
        required: ["text-or-pointer"],
        got: parsed.positional,
        covenant_kind: meta.covenant_kind,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const isPointerPath = looksLikePointer(textOrPointer);

  let rec;
  try {
    rec = await resolveSession(sessionFlag);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  // ── Attach to CDP ──────────────────────────────────────────────────────────
  let conn;
  let targetSessionId: string;
  let currentUrl: string;
  try {
    conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    targetSessionId = target.sessionId;
    const hist = await call<Record<string, never>, { currentIndex: number; entries: Array<{ url: string }> }>(
      conn,
      "Page.getNavigationHistory",
      {},
      targetSessionId,
    );
    currentUrl = hist.entries[hist.currentIndex]?.url ?? "";
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // ── LITERAL PATH ───────────────────────────────────────────────────────────
  if (!isPointerPath) {
    try {
      await call(conn, "Input.insertText", { text: textOrPointer }, targetSessionId);
    } catch (err) {
      emitErr(err, opts);
      process.exit(EX_CDP);
    }
    emit(
      {
        ok: true,
        subcommand: "breath type",
        covenant_kind: meta.covenant_kind,
        session_id: rec.sessionId,
        path: "literal",
        // Echo is allowed — caller passed it on the CLI explicitly. For
        // sensitive values they should be using arg://<key>.
        text: textOrPointer,
        audit: false,
      },
      opts,
    );
    process.exit(0);
  }

  // ── POINTER PATH (mirrors fill.ts) ─────────────────────────────────────────
  const pointerUri = textOrPointer;
  const inlineArgScope: Record<string, string> = parseArgScope(parsed);
  const apiBase = process.env.UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai";
  const auditUrl = `${apiBase.replace(/\/$/, "")}/v1/audit/fill`;

  const contextHashHex = deriveContextHash(rec.sessionId, currentUrl, Date.now());
  const contextHashBytes = Buffer.from(contextHashHex, "hex");
  const nonce = new Uint8Array(randomBytes(32));

  let resolved;
  try {
    resolved = await resolveValue(pointerUri, nonce, {
      contextHash: contextHashBytes,
      argScope: inlineArgScope,
    });
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_SOFTWARE);
  }

  const commitmentHex = bytesToHex(resolved.commitment);
  const signatureHex = bytesToHex(resolved.signature);
  const walletPubkeyHex = bytesToHex(resolved.walletPubkey);
  const nonceB64 = bytesToBase64(nonce);

  try {
    try {
      // THE one allowed Uint8Array -> string boundary in the type path.
      // eslint-disable-next-line no-tostring-on-secret -- CDP boundary
      const valueAsString = new TextDecoder("utf-8").decode(resolved.value);
      await call(conn, "Input.insertText", { text: valueAsString }, targetSessionId);
    } finally {
      try {
        safeZero(resolved.value);
      } catch {
        try { resolved.value.fill(0); } catch { /* unrecoverable */ }
      }
    }
  } catch (err) {
    try { await resolved[Symbol.asyncDispose](); } catch { /* best-effort */ }
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  try { await resolved[Symbol.asyncDispose](); } catch { /* best-effort */ }

  const body: AuditFillBody = {
    pointer: pointerUri,
    nonce: nonceB64,
    contextHash: contextHashHex,
    commitment: commitmentHex,
    walletPubkey: walletPubkeyHex,
    signatureScheme: "ed25519-v7.0",
    signature: signatureHex,
    // `type` is morally a fill into wherever focus currently is — variant=fill
    // per spec ("type is morally a fill into wherever focus currently is").
    variant: "fill",
    urlHash: currentUrl ? sha256Hex(currentUrl) : undefined,
  };

  void canonicalizeSignedFragment(body);

  try {
    const res = await fetch(auditUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => "");
      emit(
        {
          ok: false,
          subcommand: "breath type",
          covenant_kind: meta.covenant_kind,
          error: "audit_post_failed",
          status: res.status,
          response_excerpt: text.slice(0, 200),
          pointer: pointerUri, // pointer only — never the value
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  emit(
    {
      ok: true,
      subcommand: "breath type",
      covenant_kind: meta.covenant_kind,
      session_id: rec.sessionId,
      path: "pointer",
      pointer: pointerUri, // pointer is the receipt; value is gone
      commitment: commitmentHex,
      nonce: nonceB64,
      contextHash: contextHashHex,
      walletPubkey: walletPubkeyHex,
      variant: "fill",
      audit: true,
    },
    opts,
  );
  process.exit(0);
}
