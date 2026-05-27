/**
 * `unbrowse breath select <selector> <pointer-or-value>` —
 * set a <select> element to a chosen <option>.
 *
 * 1:1 mapping (kind-map.ts row "breath select"):
 *   CLI subcommand  : breath select
 *   MCP tool        : unbrowse_select
 *   Covenant kind   : actuate_select
 *   Verb            : breath
 *
 * VALUE-BEARING when arg is pointer-shaped. The pointer path runs the full
 * src/values/ resolve -> Uint8Array -> scope-local string -> CDP setter ->
 * safeZero pipeline, then POSTs AuditFillBody{variant:"fill"} to /v1/audit/fill.
 * Same security invariants as breath/fill.ts (see that file for the spec).
 *
 * Literal cleartext path: just set the value via Runtime.evaluate. No
 * audit POST (no secret crossed the wire).
 *
 * Exit codes (parallel to fill.ts):
 *   0   success
 *   65  EX_DATAERR — CDP / selector not found / option not found
 *   70  EX_SOFTWARE — value-store adapter failed
 *   1   generic failure (audit POST non-2xx)
 */
import { randomBytes, createHash } from "node:crypto";

import { attach, attachToTarget, call } from "../../cdp/index.js";
import { resolve as resolveValue, safeZero, looksLikePointer } from "../../values/index.js";

// Mirror of backend/src/services/audit.ts AuditFillBody — kept in sync with
// the wire schema. Any new field server-side requires a matching addition
// here and a wire-shape test.
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
import { deriveContextHash } from "./fill.js";

