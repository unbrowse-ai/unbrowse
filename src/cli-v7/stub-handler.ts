/**
 * Shared stub-handler factory. Every v7 subcommand handler in W3 is
 * structurally identical:
 *
 *   1. If --help, emit the help block + exit EX_USAGE (64).
 *   2. Otherwise, validate required positionals (emit error + EX_USAGE
 *      on miss) — the parser already collected them.
 *   3. Action: exit EX_SOFTWARE (70) with `not_implemented_yet`.
 *
 * Real-impl waves (W1 CDP, W2 values, W3.1 build flows, MCP-wiring
 * wave) replace step 3 with the actual call. The arg-parsing +
 * help-block + 1:1 kind metadata is owned here.
 */
import type { ParsedV7Args } from "./args.js";
import { helpExit, notImplementedExit, emit, EX_USAGE, type OutputOptions } from "./output.js";
import { lookupKindMap, type V7Verb } from "./kind-map.js";

export interface StubSpec {
  readonly verb: V7Verb;
  readonly sub: string;
  readonly summary: string;
  readonly positional?: ReadonlyArray<{
    name: string;
    description: string;
    required?: boolean;
    /** If true, this positional carries a value pointer; the help block
     *  flags it so callers know to pass `op://` / `arg://` / etc. */
    is_pointer?: boolean;
  }>;
  readonly flags?: ReadonlyArray<{
    name: string;
    description: string;
    value_expected?: boolean;
    /** Marks the flag as carrying a value pointer (see positional.is_pointer). */
    is_pointer?: boolean;
  }>;
  /** Which sibling wave owns the real impl. Surfaced in not-implemented-yet output. */
  readonly pending_in?: string;
}

export function makeStub(spec: StubSpec) {
  return async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
    const meta = lookupKindMap(spec.verb, spec.sub);
    if (!meta) {
      emit(
        {
          error: "kind_map_drift",
          detail: `No KIND_MAP entry for "${spec.verb} ${spec.sub}". Update src/cli-v7/kind-map.ts.`,
        },
        opts,
      );
      process.exit(EX_USAGE);
    }
    const subcommand = `${spec.verb} ${spec.sub}`;
    const usage = renderUsage(subcommand, spec);

    if (parsed.wantsHelp) {
      helpExit(
        subcommand,
        {
          summary: spec.summary,
          usage,
          positional: spec.positional?.map((p) => ({
            name: p.name,
            description: p.is_pointer
              ? `${p.description} (pointer: op:// | keychain:// | bw:// | arg:// | <cleartext>)`
              : p.description,
            required: p.required ?? false,
          })),
          flags: spec.flags?.map((f) => ({
            name: f.name,
            description: f.is_pointer
              ? `${f.description} (pointer: op:// | keychain:// | bw:// | arg:// | <cleartext>)`
              : f.description,
            value_expected: f.value_expected ?? false,
          })),
          covenant_kind: meta.covenant_kind,
          mcp_tool: meta.mcp_tool,
          verb: spec.verb,
          not_implemented_yet: true,
        },
        opts,
      );
    }

    // Required-positional check (machine-readable error envelope).
    const required = (spec.positional ?? []).filter((p) => p.required);
    if (parsed.positional.length < required.length) {
      emit(
        {
          error: "missing_positional",
          subcommand,
          required: required.map((p) => p.name),
          got: parsed.positional,
          covenant_kind: meta.covenant_kind,
          hint: `Run \`unbrowse ${subcommand} --help\` for details.`,
        },
        opts,
      );
      process.exit(EX_USAGE);
    }

    // Not-yet-implemented action — honest exit code, honest envelope.
    notImplementedExit(
      subcommand,
      {
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: spec.verb,
        pending_in: spec.pending_in,
      },
      opts,
    );
  };
}

function renderUsage(subcommand: string, spec: StubSpec): string {
  const parts: string[] = [`unbrowse ${subcommand}`];
  for (const p of spec.positional ?? []) {
    parts.push(p.required ? `<${p.name}>` : `[${p.name}]`);
  }
  for (const f of spec.flags ?? []) {
    parts.push(f.value_expected ? `[${f.name} <value>]` : `[${f.name}]`);
  }
  return parts.join(" ");
}
