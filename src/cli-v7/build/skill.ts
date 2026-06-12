/**
 * `unbrowse build skill <skill-id>` — declare a captured skill manifest.
 * Maps to MCP `unbrowse_publish`, route kind `skill_declare`.
 *
 * W3.1 publish path is still pending — this handler is the DECLARATION
 * witness ahead of that wave. W24.2 (2026-05-28, A2 coverage closure):
 * the handler emits a sig-keyed `build-skill` act-act receipt so the
 * agent's declaration is admissible as a witnessed act now, not only
 * after the publish wire lands. When the real publish ships, the call
 * becomes "emit + push to marketplace" with the same receipt id
 * chaining the two phases.
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
  const meta = lookupKindMap("build", "skill")!;

  if (parsed.wantsHelp) {
    helpExit(
      "build skill",
      {
        summary: "Register a captured skill manifest (sequence of endpoints + selectors).",
        usage: "unbrowse build skill <skill-id> [--domain <d>] [--public] [--dry-run]",
        positional: [
          { name: "skill-id", description: "Local skill id from `unbrowse eval skills`.", required: true },
        ],
        flags: [
          { name: "--domain", description: "Override the skill's bound domain.", value_expected: true },
          { name: "--public", description: "Publish to the global marketplace (default: account-scoped)." },
          { name: "--dry-run", description: "Validate manifest without publishing." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "build",
      },
      opts,
    );
  }

  const skillId = parsed.positional[0];
  if (!skillId) {
    emit(
      {
        error: "missing_positional",
        subcommand: "build skill",
        required: ["skill-id"],
        got: parsed.positional,
        op_kind: meta.op_kind,
        hint: "Run `unbrowse build skill --help` for details.",
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  const domain = typeof parsed.flags.domain === "string" ? parsed.flags.domain : null;
  const isPublic = parsed.flags.public === true;
  const dryRun = parsed.flags["dry-run"] === true;

  try {
    // W24.2 — emit the declaration witness. The publish wire (W3.1)
    // will chain off this same receipt id. Selector overload: pass
    // the skill-id (helper sha256-hashes it) so the witness binds to
    // which skill was declared without putting the cleartext id in
    // KV. urlHash carries the optional domain override.
    const declareAudit = await emitBreathActStateless({
      sessionId: skillId,
      actType: "build-skill",
      selector: skillId,
      currentUrl: domain ?? "",
    });

    emit(
      {
        ok: true,
        subcommand: "build skill",
        op_kind: meta.op_kind,
        skill_id: skillId,
        domain,
        public: isPublic,
        dry_run: dryRun,
        // Wire reality: the publish path is W3.1 territory. The witness
        // above IS the act today; the publish row chains off it later.
        pending_publish_wave: "W3.1",
        audit: declareAudit.skipped
          ? false
          : {
              ok: declareAudit.ok,
              idempotent: declareAudit.idempotent,
              binding_missing: declareAudit.bindingMissing,
              receipt_id: declareAudit.receiptId,
              cache_key: declareAudit.cacheKey,
              variant: "act-act",
              act_type: "build-skill",
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
