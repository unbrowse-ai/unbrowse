/**
 * `unbrowse build publish-bundle` — shim delegating to the v6 `cmdPublishBundle`.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { api, die, output } from "../_shared/cli-runtime.js";

async function cmdPublishBundle(flags: Record<string, string | boolean>): Promise<void> {
  const presetPath = flags.preset as string;
  if (!presetPath) die("--preset is required");
  const hosts = typeof flags.hosts === "string"
    ? flags.hosts.split(",").map((host) => host.trim()).filter(Boolean)
    : undefined;
  output(await api("POST", "/v1/foundry/publish-bundle", {
    preset_path: presetPath,
    ...(typeof flags["site-url"] === "string" ? { site_url: flags["site-url"] } : {}),
    ...(hosts?.length ? { hosts } : {}),
  }), !!flags.pretty);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdPublishBundle(flags);
}