const EX_CDP = 65;

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
      const parsedScope = JSON.parse(scope) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsedScope)) {
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

/**
 * Set the <select>'s value using Runtime.callFunctionOn against a freshly
 * resolved RemoteObject for the node. We iterate the options to find a
 * matching `value`, `label/text`, or numeric index (per `--by`), set
 * `selectedIndex`, then fire `change` + `input` events so frameworks
 * (React, Vue) pick up the mutation.
 *
 * NOTE: this is a scope-local function. The `value` string passed in is the
 * sanctioned Uint8Array->string boundary; it falls out of scope at function
 * return and is never logged or returned.
 */
async function setSelectValue(
  conn: Awaited<ReturnType<typeof attach>>,
  targetSessionId: string,
  selector: string,
  value: string,
  by: "value" | "label" | "index",
): Promise<void> {
  // Resolve the selector to a RemoteObject so we can callFunctionOn it.
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

  const resolved = await call<
    { nodeId: number },
    { object: { objectId: string } }
  >(conn, "DOM.resolveNode", { nodeId: node.nodeId }, targetSessionId);

  // Selector function runs in-page. It tries an exact value match first
  // (for the `value` mode), then label/text, then numeric index. Throws
  // option_not_found if nothing matches. Returns the index that was selected.
  const fn = `
    function(needle, byMode) {
      if (this.tagName !== "SELECT") throw new Error("not_a_select:" + this.tagName);
      const opts = Array.from(this.options);
      let idx = -1;
      if (byMode === "index") {
        const n = parseInt(needle, 10);
        if (Number.isFinite(n) && n >= 0 && n < opts.length) idx = n;
      } else if (byMode === "label") {
        idx = opts.findIndex(o => o.label === needle || o.text === needle);
      } else {
        idx = opts.findIndex(o => o.value === needle);
        if (idx < 0) idx = opts.findIndex(o => o.label === needle || o.text === needle);
      }
      if (idx < 0) throw new Error("option_not_found");
      this.selectedIndex = idx;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return idx;
    }
  `;

  const res = await call<
    {
      objectId: string;
      functionDeclaration: string;
      arguments: Array<{ value: string }>;
      returnByValue: boolean;
    },
    { result: { value?: number }; exceptionDetails?: { text: string; exception?: { description?: string } } }
  >(
    conn,
    "Runtime.callFunctionOn",
    {
      objectId: resolved.object.objectId,
      functionDeclaration: fn,
      arguments: [{ value }, { value: by }],
      returnByValue: true,
    },
    targetSessionId,
  );
  if (res.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(`select_failed:${msg}`);
  }
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "select")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath select",
      {
        summary: "Set a <select> element's value (pointer-or-cleartext).",
        usage: "unbrowse breath select <selector> <pointer-or-value> [--session <id>] [--by value|label|index] [--arg key=value] [--argScope <json>]",
        positional: [
          { name: "selector", description: "CSS selector of the <select> element.", required: true },
          {
            name: "pointer",
            description: "Value pointer (op:// | keychain:// | bw:// | arg://) or cleartext literal.",
            required: true,
          },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--by", description: "value | label | index (default: value).", value_expected: true },
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
        subcommand: "breath select",
        required: ["selector", "pointer-or-value"],
        got: parsed.positional,
        covenant_kind: meta.covenant_kind,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  const byRaw = parsed.flags.by;
  const by: "value" | "label" | "index" =
    byRaw === "label" || byRaw === "index" ? byRaw : "value";

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const isPointer = looksLikePointer(pointerArg);

  let rec;
  try {
    rec = await resolveSession(sessionFlag);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  // ── Attach to CDP ─────────────────────────────────────────────────────────
  let conn;
  let targetSessionId: string;
  let currentUrl: string;
  try {
    conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    targetSessionId = target.sessionId;
    const hist = await call<
      Record<string, never>,
      { currentIndex: number; entries: Array<{ url: string }> }
    >(conn, "Page.getNavigationHistory", {}, targetSessionId);
    currentUrl = hist.entries[hist.currentIndex]?.url ?? "";
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // ── Literal cleartext path: no value-store, no audit POST ────────────────
  if (!isPointer) {
    try {
      await setSelectValue(conn, targetSessionId, selector, pointerArg, by);
    } catch (err) {
      emitErr(err, opts);
      process.exit(EX_CDP);
    }
    emit(
      {
        ok: true,
        subcommand: "breath select",
        covenant_kind: meta.covenant_kind,
        session_id: rec.sessionId,
        selector,
        by,
        // Literal value path: we DO NOT echo the value either (consistency
        // with the pointer path which never echoes). Only the fact of the
        // select happened lands on stdout.
        literal: true,
      },
      opts,
    );
    process.exit(0);
  }

  // ── Pointer path: full fill.ts security pipeline ─────────────────────────
  const apiBase = process.env.UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai";
  const auditUrl = `${apiBase.replace(/\/$/, "")}/v1/audit/fill`;

  const inlineArgScope: Record<string, string> = parseArgScope(parsed);
  const pointerUri = pointerArg;

  const contextHashHex = deriveContextHash(rec.sessionId, selector, currentUrl, Date.now());
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

  // The ONE allowed Uint8Array -> string boundary in the select pointer path.
  // Mirrors fill.ts: TextDecoder scope-local, safeZero in finally, never
  // assigned to module scope, never logged, never returned.
  try {
    try {
      // eslint-disable-next-line no-tostring-on-secret -- CDP boundary
      const valueAsString = new TextDecoder("utf-8").decode(resolved.value);
      try {
        await setSelectValue(conn, targetSessionId, selector, valueAsString, by);
      } finally {
        // valueAsString falls out of scope here; the underlying bytes are
        // zeroed in the outer finally.
      }
    } finally {
      try {
        safeZero(resolved.value);
      } catch {
        try {
          resolved.value.fill(0);
        } catch {
          /* unrecoverable */
        }
      }
    }
  } catch (err) {
    try {
      await resolved[Symbol.asyncDispose]();
    } catch {
      /* best-effort */
    }
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  try {
    await resolved[Symbol.asyncDispose]();
  } catch {
    /* best-effort */
  }

  // ── AuditFillBody POST — variant "fill" (same as fill.ts) ────────────────
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

  // Re-canonicalize client-side so a future protocol test asserts byte-parity.
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
          subcommand: "breath select",
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
      subcommand: "breath select",
      covenant_kind: meta.covenant_kind,
      session_id: rec.sessionId,
      selector,
      by,
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
