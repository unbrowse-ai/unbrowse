#!/usr/bin/env node
/**
 * optimize-images.mjs — one-shot re-encode of the three landing-page
 * offenders identified in .editions-evidence/PERF-AUDIT.md.
 *
 * Reads sources from frontend/public/, writes optimized siblings with
 * `-optimized` suffix (AVIF primary, WebP fallback), at the intended
 * display size × 2 (retina). Reports per-asset byte savings.
 *
 * Originals stay on disk as backup; the optimized files are referenced
 * directly by the components after this script runs.
 *
 * Usage: node frontend/scripts/optimize-images.mjs
 */
import sharp from "sharp";
import { stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "..", "public");

// width = intended retina width (display × 2). Keep aspect ratio (no height).
const TARGETS = [
  // Navbar + chat-demo logo. Rendered 28×28 (nav) and 18×18 (chat).
  // Retina max: 56px. Source is a square logo.
  { src: "logo.png",                  outBase: "logo-optimized",          width: 96, fit: "inside" },
  // Saint Matthew: rendered ~300px wide (CRT-filtered parallax).
  // Retina: 600px. Source is portrait orientation.
  { src: "images/saint-matthew.png",  outBase: "images/saint-matthew-optimized", width: 600, fit: "inside" },
  // Angel: rendered up to 384px wide (sm:w-96).
  // Retina: 768px. Source is landscape.
  { src: "images/angel.webp",         outBase: "images/angel-optimized",  width: 768, fit: "inside" },
];

function pad(n, w = 8) {
  return String(n).padStart(w);
}

async function main() {
  let totalOriginal = 0;
  let totalAvif = 0;
  let totalWebp = 0;

  for (const t of TARGETS) {
    const srcPath = resolve(PUBLIC, t.src);
    const avifPath = resolve(PUBLIC, `${t.outBase}.avif`);
    const webpPath = resolve(PUBLIC, `${t.outBase}.webp`);

    const srcStat = await stat(srcPath);
    totalOriginal += srcStat.size;

    const pipeline = sharp(srcPath).resize({ width: t.width, fit: t.fit, withoutEnlargement: true });

    await pipeline.clone().avif({ quality: 70, effort: 6 }).toFile(avifPath);
    await pipeline.clone().webp({ quality: 80, effort: 6 }).toFile(webpPath);

    const avifStat = await stat(avifPath);
    const webpStat = await stat(webpPath);
    totalAvif += avifStat.size;
    totalWebp += webpStat.size;

    console.log(`${t.src}`);
    console.log(`  original: ${pad(srcStat.size)} B`);
    console.log(`  avif:     ${pad(avifStat.size)} B  (${((1 - avifStat.size / srcStat.size) * 100).toFixed(1)}% smaller)`);
    console.log(`  webp:     ${pad(webpStat.size)} B  (${((1 - webpStat.size / srcStat.size) * 100).toFixed(1)}% smaller)`);
  }

  console.log("");
  console.log(`TOTAL original: ${(totalOriginal / 1024).toFixed(1)} KB`);
  console.log(`TOTAL avif:     ${(totalAvif / 1024).toFixed(1)} KB  (${((1 - totalAvif / totalOriginal) * 100).toFixed(1)}% saved)`);
  console.log(`TOTAL webp:     ${(totalWebp / 1024).toFixed(1)} KB  (${((1 - totalWebp / totalOriginal) * 100).toFixed(1)}% saved)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
