import type { ParsedV7Args } from "../args.js";
import { emit, type OutputOptions } from "../output.js";
import { api, output } from "../_shared/cli-runtime.js";
import { resolveSession } from "../_session.js";
import { isObscuraSession, obscuraClient, isObscuraNull } from "../../obscura/live-page.js";

/**
 * `unbrowse breath back` — history back.
 *
 * Two backends. The kuri/Chrome path POSTs the server's `/v1/browse/back`
 * (that session lives in the broker there). An obscura session lives LOCALLY —
 * the CLI holds its broker endpoint in the session record — so it is driven
 * directly through `browser_back`: no server round-trip, no Chrome.
 * Resolution failures fall through to the server path, which owns that error
 * shape already.
 */
async function cmdBack(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/back", typeof flags.session === "string" ? { session_id: flags.session } : undefined), false);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const rec = await resolveSession(sessionFlag).catch(() => null);
  if (rec && isObscuraSession(rec)) {
    const client = obscuraClient(rec);
    await client.back();
    const href = await client.evaluate("location.href").catch(() => "");
    emit(
      {
        ok: true,
        subcommand: "breath back",
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
  await cmdBack(flags);
}
