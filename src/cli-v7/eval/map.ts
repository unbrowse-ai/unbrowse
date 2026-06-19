/**
 * `unbrowse map <url>` — native Tavily `/map` parity: resolve a URL hole to its POINTERS
 * (outgoing absolute links), via the same cached read step. Emits
 * {op_kind:"eval:map", url, links:[{url,text}]}.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { doMap } from "../../orchestrator/research.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const url = (parsed.positional[0] || String(parsed.flags.url ?? "")).trim();
  const res = await doMap(url);

  if (opts.json || !opts.pretty) {
    process.stdout.write(JSON.stringify({ op_kind: "eval:map", ...res }) + "\n");
    return;
  }
  const lines = [`# map: ${res.url}  (${res.links.length} links)`];
  for (const l of res.links) lines.push(`- ${l.text || "(link)"} — ${l.url}`);
  process.stdout.write((lines.join("\n") || "(no links)") + "\n");
}
