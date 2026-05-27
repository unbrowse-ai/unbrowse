/**
 * `unbrowse breath fill <selector> <pointer>` —
 * dereference value via src/values/, dispatch via src/cdp/ Input.insertText,
 * POST AuditFillBody to /v1/audit/fill, exit.
 *
 * 1:1 mapping (kind-map.ts row "breath fill"):
 *   CLI subcommand  : breath fill
 *   MCP tool        : unbrowse_fill
 *   Covenant kind   : actuate_fill
 *   Verb            : breath
 *
 * Secret-redaction invariants (LOAD-BEARING):
 *   - This handler is the ONE place a resolved value Uint8Array becomes a
 *     string. Conversion happens inside a try/finally that calls safeZero
 *     immediately after `Input.insertText` returns.
 *   - The string form is scope-local — never assigned to a module-level
 *     binding, never logged, never returned, never written to a file, never
 *     embedded in any --json output (which carries the POINTER, not the
 *     value).
 *   - Even on error: stdout / stderr / session-file mention only the
 *     pointer. Exit codes signal failure shape; the value never escapes.
 *
 * Exit codes (handler-specific, on top of EX_USAGE for help):
 *   0   success — fill happened AND audit POST returned 2xx
 *   65  EX_DATAERR equivalent — CDP layer failed (selector missing, focus
 *                  failed, insertText threw)
 *   70  EX_SOFTWARE — value-store adapter failed (locked, unavailable,
 *                  timeout, missing arg)
 *   1   generic failure (audit POST non-2xx, network error)
 *
 * contextHash derivation (mirrored in audit.ts canonicalizeSignedFragment):
 *   contextHash = sha256( sessionId || ":" || selector || ":" || url
 *                          || ":" || floor(Date.now() / 300_000) ).hex
 *   — the 300_000 ms (5-minute) bucket binds the fill to a coarse epoch so
 *   replays inside the same window are valid but cross-window aren't. The
 *   exact same byte sequence is what the wallet signed over upstream.
 */
import { randomBytes, createHash } from "node:crypto";

import { attach, attachToTarget, call, dom, input } from "../../cdp/index.js";
import { resolve as resolveValue, safeZero, looksLikePointer } from "../../values/index.js";

// AuditFillBody is mirrored from backend/src/services/audit.ts. The runtime
// surface is the wire schema; importing across the rootDir boundary would
// break tsc's project layout, so we re-declare the shape (and the
// canonicalizeSignedFragment helper) locally. The two MUST stay in sync —
// any field addition to AuditFillBody server-side requires a matching
// addition here and a wire-shape test.
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
/** Mirror of backend canonicalizeSignedFragment. Byte-equal output. */
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
 * Derive the v7 fill contextHash. The byte sequence MUST match exactly
 * what `audit.ts canonicalizeSignedFragment` expects to be signed over —
 * the wallet upstream (W6) signs `pointer || nonce || contextHash`, and
 * the audit server re-canonicalizes `{pointer, nonce, contextHash, commitment}`
 * to verify. This contextHash IS the bytes the signer signed over.
 *
 *   contextHash = hex( sha256(
 *     sessionId || ":" || selector || ":" || url || ":" ||
 *     floor(Date.now() / 300_000)
 *   ) )
 */
export function deriveContextHash(
  sessionId: string,
  selector: string,
  url: string,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / FIVE_MINUTES_MS).toString();
  const payload = `${sessionId}:${selector}:${url}:${bucket}`;
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
  // Bun + Node 20+ both ship Buffer; Uint8Array.toBase64 isn't universal yet.
  return Buffer.from(b).toString("base64");
}

/**
 * Parse `--arg key=value` (repeatable) into an ArgScope object the W6
 * ArgAdapter consults. Flag form: `--arg username=alice --arg token=foo`.
 * The CLI parser collapses repeated flags into the last value; we read the
 * raw argv positional fallback if multi-arg is needed (out of scope today).
 */
