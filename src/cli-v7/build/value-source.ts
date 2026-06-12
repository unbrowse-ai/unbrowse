/**
 * `unbrowse build value-source <pointer>` — register a value pointer.
 * Local-only (no MCP tool). Op kind `build:value-source`.
 *
 * W2 value-store wave is still pending — this handler is the
 * DECLARATION witness ahead of that wave. W24.2 (2026-05-28, A2
 * coverage closure): the handler emits a sig-keyed `build-value-source`
 * act-act receipt so the declaration is admissible as a witnessed
 * act now.
 *
 * Critical: NEVER read cleartext from argv — the value flows through
 * stdin or interactive prompt in W2. The audit witness here records
 * ONLY the pointer URI (which is addressable, not secret) hashed via
 * the helper's selector field. The receipt body carries the pointer
 * commitment, never the value.
 */
import type { ParsedV7Args } from "../args.js";
import {
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { emitBreathActStateless } from "../_act-audit.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("build", "value-source")!;

  if (parsed.wantsHelp) {
    helpExit(
      "build value-source",
      {
        summary: "Register a vault item (one-time write to keychain/op/bw); local-only.",
        usage: "unbrowse build value-source <pointer> [--from-stdin] [--prompt] [--touch-id]",
        positional: [
          {
            name: "pointer",
            description:
              "Target pointer URI to write to (e.g. `keychain://com.unbrowse/lewis`).",
            required: true,
          },
        ],
        flags: [
          { name: "--from-stdin", description: "Read the cleartext value from stdin (no echo)." },
          { name: "--prompt", description: "Interactively prompt for the value (no echo)." },
          { name: "--touch-id", description: "For keychain:// — require user-presence ACL on read." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "build",
      },
      opts,
    );
  }

  const pointer = parsed.positional[0];
  if (!pointer) {
    emit(
      {
        error: "missing_positional",
        subcommand: "build value-source",
        required: ["pointer"],
        got: parsed.positional,
        op_kind: meta.op_kind,
        hint: "Run `unbrowse build value-source --help` for details.",
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  // Defense-in-depth: refuse pointer shapes that look like cleartext
  // smuggling. The W2 wave will own real pointer parsing; this gate
  // catches "pointer = <secret>" misuse at the boundary.
  if (!/^[a-z][a-z0-9+\-.]*:\/\/.+/.test(pointer)) {
    emit(
      {
        error: "invalid_pointer",
        subcommand: "build value-source",
        reason: "pointer must be a URI like keychain://... or op://...",
        op_kind: meta.op_kind,
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  const touchId = parsed.flags["touch-id"] === true;

  try {
    // W24.2 — emit the declaration witness. Selector overload: pass
    // the pointer URI (sha256-hashed by helper) — the URI is itself
    // addressable, not secret, so the hash form is forensically useful
    // without leaking which vault account was touched in cleartext.
    const declareAudit = await emitBreathActStateless({
      sessionId: pointer,
      actType: "build-value-source",
      selector: pointer,
      currentUrl: "",
    });

    emit(
      {
        ok: true,
        subcommand: "build value-source",
        op_kind: meta.op_kind,
        pointer,
        touch_id: touchId,
        // The real write wire is W2; the witness IS the act today.
        pending_write_wave: "W2",
        audit: declareAudit.skipped
          ? false
          : {
              ok: declareAudit.ok,
              idempotent: declareAudit.idempotent,
              binding_missing: declareAudit.bindingMissing,
              receipt_id: declareAudit.receiptId,
              cache_key: declareAudit.cacheKey,
              variant: "act-act",
              act_type: "build-value-source",
            },
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(1);
  }
}
