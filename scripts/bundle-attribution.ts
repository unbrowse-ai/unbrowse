#!/usr/bin/env bun
/**
 * bundle-attribution.ts — VLQ-decode a sourcemap to show TRUE per-source
 * bundle bytes (not sourcesContent bytes, which is the input to the bundler
 * pre-tree-shaking).
 *
 * Why this exists: a previous attempt at byte attribution used
 * `map.sourcesContent[i].length` — that's the source TEXT, not the bundled
 * output. Functions that Bun's tree-shaker eliminates appear in
 * sourcesContent at full size but contribute zero bundle bytes. This script
 * is the falsifying instrument: it walks the VLQ mappings and sums the
 * output spans actually attributed to each source file.
 *
 * Output is a viewer, not a judge. Prints sorted rows; the agent reads them.
 *
 * Usage:
 *   bun scripts/bundle-attribution.ts                                # default: server.js
 *   bun scripts/bundle-attribution.ts packages/skill/dist-sm/index.js
 *   bun scripts/bundle-attribution.ts --rebuild                      # rebuild default + run
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const REBUILD = args.includes("--rebuild");
const DEFAULT_BUNDLE = path.join(import.meta.dir, "..", "packages", "skill", "dist-sm", "index.js");
const bundlePath = args.filter((a) => !a.startsWith("--"))[0] ?? DEFAULT_BUNDLE;
const mapPath = bundlePath + ".map";

const isDefault = path.resolve(bundlePath) === path.resolve(DEFAULT_BUNDLE);

// Auto-rebuild only when targeting the default bundle. Refuse to rebuild for
// arbitrary user-supplied paths — otherwise "wrong file passed" would silently
// rebuild the default and produce confusing attribution.
if (isDefault && (REBUILD || !existsSync(mapPath))) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const outDir = path.join(repoRoot, "packages", "skill", "dist-sm");
  console.log("[bundle-attribution] building default bundle with sourcemap...");
  execFileSync(
    "bun",
    [
      "build", "--target", "node", "--format", "esm", "--packages", "external",
      path.join(repoRoot, "src", "index.ts"),
      "--outdir", outDir,
      "--sourcemap=external",
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
}

if (!existsSync(bundlePath)) {
  console.error(`bundle not found: ${bundlePath}`);
  if (!isDefault) {
    console.error("(no auto-rebuild for non-default paths — pass an existing bundle, or omit the arg for the default)");
  }
  process.exit(1);
}
if (!existsSync(mapPath)) {
  console.error(`sourcemap not found: ${mapPath}`);
  console.error("(this script needs a co-located .map file with VLQ mappings)");
  process.exit(1);
}

let map: { sources: string[]; mappings: string; sourcesContent?: (string | null)[] };
try {
  map = JSON.parse(readFileSync(mapPath, "utf8"));
} catch (err) {
  console.error(`sourcemap JSON parse failed: ${(err as Error).message}`);
  console.error(`(file: ${mapPath})`);
  process.exit(1);
}
if (!Array.isArray(map.sources) || typeof map.mappings !== "string") {
  console.error(`sourcemap missing required fields (sources: string[], mappings: string)`);
  console.error(`(file: ${mapPath})`);
  process.exit(1);
}

// VLQ base64 decoder.
const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_LOOKUP: Record<string, number> = {};
for (let i = 0; i < VLQ_CHARS.length; i++) VLQ_LOOKUP[VLQ_CHARS[i]!] = i;

function decodeVLQ(str: string): number[] {
  const out: number[] = [];
  let shift = 0, value = 0;
  for (let i = 0; i < str.length; i++) {
    const digit = VLQ_LOOKUP[str[i]!]!;
    const cont = (digit & 32) !== 0;
    value |= (digit & 31) << shift;
    if (cont) {
      shift += 5;
    } else {
      const negative = (value & 1) !== 0;
      value >>= 1;
      out.push(negative ? -value : value);
      shift = 0;
      value = 0;
    }
  }
  return out;
}

const bundle = readFileSync(bundlePath, "utf8");
const lines = bundle.split("\n");

function bundleOffset(line: number, col: number): number {
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) offset += lines[i]!.length + 1; // +1 for \n
  return offset + col;
}

let sourceIdx = 0;
const bytesPerSource = new Array<number>(map.sources.length).fill(0);

let prevLineInBundle = 0;
let prevColInBundle = 0;
let prevSourceIdx = -1; // -1 means "no active mapping"

function flushSpan(curLine: number, curCol: number): void {
  if (prevSourceIdx < 0) return;
  if (prevSourceIdx >= bytesPerSource.length) return;
  const startOff = bundleOffset(prevLineInBundle, prevColInBundle);
  const endOff = bundleOffset(curLine, curCol);
  if (endOff > startOff) {
    bytesPerSource[prevSourceIdx]! += endOff - startOff;
  }
}

// Parse mappings line-by-line (semicolons separate output lines).
const mappingLines = map.mappings.split(";");
for (let lineNum = 0; lineNum < mappingLines.length; lineNum++) {
  const lineStr = mappingLines[lineNum]!;
  let absCol = 0;
  if (lineStr.length === 0) {
    if (prevSourceIdx >= 0) {
      flushSpan(lineNum, 0);
      prevLineInBundle = lineNum;
      prevColInBundle = 0;
    }
    continue;
  }
  for (const segStr of lineStr.split(",")) {
    if (!segStr) continue;
    const seg = decodeVLQ(segStr);
    if (seg.length === 0) continue;
    absCol += seg[0]!;

    if (prevSourceIdx >= 0) {
      flushSpan(lineNum, absCol);
    }
    if (seg.length >= 4) {
      sourceIdx += seg[1]!;
      prevSourceIdx = sourceIdx;
      prevLineInBundle = lineNum;
      prevColInBundle = absCol;
    } else {
      prevSourceIdx = -1;
    }
  }
}

if (prevSourceIdx >= 0) {
  const lastLine = lines.length - 1;
  const lastCol = lines[lastLine]?.length ?? 0;
  flushSpan(lastLine, lastCol);
}

const total = bytesPerSource.reduce((a, b) => a + b, 0);
const rows = map.sources.map((src, i) => ({ src, bytes: bytesPerSource[i]! }));
rows.sort((a, b) => b.bytes - a.bytes);

const bundleSize = statSync(bundlePath).size;
console.log(`bundle: ${bundlePath}`);
console.log(`bundle size: ${bundleSize} bytes (${(bundleSize / 1024).toFixed(1)} KB)`);
console.log(`mappings attribute: ${total} bytes (${(total / bundleSize * 100).toFixed(1)}% of bundle)`);
console.log(`unattributed: ${bundleSize - total} bytes (whitespace, imports, runtime glue)`);
console.log(`sources: ${rows.length}`);
console.log("");
console.log("Top contributors by BUNDLE bytes (post-tree-shake):");
console.log("");
for (let i = 0; i < Math.min(20, rows.length); i++) {
  const r = rows[i]!;
  const pct = (r.bytes / bundleSize * 100).toFixed(1);
  const kb = (r.bytes / 1024).toFixed(1);
  console.log(`  ${String(i + 1).padStart(2)}. ${kb.padStart(7)} KB  ${pct.padStart(4)}%  ${r.src}`);
}
console.log("");
console.log("Agent: read the numbers above. These are TRUE bundle bytes, not sourcesContent.");
console.log("A source with high sourcesContent but low bundle bytes is being tree-shaken.");
console.log("To shrink the bundle, target sources high in the list above — they're reachable.");
