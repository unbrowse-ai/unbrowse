/**
 * `unbrowse eval inspect` — shim delegating to the v6 `cmdInspect`.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { cmdInspect } from "../../cli.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdInspect(parsed.positional, flags);
}
