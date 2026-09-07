/**
 * v7 dispatch router. Top-level verb → verb-router module.
 *
 * The verb routers (build/index.ts, breath/index.ts, eval/index.ts) own
 * their subcommand dispatch tables; this file is just the verb-level
 * branch.
 */
import type { ParsedV7Args } from "./args.js";
import { emit, EX_USAGE, helpExit, type OutputOptions } from "./output.js";
import { KIND_MAP, oneEditAway, type KindMapEntry } from "./kind-map.js";

export type VerbHandler = (parsed: ParsedV7Args, opts: OutputOptions) => Promise<void>;

export interface VerbRouter {
  readonly verb: "build" | "breath" | "eval";
  /** Print the verb-level usage block to stdout + exit EX_USAGE. */
  readonly help: (opts: OutputOptions) => never;
  /** Dispatch parsed args (verb already stripped externally). */
  readonly dispatch: VerbHandler;
}

export async function dispatchVerb(
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<void> {
  if (parsed.verb === "" || parsed.verb === "help" || parsed.verb === "--help") {
    topLevelHelpExit(opts);
  }
  switch (parsed.verb) {
    case "build": {
      const { router } = await import("./build/index.js");
      return router.dispatch(parsed, opts);
    }
    case "breath": {
      const { router } = await import("./breath/index.js");
      return router.dispatch(parsed, opts);
    }
    case "eval": {
      const { router } = await import("./eval/index.js");
      return router.dispatch(parsed, opts);
    }
    default: {
      emit(
        {
          error: "unknown_verb",
          verb: parsed.verb,
          valid_verbs: ["build", "breath", "eval"],
          hint: "Run `unbrowse --help` for the full subcommand tree.",
        },
        opts,
      );
      process.exit(EX_USAGE);
    }
  }
}

export function topLevelHelpExit(opts: OutputOptions): never {
  emit(
    {
      help: true,
      tool: "unbrowse",
      surface: "v7",
      verbs: {
        build: "Declare patterns — skills, templates, value-sources (declarative ops).",
        breath: "Runtime animation — navigate, fill, click, execute (side-effectful ops).",
        eval: "Read-only queries — snap, resolve, status, version (observe ops).",
      },
      subcommands: KIND_MAP.map((e) => ({
        subcommand: e.subcommand,
        summary: e.summary,
        op_kind: e.op_kind,
        mcp_tool: e.mcp_tool,
      })),
      usage: "unbrowse <verb> <subcommand> [--flag value ...]",
      flags_global: [
        { name: "--help", description: "Print this help and exit 64." },
        { name: "--json", description: "Single-line JSON stdout (no pretty)." },
        { name: "--pretty", description: "Force pretty 2-space JSON stdout." },
      ],
    },
    opts,
  );
  process.exit(EX_USAGE);
}

/**
 * Helper for the per-verb routers: given the parsed args + the verb's
 * own dispatch table, route or print verb-help.
 */
export async function routeSub<HandlerArgs>(
  parsed: ParsedV7Args,
  opts: OutputOptions,
  table: Record<string, VerbHandler>,
  verbName: string,
): Promise<void> {
  if (parsed.wantsHelp && !parsed.sub) {
    helpExit(
      verbName,
      {
        summary: `${verbName} — ${verbName === "build" ? "declare patterns" : verbName === "breath" ? "animate the runtime" : "observe the runtime"}`,
        usage: `unbrowse ${verbName} <subcommand> [--flag value ...]`,
        positional: [{ name: "<subcommand>", description: "See subcommands below.", required: true }],
        flags: [{ name: "--help", description: "Print this help." }],
        op_kind: `__verb_root__:${verbName}`,
        mcp_tool: null,
        verb: verbName as "build" | "breath" | "eval",
      },
      opts,
    );
  }
  if (!parsed.sub) {
    emit(
      {
        error: "missing_subcommand",
        verb: verbName,
        valid_subcommands: Object.keys(table),
        hint: `Run \`unbrowse ${verbName} --help\` for details.`,
      },
      opts,
    );
    process.exit(EX_USAGE);
  }
  const sub = parsed.sub;
  const row: KindMapEntry | undefined = KIND_MAP.find(
    (e) =>
      e.subcommand === `${verbName} ${sub}` ||
      (e.verb === verbName &&
        (e.action === sub ||
          e.action.replace(/_/g, "-") === sub ||
          e.action.replace(/_/g, "-") === sub.replace(/_/g, "-"))),
  );
  // Flat-command help: `unbrowse auth --help` routes as breath/auth with
  // wantsHelp. Prefer KIND_MAP summary + flat usage over falling through
  // to a handler that only dies with "usage: …".
  // If the sub has no handler (e.g. removed harness verb), --help must not
  // fabricate a help page — surface unknown_subcommand instead.
  if (parsed.wantsHelp) {
    if (!table[parsed.sub!]) {
      emit(
        {
          error: "unknown_subcommand",
          verb: verbName,
          subcommand: parsed.sub,
          valid_subcommands: Object.keys(table),
        },
        opts,
      );
      process.exit(EX_USAGE);
    }
    const summary = row?.summary ?? `${verbName} ${sub}`;
    const flatName = sub;
    // Per-command arg surface comes from the kind-map row's `cli` block when
    // declared (single source of truth); the generic shape is only the
    // fallback for rows not yet annotated. Global flags are always appended.
    const globalFlags = [
      { name: "--help", description: "Print this help." },
      { name: "--json", description: "Machine-readable JSON stdout." },
      { name: "--pretty", description: "Pretty-print JSON stdout." },
    ];
    helpExit(
      flatName,
      {
        summary,
        usage: row?.cli?.usage ?? `unbrowse ${flatName} [args] [flags]`,
        positional: row?.cli
          ? [...(row.cli.positional ?? [])]
          : [{ name: "[args]", description: "See command docs / SKILL.md.", required: false }],
        flags: [...(row?.cli?.flags ?? []), ...globalFlags],
        op_kind: row?.op_kind ?? `${verbName}:${sub}`,
        mcp_tool: row?.mcp_tool ?? null,
        verb: verbName as "build" | "breath" | "eval",
      },
      opts,
    );
  }
  // Near-miss flag guard: a passed flag ONE edit away from a declared flag is
  // a typo, and typos on safety flags are dangerous — a misspelled --dry-run
  // is silently ignored and the mutation executes for real. Warn on stderr
  // (never reject: annotated lists may lag deep power flags, and a warning on
  // a real flag must stay impossible — exact matches and far names are silent).
  if (row?.cli?.flags?.length) {
    const declared = [
      ...row.cli.flags.map((f) => f.name.replace(/^--?/, "")),
      "help", "json", "pretty", "raw", "no-auto-start", "h", "j",
    ];
    const suspicious: Array<{ passed: string; did_you_mean: string }> = [];
    for (const passed of Object.keys(parsed.flags)) {
      if (declared.includes(passed)) continue;
      const near = declared.find((d) => oneEditAway(passed, d));
      if (near) suspicious.push({ passed: `--${passed}`, did_you_mean: `--${near}` });
    }
    if (suspicious.length) {
      process.stderr.write(
        JSON.stringify({
          warn: "unknown_flag",
          command: sub,
          flags: suspicious,
          hint: `Unknown flags are ignored — a misspelled safety flag (e.g. --dry-run) would NOT take effect. Run \`unbrowse ${sub} --help\` for the flag surface.`,
        }) + "\n",
      );
    }
  }
  const handler = table[parsed.sub];
  if (!handler) {
    emit(
      {
        error: "unknown_subcommand",
        verb: verbName,
        subcommand: parsed.sub,
        valid_subcommands: Object.keys(table),
      },
      opts,
    );
    process.exit(EX_USAGE);
  }
  return handler(parsed, opts);
}
