import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
await page.goto("http://localhost:3301/", { waitUntil: "networkidle2", timeout: 30000 });
await new Promise(r => setTimeout(r, 1500));
const h = await page.evaluate(() => {
  const el = document.querySelector('[data-hero-h1]');
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { rectH: r.height, minHeight: cs.minHeight, fontSize: cs.fontSize, lineHeight: cs.lineHeight };
});
console.log("390x844 h1:", JSON.stringify(h));
// also measure the parent block to see if it's the wrapper that shifts
const parent = await page.evaluate(() => {
  const el = document.querySelector('[data-hero-h1]');
  const p = el.parentElement;
  return { tag: p.tagName, h: p.getBoundingClientRect().height, cls: p.className.slice(0,80) };
});
console.log("parent:", JSON.stringify(parent));
await browser.close();
