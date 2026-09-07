import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
const client = await page.target().createCDPSession();
await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await page.evaluateOnNewDocument(() => {
  window.__shifts__ = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue;
      const sources = (entry.sources || []).map(s => ({
        node: s.node ? (s.node.tagName + (s.node.id ? '#'+s.node.id : '') + ' .'+String(s.node.className||'').slice(0,80)) : '?',
        prev: s.previousRect ? { y: Math.round(s.previousRect.y), h: Math.round(s.previousRect.height) } : null,
        cur:  s.currentRect ? { y: Math.round(s.currentRect.y), h: Math.round(s.currentRect.height) } : null,
      }));
      window.__shifts__.push({ value: entry.value, time: Math.round(entry.startTime), sources });
    }
  }).observe({ type: "layout-shift", buffered: true });
});
await page.goto("http://localhost:3303/", { waitUntil: "load", timeout: 60000 });
await new Promise(r => setTimeout(r, 8000));
const shifts = await page.evaluate(() => window.__shifts__);
console.log("TOTAL CLS:", shifts.reduce((a,s)=>a+s.value,0).toFixed(4), "shifts:", shifts.length);
for (const s of shifts) {
  console.log(`\n+${s.value.toFixed(4)} @ ${s.time}ms`);
  for (const src of s.sources.slice(0, 4)) {
    console.log(`  ${src.node.slice(0,140)}`);
    if (src.prev && src.cur) console.log(`    prev y=${src.prev.y} h=${src.prev.h}    cur y=${src.cur.y} h=${src.cur.h}    Δy=${src.cur.y - src.prev.y} Δh=${src.cur.h - src.prev.h}`);
  }
}
await browser.close();
