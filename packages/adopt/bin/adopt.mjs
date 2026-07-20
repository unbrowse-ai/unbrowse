#!/usr/bin/env node
/**
 * unbrowse-adopt — rewrite a repo's imports to the Unbrowse drop-ins, in place.
 *
 *   npx @unbrowse/adopt              # dry-run: show every swap as a diff, change nothing
 *   npx @unbrowse/adopt --write      # apply the swaps
 *   npx @unbrowse/adopt --write src  # limit to a subdir
 *
 * Adoption is by consent: run it on your own repo and review the diff (or review
 * the PR it generates). It never phones home and never touches package.json — it
 * only rewrites the import specifier, so you stay in control of installing the
 * @unbrowse/*-shim packages.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { adoptSource, summarize } from '../dist/index.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const root = args.find((a) => !a.startsWith('--')) || '.';
const EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts']);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (EXT.has(extname(p))) yield p;
  }
}

const results = [];
for (const path of walk(root)) {
  const src = readFileSync(path, 'utf8');
  const { source, rewrites } = adoptSource(src);
  if (rewrites.length) {
    results.push({ path, result: { source, rewrites } });
    for (const w of rewrites) console.log(`  ${path}:${w.line}  ${w.from} → ${w.to}`);
    if (write) writeFileSync(path, source);
  }
}

console.log('\n' + summarize(results));
if (!write && results.length) console.log('\n(dry-run — re-run with --write to apply)');
