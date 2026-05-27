#!/usr/bin/env bun
// bench-reextract.ts — re-run evidence extraction on existing .out files
// without re-executing the CLI. Used to validate the JSON extractor and
// to rebuild results.jsonl after an extractor fix without paying the
// bench wall-clock again.
//
// Usage: bun scripts/bench-reextract.ts <bench-dir>
//
// Reads <bench-dir>/index.txt (if present) for probe metadata; otherwise
// walks <bench-dir>/*.out and parses the file name for (idx, slug).

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { extractEvidence } from "./bench-run";

const dir = process.argv[2];
if (!dir) { console.error("usage: bun scripts/bench-reextract.ts <bench-dir>"); process.exit(1); }
const files = readdirSync(dir).filter(f => f.endsWith(".out")).sort((a, b) => parseInt(a) - parseInt(b));
const out = resolvePath(dir, "results.jsonl");
writeFileSync(out, "");
let total = 0;
for (const f of files) {
  const raw = readFileSync(resolvePath(dir, f), "utf8");
  const idx = parseInt(f.split("_")[0], 10);
  // Try to recover intent/url from manifest or from the "[bench-local]" log line; fall back to slug.
  const m = raw.match(/\[(?:bench-local|bench-run)\][^\n]*?(https?:\/\/[^\s]+)/);
  const url = m?.[1] || f;
  const intent = "?"; // re-extract doesn't know — judge by URL.
  const record = extractEvidence(raw, { idx, intent, url, auth: "none", lane: "" }, 0);
  require("node:fs").appendFileSync(out, JSON.stringify(record) + "\n");
  total++;
  const tag = record.has_available_operations ? `ops=${record.n_operations} src=${record.source}` :
              record.error_code ? `err=${record.error_code}` : "no-ops";
  console.error(`${idx} ${tag} :: ${url}`);
}
console.error(`re-extracted ${total} probes → ${out}`);
