/**
 * v7 dispatch router. Top-level verb → verb-router module.
 *
 * The verb routers (build/index.ts, breath/index.ts, eval/index.ts) own
 * their subcommand dispatch tables; this file is just the verb-level
 * branch.
 */
import type { ParsedV7Args } from "./args.js";
import { emit, EX_USAGE, helpExit, type OutputOptions } from "./output.js";
import { KIND_MAP } from "./kind-map.js";

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
        build: "Declare patterns — skills, templates, value-sources (Father / KindSpec emission).",
        breath: "Runtime animation — navigate, fill, click, execute (Spirit / side-effectful verbs).",
        eval: "Read-only queries — snap, resolve, status, version (Son / witness).",
      },
      subcommands: KIND_MAP.map((e) => ({
        subcommand: e.subcommand,
        summary: e.summary,
        covenant_kind: e.covenant_kind,
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
        covenant_kind: `__verb_root__:${verbName}`,
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
