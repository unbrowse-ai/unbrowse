#!/usr/bin/env bun
/**
 * v7 CLI entry. Parse argv → dispatch to verb router.
 *
 * v7 lives in its own subtree under src/cli-v7/. The v6 surface
 * (src/cli.ts) continues to exist unchanged as the v6.x release
 * artifact; v7 has no aliases.
 *
 * The wave-3 scaffold lands argument parsing + dispatch tables +
 * stub-or-help handlers ONLY. Real CDP calls live behind W1 (src/cdp/),
 * value-store dereferences live behind W2 (src/values/). Wiring up
 * MCP tools to the v7 dispatch is a later wave's work.
 */
import { parseV7Args } from "./args.js";
import { dispatchVerb } from "./router.js";
import { emitErr, EX_GENERIC, type OutputOptions } from "./output.js";

export async function runV7(argv: string[]): Promise<void> {
  const parsed = parseV7Args(argv.slice(2));
  const opts: OutputOptions = {
    json: parsed.wantsJson,
    pretty: parsed.flags.pretty === true,
  };
  try {
    await dispatchVerb(parsed, opts);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}

// CLI entry guard — only run when invoked directly, not when imported
// (the wiring wave will import the verb routers from MCP handlers and
// must not re-trigger argv parsing).
const invokedDirectly = (() => {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  // Bun + Node both expose import.meta.url for ESM entry detection.
  try {
    const entry = process.argv[1];
    // Crude but reliable: if the script path's basename matches our
    // module's filename, treat as direct invocation.
    return /\/cli-v7\/index\.(t|j)s$/.test(entry) || /\bunbrowse-v7\b/.test(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void runV7(process.argv);
}