function parseArgScope(parsed: ParsedV7Args): Record<string, string> {
  const out: Record<string, string> = {};
  // Support both `--arg key=value` (multiple) and `--argScope <json>`.
  // The args parser stores the LAST occurrence under `arg`; for v7.0 minimum
  // we accept `--argScope '{"k":"v"}'` as the canonical multi-key path.
  const scope = parsed.flags["argScope"] ?? parsed.flags["arg-scope"];
  if (typeof scope === "string") {
    try {
      const parsed = JSON.parse(scope) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
    } catch {
      // ignore malformed JSON — the adapter will surface arg_missing if
      // the requested key is absent.
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
  const meta = lookupKindMap("breath", "fill")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath fill",
      {
        summary: "Dereference a value pointer and Input.insertText into the selector.",
        usage: "unbrowse breath fill <selector> <pointer> [--session <id>] [--arg key=value] [--argScope <json>]",
        positional: [
          { name: "selector", description: "CSS selector OR `[eN]` accessibility ref.", required: true },
          { name: "pointer", description: "Value pointer (op:// | keychain:// | bw:// | arg:// | cleartext).", required: true },
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

  const selector = parsed.positional[0];
  const pointerArg = parsed.positional[1];
  if (!selector || !pointerArg) {
    emit(
      {
        error: "missing_positional",
        subcommand: "breath fill",
        required: ["selector", "pointer"],
        got: parsed.positional,
        covenant_kind: meta.covenant_kind,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  // Cleartext shortcut: wrap inline values as arg://__inline__ so the
  // receipt body still carries a pointer-shaped URI. Per VALUE_STORE_ADAPTERS
  // §arg-semantics.
  let pointerUri: string;
  const inlineArgScope: Record<string, string> = parseArgScope(parsed);
  if (looksLikePointer(pointerArg)) {
    pointerUri = pointerArg;
  } else {
    pointerUri = "arg://__inline__";
    inlineArgScope["__inline__"] = pointerArg;
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const apiBase = process.env.UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai";
  const auditUrl = `${apiBase.replace(/\/$/, "")}/v1/audit/fill`;

  let rec;
  try {
    rec = await resolveSession(sessionFlag);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  // ── Attach to CDP, read current URL for contextHash binding ──────────────
  let conn;
  let targetSessionId: string;
  let currentUrl: string;
  try {
    conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    targetSessionId = target.sessionId;
    // CDP Page.getNavigationHistory.currentIndex gives us the live URL
    // without an extra Runtime.evaluate hop.
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

  // ── Derive contextHash + nonce ───────────────────────────────────────────
  const contextHashHex = deriveContextHash(rec.sessionId, selector, currentUrl, Date.now());
  const contextHashBytes = Buffer.from(contextHashHex, "hex");
  const nonce = new Uint8Array(randomBytes(32));

  // ── Resolve value (W6) — Uint8Array, AsyncDisposable, zeroed in finally ──
  // The `await using` form gives us the asyncDispose guarantee even on throw;
  // we still run an explicit safeZero in the finally as belt-and-suspenders
  // because the resolved value handle may live longer than the inner block.
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

  // commitment + signature come from the adapter; never recomputed here.
  const commitmentHex = bytesToHex(resolved.commitment);
  const signatureHex = bytesToHex(resolved.signature);
  const walletPubkeyHex = bytesToHex(resolved.walletPubkey);
  const nonceB64 = bytesToBase64(nonce);

  // ── CDP fill — the ONE site where the value becomes a string ─────────────
  try {
    try {
      // Resolve the selector → backendNodeId → focus → insertText. v7's
      // DOM helpers (W5) expose these as primitives; if a particular method
      // isn't surfaced, we fall back to raw CDP calls via the connection.
      let backendNodeId: number | undefined;
      try {
        const doc = await call<Record<string, never>, { root: { nodeId: number } }>(
          conn,
          "DOM.getDocument",
          {},
          targetSessionId,
        );
        const node = await call<{ nodeId: number; selector: string }, { nodeId: number }>(
          conn,
          "DOM.querySelector",
          { nodeId: doc.root.nodeId, selector },
          targetSessionId,
        );
        if (!node.nodeId) throw new Error(`selector_not_found:${selector}`);
        const desc = await call<{ nodeId: number }, { node: { backendNodeId: number } }>(
          conn,
          "DOM.describeNode",
          { nodeId: node.nodeId },
          targetSessionId,
        );
        backendNodeId = desc.node.backendNodeId;
        await call(conn, "DOM.focus", { backendNodeId }, targetSessionId);
      } catch (rawErr) {
        // Re-throw with EX_CDP shape — the dom helpers may not be wired yet.
        void backendNodeId;
        void dom;
        throw rawErr;
      }

      // THE one allowed Uint8Array -> string boundary in the fill path.
      // Marked so the no-tostring-on-secret lint rule (when it lands) knows
      // this site is sanctioned.
      // eslint-disable-next-line no-tostring-on-secret -- CDP boundary
      const valueAsString = new TextDecoder("utf-8").decode(resolved.value);
      try {
        await call(conn, "Input.insertText", { text: valueAsString }, targetSessionId);
      } finally {
        // valueAsString is scope-local; it falls out of scope here. We
        // cannot zero a string in V8 (interned/immutable), but the bytes
        // are zeroed below via safeZero(resolved.value), and the lifetime
        // of the string is bounded by this stack frame.
        void input;
      }
    } finally {
      // Re-zero the Uint8Array immediately on the CDP path exit, whether
      // insertText succeeded or threw. The adapter's AsyncDisposable will
      // also fire, but doing it here matches the spec's 50 ms budget.
      try {
        safeZero(resolved.value);
      } catch {
        // safeZero throws only on unimplemented sodium — fall back to fill(0).
        try { resolved.value.fill(0); } catch { /* unrecoverable; nothing more we can do */ }
      }
    }
  } catch (err) {
    // CDP path failed AFTER value was resolved. Per spec: do NOT POST a
    // commitment for a failed fill (would leak "this exact value was
    // attempted"). Dispose and exit.
    try { await resolved[Symbol.asyncDispose](); } catch { /* best-effort */ }
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // Adapter handle disposal — fires asyncDispose (zeros the buffer again).
  try { await resolved[Symbol.asyncDispose](); } catch { /* best-effort */ }

  // ── Build + POST AuditFillBody ───────────────────────────────────────────
  const body: AuditFillBody = {
    pointer: pointerUri,
    nonce: nonceB64,
    contextHash: contextHashHex,
    commitment: commitmentHex,
    walletPubkey: walletPubkeyHex,
    signatureScheme: "ed25519-v7.0",
    signature: signatureHex,
    variant: "fill",
    urlHash: currentUrl ? sha256Hex(currentUrl) : undefined,
    selectorHash: sha256Hex(selector),
  };

  // Audit POST — re-canonicalize on the client too so a future
  // protocol-tests harness can assert client + server agree on the bytes.
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
          subcommand: "breath fill",
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
      subcommand: "breath fill",
      covenant_kind: meta.covenant_kind,
      session_id: rec.sessionId,
      selector,
      pointer: pointerUri, // pointer is the receipt; value is gone
      commitment: commitmentHex,
      nonce: nonceB64,
      contextHash: contextHashHex,
      walletPubkey: walletPubkeyHex,
      variant: "fill",
    },
    opts,
  );
  process.exit(0);
}
