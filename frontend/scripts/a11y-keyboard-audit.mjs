#!/usr/bin/env node
// Walks Tab through the page, capturing the focused element + computed
// outline. Lets the agent judge whether interactive elements ring up.
import puppeteer from "puppeteer";
import fs from "node:fs";

const url = process.argv[2] || "http://localhost:3947";
const out = process.argv[3] || "../.editions-evidence/a11y-keyboard.json";

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

const steps = [];
for (let i = 0; i < 30; i++) {
  await page.keyboard.press("Tab");
  // Wait past any transition-colors interpolation on outline-color.
  await new Promise((r) => setTimeout(r, 250));
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { sentinel: "body" };
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      ariaSelected: el.getAttribute("aria-selected"),
      ariaExpanded: el.getAttribute("aria-expanded"),
      ariaPressed: el.getAttribute("aria-pressed"),
      text: (el.textContent || "").trim().slice(0, 60),
      outline: cs.outline,
      outlineColor: cs.outlineColor,
      outlineWidth: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
      boxShadow: cs.boxShadow.slice(0, 80),
      visible: rect.width > 0 && rect.height > 0,
    };
  });
  if (!info) break;
  if (info.sentinel === "body") continue;
  steps.push({ tab: i + 1, ...info });
}

fs.writeFileSync(out, JSON.stringify(steps, null, 2));
const noRing = steps.filter(
  (s) =>
    s.outlineStyle === "none" ||
    s.outlineWidth === "0px" ||
    s.outline === "none"
).length;
console.log(
  `tabbed=${steps.length} focusable. without-visible-ring=${noRing} (style:none or width:0)`
);
console.log(
  steps
    .map(
      (s) =>
        `  ${String(s.tab).padStart(2)}. <${s.tag.toLowerCase()}${s.role ? ` role=${s.role}` : ""}${s.ariaExpanded ? ` aria-expanded=${s.ariaExpanded}` : ""}> "${s.text}" outline=${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`
    )
    .join("\n")
);

await browser.close();
