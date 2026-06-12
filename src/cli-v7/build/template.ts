/**
 * `unbrowse build template <name>` — declare a reusable fill/exec template.
 * Maps to MCP `unbrowse_annotate`, route kind `fill_template_declare`.
 *
 * W3.1 binding-store path is still pending — this handler is the
 * DECLARATION witness ahead of that wave. W24.2 (2026-05-28, A2
 * coverage closure): the handler emits a sig-keyed `build-template`
 * act-act receipt so the declaration is admissible as a witnessed
 * act now. Pointer-only: the template fields stay in agent memory
 * until W3.1 wires the persistence layer.
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
  const meta = lookupKindMap("build", "template")!;

  if (parsed.wantsHelp) {
    helpExit(
      "build template",
      {
        summary: "Declare a reusable fill/exec template binding selectors to value pointers.",
        usage: "unbrowse build template <name> [--field <selector>=<pointer>] [--from-skill <id>]",
        positional: [
          { name: "name", description: "Template identifier (kebab-case).", required: true },
        ],
        flags: [
          { name: "--field", description: "Repeatable: `--field <selector>=<pointer>`.", value_expected: true },
          { name: "--from-skill", description: "Bootstrap fields from an existing skill id.", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "build",
      },
      opts,
    );
  }

  const name = parsed.positional[0];
  if (!name) {
    emit(
      {
        error: "missing_positional",
        subcommand: "build template",
        required: ["name"],
        got: parsed.positional,
        op_kind: meta.op_kind,
        hint: "Run `unbrowse build template --help` for details.",
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  const fromSkill =
    typeof parsed.flags["from-skill"] === "string" ? parsed.flags["from-skill"] : null;

  try {
    // W24.2 — emit the declaration witness. Selector overload: pass
    // the template name (sha256-hashed by helper) so the witness binds
    // to which template was declared without leaking field-pointer
    // bindings (those stay agent-local until W3.1).
    const declareAudit = await emitBreathActStateless({
      sessionId: name,
      actType: "build-template",
      selector: name,
      currentUrl: fromSkill ?? "",
    });

    emit(
      {
        ok: true,
        subcommand: "build template",
        op_kind: meta.op_kind,
        template_name: name,
        from_skill: fromSkill,
        // Persistence wire is W3.1; the witness IS the act today.
        pending_persist_wave: "W3.1",
        audit: declareAudit.skipped
          ? false
          : {
              ok: declareAudit.ok,
              idempotent: declareAudit.idempotent,
              binding_missing: declareAudit.bindingMissing,
              receipt_id: declareAudit.receiptId,
              cache_key: declareAudit.cacheKey,
              variant: "act-act",
              act_type: "build-template",
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
