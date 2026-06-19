/**
 * `unbrowse research "<query>"` — native research primitive (Tavily parity):
 * search -> extract -> synthesized cited answer, on unbrowse's own machinery.
 * Emits {query, answer, citations[], results[]}.
 */
import type { ParsedV7Args } from "../args.js";
import type { OutputOptions } from "../output.js";
import { doResearch } from "../../orchestrator/research.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const query = (parsed.positional.join(" ") || String(parsed.flags.intent ?? parsed.flags.query ?? "")).trim();
  const numResults = Number(parsed.flags["num-results"] ?? parsed.flags.n ?? 5) || 5;
  const res = await doResearch(query, { numResults });

  if (opts.json || !opts.pretty) {
    process.stdout.write(JSON.stringify({ op_kind: "eval:research", ...res }) + "\n");
    return;
  }
  // pretty (human) rendering
  const lines: string[] = [];
  lines.push(`# research: ${res.query}`);
  lines.push("");
  lines.push(res.answer || "(no grounded answer — no sources fetched)");
  if (res.citations.length) {
    lines.push("");
    lines.push("## sources");
    res.citations.forEach((c, i) => lines.push(`[${i + 1}] ${c.title} — ${c.url}`));
  }
  process.stdout.write(lines.join("\n") + "\n");
}
