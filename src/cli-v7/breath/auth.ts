import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { api, die, info, output } from "../_shared/cli-runtime.js";
async function cmdLogin(flags: Record<string, string | boolean>, args: string[] = []): Promise<void> {
  const url = (flags.url as string | undefined) ?? args[0];
  if (!url) die("usage: unbrowse auth <url>");
  info("[unbrowse] Opening a visible browser for site login. Complete sign-in in the Chrome window; cookies will be saved for future runs.");
  output(await api("POST", "/v1/auth/login", { url, interactive_only: true }), !!flags.pretty);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdLogin(flags, parsed.positional);
}
