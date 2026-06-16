/**
 * `unbrowse eval config` — shim delegating to the v6 `cmdConfig`.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { cmdConfig } from "../../cli.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdConfig(parsed.positional, flags);
}
