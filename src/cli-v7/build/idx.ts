/**
 * `unbrowse build index` — shim delegating to the v6 `cmdIndex`.
 *
 * Named `idx.ts` (not `index.ts`) so it does not collide with the verb
 * router at `build/index.ts`. Registered under the table key "index".
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { cmdIndex } from "../../cli.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdIndex(flags);
}
