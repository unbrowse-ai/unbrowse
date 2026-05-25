/**
 * Walk the editions landing and screenshot every chapter for served-surface
 * verification. Per CLAUDE.md served-surface gate: a 200 + clean type-check
 * is NOT verification; we must observe the rendered output.
 */
import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";

const URL = process.env.LANDING_URL || "http://localhost:3200/";
const OUT_DIR = process.env.SCREENSHOT_DIR || ".bench-served-surface";

const CHAPTERS = [
  "hero",
  "thesis",
  "problem",
  "mechanism",
  "numbers",
  "install",
  "marketplace",
  "demo",
  "economics",
  "objections",
  "anti-icp",
];

await mkdir(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();

console.log(`opening ${URL}`);
await page.goto(URL, { waitUntil: "networkidle2", timeout: 45000 });

// Above-the-fold
await page.screenshot({ path: `${OUT_DIR}/00-above-fold.png`, fullPage: false });

// Computed body background — this is the cream-surface gate
const bg = await page.evaluate(() => {
  const el = document.body;
  return getComputedStyle(el).backgroundColor;
});
console.log(`body background: ${bg}`);

// Full page (one image, large)
await page.screenshot({ path: `${OUT_DIR}/01-full-page.png`, fullPage: true });

// Walk each chapter
const chapterReport = [];
for (const id of CHAPTERS) {
  const found = await page.$(`[data-chapter="${id}"]`);
  if (!found) {
    chapterReport.push({ id, present: false });
    continue;
  }
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-chapter="${id}"]`);
    if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
  }, id);
  // Let any IO-driven reveal fire + Lenis settle
  await new Promise((r) => setTimeout(r, 600));
  const box = await found.boundingBox();
  const bg = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el).backgroundColor;
  }, `[data-chapter="${id}"]`);
  await page.screenshot({
    path: `${OUT_DIR}/ch-${id}.png`,
    fullPage: false,
  });
  chapterReport.push({ id, present: true, bg, height: box?.height ?? null });
}

console.log("\nCHAPTER REPORT");
for (const row of chapterReport) {
  console.log(
    `  ${row.id.padEnd(14)} present=${row.present} bg=${row.bg ?? "n/a"} h=${row.height ?? "n/a"}`,
  );
}

await browser.close();
