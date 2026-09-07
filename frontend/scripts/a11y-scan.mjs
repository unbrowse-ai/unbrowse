#!/usr/bin/env node
// A11y scan using puppeteer + axe-core source injection.
// Usage: node scripts/a11y-scan.mjs <url> <output.json>
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";

const url = process.argv[2];
const out = process.argv[3];
if (!url || !out) {
  console.error("usage: a11y-scan.mjs <url> <output.json>");
  process.exit(2);
}

const axeSrc = fs.readFileSync(
  path.join(process.cwd(), "node_modules/axe-core/axe.min.js"),
  "utf8"
);

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  // Allow late hydration / animations to settle.
  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate(axeSrc);
  const results = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    return await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
      resultTypes: ["violations", "incomplete", "passes"],
    });
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  const v = results.violations || [];
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let totalNodes = 0;
  for (const x of v) {
    counts[x.impact] = (counts[x.impact] || 0) + 1;
    totalNodes += x.nodes.length;
  }
  console.log(
    `url=${url} violations=${v.length} nodes=${totalNodes} ${JSON.stringify(counts)}`
  );
} finally {
  await browser.close();
}
