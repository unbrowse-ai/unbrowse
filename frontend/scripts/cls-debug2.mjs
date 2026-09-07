import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
const client = await page.target().createCDPSession();
await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await page.goto("http://localhost:3302/", { waitUntil: "domcontentloaded", timeout: 60000 });
const early = await page.evaluate(() => {
  const hands = document.querySelectorAll('[class*="bottom-0"][class*="h-["]');
  return Array.from(hands).slice(0,2).map(h => {
    const r = h.getBoundingClientRect();
    return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width), cls: h.className.slice(0,80) };
  });
});
console.log("EARLY:", JSON.stringify(early, null, 2));
await new Promise(r => setTimeout(r, 4000));
const late = await page.evaluate(() => {
  const hands = document.querySelectorAll('[class*="bottom-0"][class*="h-["]');
  return Array.from(hands).slice(0,2).map(h => {
    const r = h.getBoundingClientRect();
    return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) };
  });
});
console.log("LATE:", JSON.stringify(late, null, 2));
// what's the hero section's height
const sec = await page.evaluate(() => {
  const s = document.querySelector('section[style*="90vh"]');
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { y: Math.round(r.y), h: Math.round(r.height) };
});
console.log("HERO SECTION (LATE):", JSON.stringify(sec));
await browser.close();
