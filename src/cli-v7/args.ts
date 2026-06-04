/**
 * v7 CLI arg parser. Custom inline parser matching v6's convention
 * (see src/cli.ts:parseArgs) — v6 ships no external arg-parsing
 * dependency and v7 inherits the same posture. No new deps.
 *
 * v7's parser is intentionally simpler than v6's: three verbs
 * (build / act / eval) with one subcommand each, then a small
 * set of positional args + flat --flag=value flags. Flags are kept
 * machine-readable; --json is the universal output toggle.
 */
export interface ParsedV7Args {
  /** First positional, e.g. "build" | "act" | "eval" | "help" | "--help" | "" */
  verb: string;
  /** Second positional, the subcommand (e.g. "fill", "snap"). */
  sub: string;
  /** Remaining positionals after verb + sub. */
  positional: string[];
  /** --flag / --flag=value / --flag value. Booleans are `true`. */
  flags: Record<string, string | boolean>;
  /** Convenience: `--help` / `-h` was present. */
  wantsHelp: boolean;
  /** Convenience: `--json` was present (machine-readable output). */
  wantsJson: boolean;
}

/**
 * Flags that always consume the following arg as a string value, even
 * when the next token starts with `-` or `--` (covers pointer URIs like
 * `--value arg://...` and negative integers).
 */
const VALUE_EXPECTED_FLAGS = new Set([
  "value",
  "pointer",
  "selector",
  "url",
  "intent",
  "domain",
  "session",
  "session-id",
  "skill",
  "skill-id",
  "endpoint",
  "endpoint-id",
  "text",
  "key",
  "name",
  "format",
  "limit",
  "depth",
  "max-depth",
  "timeout",
  "output",
  "params",
  "argScope",
  "arg-scope",
  "arg",
]);

export function parseV7Args(argv: string[]): ParsedV7Args {
  // argv shape from process.argv: [node, script, verb, sub, ...]
  // BUT this module receives the post-runtime slice (caller does argv.slice(2)).
  const tokens = argv;
  const verb = (tokens[0] && !tokens[0].startsWith("-")) ? tokens[0] : "";
  const sub = (tokens[1] && !tokens[1].startsWith("-")) ? tokens[1] : "";
  const start = (sub ? 2 : (verb ? 1 : 0));
  const rest = tokens.slice(start);

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--") {
      // Everything after `--` is positional.
      for (let j = i + 1; j < rest.length; j++) positional.push(rest[j]);
      break;
    }
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = rest[i + 1];
      if (VALUE_EXPECTED_FLAGS.has(body) && next !== undefined) {
        flags[body] = next;
        i++;
      } else if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // Single-char short flag; v7 supports -h, -j as canonical aliases.
      const short = tok.slice(1);
      if (short === "h") flags.help = true;
      else if (short === "j") flags.json = true;
      else flags[short] = true;
      continue;
    }
    positional.push(tok);
  }

  return {
    verb,
    sub,
    positional,
    flags,
    wantsHelp: flags.help === true || flags.h === true,
    wantsJson: flags.json === true || flags.j === true,
  };
}
