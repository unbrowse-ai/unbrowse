#!/usr/bin/env node
// Codegen: render markdown docs to HTML string constants importable from
// server components. Bypasses runtime fs reads, which opennextjs-cloudflare
// worker bundling silently drops (observed 2026-05-27, see commit message
// of the fix that introduced this script).
//
// Add new entries to the DOCS array. The generated TS files live under
// frontend/src/lib/generated/*.html.ts and are imported by the matching page.
//
// Run from frontend/: `node scripts/codegen-docs.mjs`
// Wire into build by adding a `predeploy` or `prebuild` script in package.json
// that invokes this file.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

const REPO_ROOT = resolve(process.cwd(), "..");
const OUT_DIR = resolve(process.cwd(), "src/lib/generated");

const DOCS = [
	{
		md: resolve(REPO_ROOT, "docs/HOW_UNBROWSE_PAYS.md"),
		out: resolve(OUT_DIR, "how-unbrowse-pays.html.ts"),
		exportName: "HOW_UNBROWSE_PAYS_HTML",
	},
];

mkdirSync(OUT_DIR, { recursive: true });

for (const { md, out, exportName } of DOCS) {
	const src = readFileSync(md, "utf8");
	const html = micromark(src, {
		extensions: [gfm()],
		htmlExtensions: [gfmHtml()],
	});
	const ts =
		`// Auto-generated from ${md.replace(REPO_ROOT + "/", "")} by frontend/scripts/codegen-docs.mjs.\n` +
		`// Inlined to bypass runtime fs reads in opennextjs-cloudflare worker bundling.\n` +
		`// To refresh: node frontend/scripts/codegen-docs.mjs\n` +
		`export const ${exportName}: string = ${JSON.stringify(html)};\n`;
	writeFileSync(out, ts);
	console.log(`wrote ${out.replace(REPO_ROOT + "/", "")} (${html.length} bytes)`);
}
