/**
 * `unbrowse build review` — shim delegating to the v6 `cmdReview`.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { api, die, output } from "../_shared/cli-runtime.js";

async function cmdReview(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  const endpointsJson = flags.endpoints as string;
  if (!endpointsJson) die("--endpoints is required (JSON array of {endpoint_id, description?, action_kind?, resource_kind?, parameter_reviews?, response_reviews?})");
  const endpoints = JSON.parse(endpointsJson) as Array<Record<string, unknown>>;
  if (!Array.isArray(endpoints) || endpoints.length === 0) die("--endpoints must be a non-empty JSON array");
  output(await api("POST", `/v1/skills/${skillId}/review`, { endpoints }), !!flags.pretty);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdReview(flags);
}
