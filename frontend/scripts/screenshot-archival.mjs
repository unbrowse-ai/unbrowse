/**
 * Screenshot the restored archival landing — walks by section id instead of
 * data-chapter (the archival landing uses ids). Captures 1440x900 + 375x812.
 */
import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";

const URL = process.env.LANDING_URL || "https://www.unbrowse.ai/";
const OUT_DIR = process.env.SCREENSHOT_DIR || ".editions-evidence/wave-c-before";

const SECTIONS = [
  "universal",
  "install",
  "use-cases",
  "zero-setup",
  "benchmark",
  "hero-stats",
  "popular-skills",
  "earn",
  "demo",
  "registry",
  "objections",
  "anti-icp",
];

await mkdir(OUT_DIR, { recursive: true });

async function run(viewport, suffix) {
  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: viewport,
  });
  const page = await browser.newPage();
  console.log(`[${suffix}] opening ${URL}`);
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));

  await page.screenshot({ path: `${OUT_DIR}/00-hero-${suffix}.png`, fullPage: false });
  await page.screenshot({ path: `${OUT_DIR}/full-${suffix}.png`, fullPage: true });

  const report = [];
  for (const id of SECTIONS) {
    const found = await page.$(`#${id}`);
    if (!found) {
      report.push({ id, present: false });
      continue;
    }
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
    }, id);
    await new Promise((r) => setTimeout(r, 500));
    const box = await found.boundingBox();
    await page.screenshot({
      path: `${OUT_DIR}/sec-${id}-${suffix}.png`,
      fullPage: false,
    });
    report.push({ id, present: true, h: Math.round(box?.height ?? 0) });
  }
  console.log(`[${suffix}] sections:`);
  for (const r of report) console.log(`  ${r.id.padEnd(16)} ${r.present ? `h=${r.h}` : "MISSING"}`);
  await browser.close();
}

await run({ width: 1440, height: 900 }, "desktop");
await run({ width: 375, height: 812 }, "mobile");
console.log(`\nwrote screenshots to ${OUT_DIR}/`);
