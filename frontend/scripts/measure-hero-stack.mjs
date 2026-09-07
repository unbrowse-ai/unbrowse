import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
const client = await page.target().createCDPSession();
await client.send("Network.enable");
await client.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: 200_000, uploadThroughput: 100_000, latency: 150 });
await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
// Capture pre-font (early) heights
await page.goto("http://localhost:3301/", { waitUntil: "domcontentloaded", timeout: 60000 });
const early = await page.evaluate(() => {
  const get = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { y: r.y, h: r.height };
  };
  return {
    eyebrow: get('[data-hero-eyebrow], a[href*="github.com/unbrowse-ai"]'),
    proof:   get('[data-hero-proof], #hero-proof-strip'),
    h1:      get('[data-hero-h1]'),
    sub:     get('[data-hero-subhead]'),
    audience: get('[data-audience-toggle]'),
  };
});
console.log("EARLY:", JSON.stringify(early));
// wait for font load to settle
await new Promise(r => setTimeout(r, 4000));
const late = await page.evaluate(() => {
  const get = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { y: r.y, h: r.height };
  };
  return {
    eyebrow: get('a[href*="github.com/unbrowse-ai"]'),
    proof:   get('#hero-proof-strip'),
    h1:      get('[data-hero-h1]'),
    sub:     get('[data-hero-subhead]'),
    audience: get('[data-audience-toggle]'),
  };
});
console.log("LATE:", JSON.stringify(late));
await browser.close();
