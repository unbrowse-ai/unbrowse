/**
 * `unbrowse eval stats` — marketplace + earnings stats summary.
 *
 * 1:1 mapping (kind-map.ts row "eval stats"):
 *   CLI subcommand  : eval stats
 *   MCP tool        : unbrowse_stats
 *   Covenant kind   : observe_stats
 *   Verb            : eval
 *
 * Fetches `${UNBROWSE_API_URL || beta-api.unbrowse.ai}/v1/stats/summary`
 * and surfaces the raw response. Honors `--fresh` by attaching
 * `Cache-Control: no-cache` (so any CDN / KV cache between the CLI and
 * the worker is bypassed). Read-only; no audit POSTs.
 */
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { DEFAULT_BACKEND_URL } from "../../version.js";

function resolveApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    DEFAULT_BACKEND_URL
  );
}

export async function handler(
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<void> {
  const meta = lookupKindMap("eval", "stats")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval stats",
      {
        summary: "Marketplace + earnings stats summary (from /v1/stats/summary).",
        usage: "unbrowse eval stats [--fresh]",
        flags: [
          {
            name: "--fresh",
            description: "Bypass CDN / KV cache (Cache-Control: no-cache).",
          },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const fresh = parsed.flags.fresh === true;

  try {
    const base = resolveApiBase();
    const url = `${base}/v1/stats/summary`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (fresh) headers["cache-control"] = "no-cache";

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    let body: unknown;
    let status = 0;
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      status = r.status;
      try {
        body = await r.json();
      } catch {
        body = { error: "non_json_response", status };
      }
    } finally {
      clearTimeout(t);
    }

    emit(
      {
        ok: status >= 200 && status < 300,
        subcommand: "eval stats",
        covenant_kind: meta.covenant_kind,
        api_base: base,
        status_code: status,
        fresh,
        summary: body,
      },
      opts,
    );
    process.exit(status >= 200 && status < 300 ? 0 : EX_GENERIC);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
