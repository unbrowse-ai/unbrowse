/**
 * `unbrowse build index` — shim delegating to the v6 `cmdIndex`.
 *
 * Named `idx.ts` (not `index.ts`) so it does not collide with the verb
 * router at `build/index.ts`. Registered under the table key "index".
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { api, die, output } from "../_shared/cli-runtime.js";

async function cmdIndex(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  output(await api("POST", `/v1/skills/${skillId}/index`, {}), !!flags.pretty);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdIndex(flags);
}
