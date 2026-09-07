/**
 * `unbrowse schema <command>` — typed self-description for ONE command.
 *
 * The introspection layer of the progressive-help ladder: top-level --help
 * lists commands, `<command> --help` shows usage + flags, and `schema`
 * returns the same surface as pure data (op_kind, MCP tool mapping, arg
 * surface, exit codes) for agents that want the contract without prose.
 * Everything is read from KIND_MAP — the single source of truth — so this
 * command cannot drift from the dispatch.
 */
import { KIND_MAP, flatCommandVerb, type KindMapEntry } from "../kind-map.js";
import { emit, EX_USAGE, type OutputOptions } from "../output.js";
import type { ParsedV7Args } from "../args.js";
import type { VerbHandler } from "../router.js";

const EXIT_CODES = {
  "0": "success (including --help)",
  "1": "runtime failure",
  "64": "usage error",
  "70": "not implemented",
} as const;

function findRow(target: string): KindMapEntry | undefined {
  if (target.includes(" ")) {
    return KIND_MAP.find((r) => r.subcommand === target);
  }
  const verb = flatCommandVerb(target);
  if (verb) return KIND_MAP.find((r) => r.subcommand === `${verb} ${target}`);
  return KIND_MAP.find(
    (r) => r.action === target || r.action.replace(/_/g, "-") === target,
  );
}

export const handler: VerbHandler = async (
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<void> => {
  const target = (parsed.positional[0] ?? "").trim();
  if (!target) {
    emit(
      {
        ok: false,
        error: "command_required",
        code: "command_required",
        usage: "unbrowse schema <command>",
        known_commands: KIND_MAP.map((r) => r.action.replace(/_/g, "-")).sort(),
      },
      opts,
    );
    process.exit(EX_USAGE);
  }
  const row = findRow(target);
  if (!row) {
    emit(
      {
        ok: false,
        error: "unknown_command",
        code: "unknown_command",
        command: target,
        hint: "Pass a flat command name (resolve, execute, …) or the full \"<verb> <cap>\" form.",
        known_commands: KIND_MAP.map((r) => r.action.replace(/_/g, "-")).sort(),
      },
      opts,
    );
    process.exit(EX_USAGE);
  }
  emit(
    {
      ok: true,
      schema: true,
      subcommand: row.subcommand,
      op_kind: row.op_kind,
      verb: row.verb,
      op_class: row.op_class,
      mcp_tool: row.mcp_tool,
      summary: row.summary,
      cli: row.cli ?? null,
      exit_codes: EXIT_CODES,
    },
    opts,
  );
  process.exit(0);
};
