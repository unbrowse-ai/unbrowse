/**
 * `unbrowse eval inspect` — shim delegating to the v6 `cmdInspect`.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { api, output } from "../_shared/cli-runtime.js";

async function cmdInspect(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const explicitSession = typeof flags.session === "string"
    ? flags.session
    : typeof args[0] === "string"
      ? args[0]
      : undefined;
  const sessions = await api("GET", "/v1/browse/sessions") as {
    sessions?: Array<Record<string, unknown>>;
    count?: number;
    latest_session_id?: string | null;
  };
  if (flags.all) {
    output(sessions, !!flags.pretty);
    return;
  }

  const latestSessionId = sessions.latest_session_id
    ?? (sessions.sessions?.at(-1)?.session_id as string | undefined);
  const sessionId = explicitSession ?? latestSessionId;
  if (!sessionId) {
    output({
      error: "no_active_session",
      message: "No active browse session to inspect.",
      next_action: {
        title: "Open a browser session",
        command: 'unbrowse go "https://example.com" --pretty',
        why: "Inspection reads live HAR/interceptor evidence from an active Kuri session.",
      },
    }, !!flags.pretty);
    return;
  }

  output(await api("GET", `/v1/browse/sessions/${encodeURIComponent(sessionId)}/buffer`), !!flags.pretty);
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const flags: Record<string, string | boolean> = { ...(parsed.flags as Record<string, string | boolean>) };
  if (opts.json) flags.json = true;
  if (opts.pretty) flags.pretty = true;
  await cmdInspect(parsed.positional, flags);
}
