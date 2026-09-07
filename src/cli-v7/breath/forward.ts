import type { ParsedV7Args } from "../args.js";
import { emit, type OutputOptions } from "../output.js";
import { api, output } from "../_shared/cli-runtime.js";
import { resolveSession } from "../_session.js";
import { isObscuraSession, obscuraClient, isObscuraNull } from "../../obscura/live-page.js";

/**
 * `unbrowse breath forward` — history forward. Mirror of `breath back`: an
 * obscura session is driven locally through `browser_forward` (no server hop,
 * no Chrome); the kuri/Chrome path keeps POSTing `/v1/browse/forward`.
 */
async function cmdForward(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/forward", typeof flags.session === "string" ? { session_id: flags.session } : undefined), false);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const rec = await resolveSession(sessionFlag).catch(() => null);
  if (rec && isObscuraSession(rec)) {
    const client = obscuraClient(rec);
    await client.forward();
    const href = await client.evaluate("location.href").catch(() => "");
    emit(
      {
        ok: true,
        subcommand: "breath forward",
        session_id: rec.sessionId,
        backend: "obscura",
        url: isObscuraNull(href) ? "" : href.trim(),
      },
      opts,
    );
    process.exit(0);
  }

  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdForward(flags);
}
