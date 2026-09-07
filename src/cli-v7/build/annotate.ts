/**
 * `unbrowse build annotate` — shim delegating to the v6 `cmdAnnotate`.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { api, die, output } from "../_shared/cli-runtime.js";

async function cmdAnnotate(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  const endpointId = flags.endpoint as string;
  if (!skillId || !endpointId) die("--skill and --endpoint are required");

  const body: Record<string, unknown> = {};

  if (flags.text) {
    body.annotations = [{ text: flags.text as string }];
  }

  if (flags.constraint) {
    const parts = (flags.constraint as string).split(":");
    if (parts.length >= 3) {
      body.constraints = [{ param: parts[0], rule: parts[1], message: parts.slice(2).join(":") }];
    }
  }

  if (!body.annotations && !body.constraints) die("--text or --constraint required");

  output(await api("POST", `/v1/skills/${skillId}/endpoints/${endpointId}/annotate`, body), !!flags.pretty);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdAnnotate(flags);
}
