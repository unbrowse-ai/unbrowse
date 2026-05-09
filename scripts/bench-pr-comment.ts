#!/usr/bin/env bun
/**
 * bench-pr-comment — emit a markdown table comparing current bench evidence
 * against an optional baseline JSON snapshot.
 *
 * Usage:
 *   bun scripts/bench-pr-comment.ts --evidence .bench-local/evidence.csv \
 *       [--base .bench-history/<base-sha>.json]
 *
 * Mustard-seed Tier 1 of plan-v15. Full PR-comment workflow lives in Step 6.
 */

import fs from "node:fs";

type Row = { url: string; verdict: string; goal?: string };

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  const idxUrl = header.indexOf("url");
  const idxVerdict = header.indexOf("verdict");
  const idxGoal = header.indexOf("goal");
  if (idxUrl < 0 || idxVerdict < 0) {
    throw new Error(
      `evidence csv missing required columns; got header: ${header.join(",")}`,
    );
  }
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    rows.push({
      url: cells[idxUrl] ?? "",
      verdict: cells[idxVerdict] ?? "",
      goal: idxGoal >= 0 ? cells[idxGoal] : undefined,
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuote = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

const PASS_SHAPES = new Set([
  "PASS",
  "PASS_WEAK",
  "PASS_DOM_FALLBACK_ONLY",
]);
const FAIL_SHAPES = new Set([
  "PRODUCT_FAIL",
  "BROWSER_BLOCK",
  "SPARSE_REVIEW",
]);

function isPass(v: string | undefined): boolean {
  if (!v) return false;
  return PASS_SHAPES.has(v) || v.startsWith("PASS");
}

function isFail(v: string | undefined): boolean {
  if (!v) return false;
  return FAIL_SHAPES.has(v) || v.startsWith("PRODUCT_FAIL");
}

function isWin(base: string | undefined, head: string): boolean {
  if (!base || base === "—") return false;
  return isFail(base) && isPass(head);
}

function isRegression(base: string | undefined, head: string): boolean {
  if (!base || base === "—") return false;
  return isPass(base) && isFail(head);
}

function main() {
  const args = parseFlags(process.argv.slice(2));
  const evidencePath = args.evidence ?? ".bench-local/evidence.csv";
  const basePath = args.base;

  if (!fs.existsSync(evidencePath)) {
    console.error(`evidence file not found: ${evidencePath}`);
    process.exit(2);
  }

  const head = parseCsv(fs.readFileSync(evidencePath, "utf8"));

  let baseRows: Row[] = [];
  if (basePath && fs.existsSync(basePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(basePath, "utf8"));
      baseRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    } catch (err) {
      console.error(`could not parse base ${basePath}: ${(err as Error).message}`);
    }
  }

  const baseByUrl = new Map<string, string>(
    baseRows.map((r) => [r.url, r.verdict]),
  );

  const rows = head.map((r) => {
    const base = baseByUrl.get(r.url);
    let delta = "=";
    if (!base) delta = "=";
    else if (base === r.verdict) delta = "=";
    else if (isWin(base, r.verdict)) delta = "⬆";
    else if (isRegression(base, r.verdict)) delta = "⬇";
    else delta = "=";
    return {
      url: r.url,
      base: base ?? "—",
      head: r.verdict,
      delta,
    };
  });

  const lines: string[] = [];
  lines.push("| URL | base | head | Δ |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(`| ${r.url} | ${r.base} | ${r.head} | ${r.delta} |`);
  }

  const wins = rows.filter((r) => r.delta === "⬆").length;
  const regressions = rows.filter((r) => r.delta === "⬇").length;
  const headNonBlocked = head.filter(
    (r) => r.verdict && !r.verdict.includes("BROWSER_BLOCK"),
  );
  const headPass = headNonBlocked.filter((r) => isPass(r.verdict)).length;
  const baseNonBlocked = baseRows.filter(
    (r) => r.verdict && !r.verdict.includes("BROWSER_BLOCK"),
  );
  const basePass = baseNonBlocked.filter((r) => isPass(r.verdict)).length;

  lines.push("");
  lines.push(
    `coverage: ${headPass}/${headNonBlocked.length} (was ${basePass}/${baseNonBlocked.length}) +${wins} wins, ${regressions} regressions`,
  );

  process.stdout.write(lines.join("\n") + "\n");
}

main();
