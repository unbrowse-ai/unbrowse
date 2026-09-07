/**
 * Screenshot the Hallmark redesign — captures 1440 desktop + 320/375/414/768
 * mobile widths, walking by chapter id. Also reports horizontal-scroll status
 * per width (gate 36).
 */
import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";

const URL = process.env.LANDING_URL || "http://localhost:3320/";
const OUT_DIR = process.env.SCREENSHOT_DIR || ".editions-evidence/hallmark-after";

const CHAPTERS = [
  "ch-shadow",
  "ch-install",
  "ch-numbers",
  "ch-earn",
  "ch-market",
  "ch-answers",
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
  await new Promise((r) => setTimeout(r, 1500));

  // Horizontal-scroll detection (gate 36)
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    bodyClientW: document.body.clientWidth,
  }));
  const horiz =
    overflow.scrollW > overflow.clientW + 1 ||
    overflow.bodyScrollW > overflow.bodyClientW + 1;
  console.log(
    `[${suffix}] overflow scrollW=${overflow.scrollW} clientW=${overflow.clientW} horiz=${horiz ? "FAIL" : "ok"}`,
  );

  await page.screenshot({ path: `${OUT_DIR}/00-masthead-${suffix}.png`, fullPage: false });
  await page.screenshot({ path: `${OUT_DIR}/full-${suffix}.png`, fullPage: true });

  const report = { suffix, viewport, horiz: !horiz ? "ok" : "FAIL", chapters: [] };
  for (const id of CHAPTERS) {
    const found = await page.$(`#${id}`);
    if (!found) {
      report.chapters.push({ id, present: false });
      continue;
    }
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
    }, id);
    await new Promise((r) => setTimeout(r, 600));
    const box = await found.boundingBox();
    await page.screenshot({
      path: `${OUT_DIR}/ch-${id}-${suffix}.png`,
      fullPage: false,
    });
    report.chapters.push({ id, present: true, h: Math.round(box?.height ?? 0) });
  }
  console.log(`[${suffix}] report:`, JSON.stringify(report, null, 2));
  await browser.close();
  return report;
}

const report1440 = await run({ width: 1440, height: 900, deviceScaleFactor: 1 }, "1440");
const report768 = await run({ width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true }, "768");
const report414 = await run({ width: 414, height: 896, deviceScaleFactor: 2, isMobile: true }, "414");
const report375 = await run({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true }, "375");
const report320 = await run({ width: 320, height: 568, deviceScaleFactor: 2, isMobile: true }, "320");

const summary = { reports: [report1440, report768, report414, report375, report320] };
const { writeFile } = await import("node:fs/promises");
await writeFile(`${OUT_DIR}/report.json`, JSON.stringify(summary, null, 2));

console.log("\nMobile-non-negotiable summary:");
for (const r of summary.reports) {
  console.log(`  ${r.suffix.padStart(4)} → horiz: ${r.horiz}`);
}
