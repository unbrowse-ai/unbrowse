import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto("http://localhost:3300/", { waitUntil: "networkidle2", timeout: 30000 });
await new Promise(r => setTimeout(r, 1500));
const h = await page.evaluate(() => {
  const el = document.querySelector('[data-hero-h1]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { rectH: r.height, minHeight: cs.minHeight, fontSize: cs.fontSize, fontFamily: cs.fontFamily, lineHeight: cs.lineHeight };
});
console.log(JSON.stringify(h, null, 2));
await page.setViewport({ width: 375, height: 812 });
await page.reload({ waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 1500));
const hm = await page.evaluate(() => {
  const el = document.querySelector('[data-hero-h1]');
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { rectH: r.height, minHeight: cs.minHeight };
});
console.log("mobile 375x812:", JSON.stringify(hm));
await browser.close();
