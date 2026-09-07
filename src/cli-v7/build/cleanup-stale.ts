/**
 * `unbrowse build cleanup-stale` — shim delegating to the v6 `cmdCleanupStale`.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { cmdCleanupStale } from "../../cli.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdCleanupStale(flags);
}
