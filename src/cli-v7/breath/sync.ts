import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { api, output } from "../_shared/cli-runtime.js";
async function cmdSync(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/sync", typeof flags.session === "string" ? { session_id: flags.session } : undefined), !!flags.pretty);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdSync(flags);
}
