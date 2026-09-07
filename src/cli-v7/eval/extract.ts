/**
 * `unbrowse extract <url> [url2 ...]` — native Tavily `/extract` parity: fetch each URL via
 * unbrowse's own document path and return clean content + raw markdown per URL.
 * Emits {op_kind:"eval:extract", results:[{url,title,content,raw_content,ok}]}.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { doExtract } from "../../orchestrator/research.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const urls = parsed.positional.length
    ? parsed.positional
    : String(parsed.flags.url ?? parsed.flags.urls ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const { results } = await doExtract(urls);

  if (opts.json || !opts.pretty) {
    process.stdout.write(JSON.stringify({ op_kind: "eval:extract", results }) + "\n");
    return;
  }
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`# ${r.title || r.url}  (${r.ok ? "ok" : "failed"})`);
    lines.push(r.url);
    if (r.content) lines.push("", r.content.slice(0, 2000));
    lines.push("");
  }
  process.stdout.write((lines.join("\n") || "(no urls)") + "\n");
}
