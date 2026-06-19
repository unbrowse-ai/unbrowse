/**
 * `unbrowse crawl <url> [--max-pages N]` — native Tavily `/crawl` parity: map the seed's
 * same-domain links and read each (bounded, cached). Emits
 * {op_kind:"eval:crawl", seed, pages:[{url,title,content,...}]}.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { doCrawl } from "../../orchestrator/research.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const seed = (parsed.positional[0] || String(parsed.flags.url ?? "")).trim();
  const maxPages = Number(parsed.flags["max-pages"] ?? parsed.flags.n ?? 5) || 5;
  const res = await doCrawl(seed, { maxPages });

  if (opts.json || !opts.pretty) {
    process.stdout.write(JSON.stringify({ op_kind: "eval:crawl", ...res }) + "\n");
    return;
  }
  const lines = [`# crawl: ${res.seed}  (${res.pages.length} pages)`];
  for (const p of res.pages) lines.push(`- ${p.title || p.url} — ${p.url}`);
  process.stdout.write((lines.join("\n") || "(no pages)") + "\n");
}
