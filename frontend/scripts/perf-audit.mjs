#!/usr/bin/env node
// Performance audit for https://www.unbrowse.ai
// Drives Chrome via puppeteer, measures cold-load + scroll + INP proxies + bundle.
// Writes raw JSON + markdown summary to .editions-evidence/.

import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";

const TARGET = process.env.PERF_TARGET ?? "https://www.unbrowse.ai";
const EVIDENCE_DIR = path.resolve(
  process.cwd().endsWith("/frontend")
    ? "../.editions-evidence"
    : "./.editions-evidence",
);
const RAW_JSON = path.join(EVIDENCE_DIR, "PERF-AUDIT.json");
const MD_PATH = path.join(EVIDENCE_DIR, "PERF-AUDIT.md");

await fs.mkdir(EVIDENCE_DIR, { recursive: true });

function log(...a) {
  console.error("[perf]", ...a);
}

async function withCdpThrottle(page) {
  const client = await page.target().createCDPSession();
  await client.send("Network.enable");
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150, // ms
    downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps -> Bps (typical 4G)
    uploadThroughput: (750 * 1024) / 8,
  });
  return client;
}

async function runCold() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--enable-precise-memory-info",
      "--enable-gpu-benchmarking",
      "--no-first-run",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); // iPhone-ish
  await page.setUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  );

  const cdp = await withCdpThrottle(page);

  // Collect network log
  const requests = [];
  const responses = new Map();
  cdp.on("Network.responseReceived", (e) => {
    responses.set(e.requestId, {
      url: e.response.url,
      mime: e.response.mimeType,
      status: e.response.status,
      encodedFromHeaders:
        e.response.headers?.["content-length"] ||
        e.response.headers?.["Content-Length"] ||
        null,
      protocol: e.response.protocol,
    });
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = responses.get(e.requestId);
    if (!r) return;
    requests.push({
      ...r,
      encodedDataLength: e.encodedDataLength,
    });
  });

  // Inject perf observer BEFORE the page loads any script
  await page.evaluateOnNewDocument(() => {
    window.__perf = {
      fcp: null,
      lcp: null,
      cls: 0,
      longTasks: [],
      layoutShifts: [],
      paints: [],
      navigationStart: null,
      inpEvents: [],
    };
    try {
      const fcpObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__perf.paints.push({ name: e.name, startTime: e.startTime });
          if (e.name === "first-contentful-paint") {
            window.__perf.fcp = e.startTime;
          }
        }
      });
      fcpObs.observe({ type: "paint", buffered: true });
    } catch {}
    try {
      const lcpObs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) window.__perf.lcp = last.startTime;
      });
      lcpObs.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
    try {
      const clsObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) {
            window.__perf.cls += e.value;
            window.__perf.layoutShifts.push({
              value: e.value,
              startTime: e.startTime,
              sources: (e.sources || []).map((s) => ({
                node: s.node?.nodeName || null,
                id: s.node?.id || null,
                cls: s.node?.className || null,
              })),
            });
          }
        }
      });
      clsObs.observe({ type: "layout-shift", buffered: true });
    } catch {}
    try {
      const ltObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__perf.longTasks.push({
            startTime: e.startTime,
            duration: e.duration,
            name: e.name,
          });
        }
      });
      ltObs.observe({ type: "longtask", buffered: true });
    } catch {}
    try {
      const evObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration > 16) {
            window.__perf.inpEvents.push({
              name: e.name,
              duration: e.duration,
              startTime: e.startTime,
              processingStart: e.processingStart,
              processingEnd: e.processingEnd,
            });
          }
        }
      });
      evObs.observe({ type: "event", buffered: true, durationThreshold: 16 });
    } catch {}
  });

  const t0 = Date.now();
  log("navigate", TARGET);
  const resp = await page.goto(TARGET, {
    waitUntil: "networkidle2",
    timeout: 90_000,
  });
  const loadMs = Date.now() - t0;
  log("loaded in", loadMs, "ms; status", resp?.status());

  // Give LCP observer one more frame to settle, plus tickle for late LCP candidates
  await new Promise((r) => setTimeout(r, 1500));

  const nav = await page.evaluate(() => {
    const e = performance.getEntriesByType("navigation")[0];
    if (!e) return null;
    return {
      domContentLoaded: e.domContentLoadedEventEnd,
      loadEvent: e.loadEventEnd,
      ttfb: e.responseStart,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      decodedBodySize: e.decodedBodySize,
      type: e.type,
    };
  });

  const coreMetrics = await page.evaluate(() => ({
    fcp: window.__perf.fcp,
    lcp: window.__perf.lcp,
    cls: window.__perf.cls,
    longTaskCount: window.__perf.longTasks.length,
    longTaskTotalMs: window.__perf.longTasks.reduce(
      (a, t) => a + t.duration,
      0,
    ),
    longTaskMaxMs: window.__perf.longTasks.reduce(
      (a, t) => Math.max(a, t.duration),
      0,
    ),
    tbt: window.__perf.longTasks.reduce(
      (a, t) => a + Math.max(0, t.duration - 50),
      0,
    ),
    layoutShifts: window.__perf.layoutShifts.slice(0, 8),
    paints: window.__perf.paints,
  }));

  // Lenis check
  const lenisCheck = await page.evaluate(() => {
    const has = !!(window.lenis || window.__lenis);
    return {
      mounted: has,
      type: typeof window.lenis,
      hasDestroy:
        !!(window.lenis && typeof window.lenis.destroy === "function"),
    };
  });

  // Image CLS audit
  const imageAudit = await page.evaluate(() => {
    const imgs = Array.from(document.images);
    const noSize = imgs.filter(
      (im) => !im.getAttribute("width") || !im.getAttribute("height"),
    );
    return {
      totalImages: imgs.length,
      missingDimensions: noSize.length,
      offenders: noSize.slice(0, 8).map((im) => ({
        src: im.currentSrc || im.src,
        naturalW: im.naturalWidth,
        naturalH: im.naturalHeight,
        clientW: im.clientWidth,
        clientH: im.clientHeight,
      })),
    };
  });

  // Font audit
  const fontAudit = await page.evaluate(async () => {
    const list = [];
    if (document.fonts) {
      await document.fonts.ready;
      for (const f of document.fonts.values()) {
        list.push({
          family: f.family,
          style: f.style,
          weight: f.weight,
          status: f.status,
          display: f.display,
        });
      }
    }
    return list;
  });

  // Scroll-jank pass: scroll through each viewport-height block, measure rAF gaps
  log("scroll jank pass");
  const scrollResult = await page.evaluate(async () => {
    const frames = [];
    let last = performance.now();
    let stop = false;
    const onFrame = (t) => {
      frames.push(t - last);
      last = t;
      if (!stop) requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);

    const scrollHeight = document.documentElement.scrollHeight;
    const vh = window.innerHeight;
    const steps = Math.min(20, Math.ceil(scrollHeight / vh));
    for (let i = 0; i < steps; i++) {
      window.scrollBy({ top: vh, left: 0, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 250));
    }
    // a smooth-scroll burst to invoke lenis
    window.scrollTo({ top: 0, behavior: "smooth" });
    await new Promise((r) => setTimeout(r, 1500));
    window.scrollTo({ top: scrollHeight, behavior: "smooth" });
    await new Promise((r) => setTimeout(r, 1500));

    stop = true;
    await new Promise((r) => setTimeout(r, 50));

    const total = frames.length;
    const dropped = frames.filter((d) => d > 20).length; // <50fps
    const bad = frames.filter((d) => d > 33).length; // <30fps
    const worst = frames.reduce((a, b) => Math.max(a, b), 0);
    const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, total);
    return {
      totalFrames: total,
      droppedFrames: dropped,
      badFrames: bad,
      worstFrameMs: worst,
      avgFrameMs: avg,
      effectiveFps: total > 0 ? 1000 / avg : 0,
      sampleHistogram: {
        ">16ms": frames.filter((d) => d > 16).length,
        ">20ms": dropped,
        ">33ms": bad,
        ">50ms": frames.filter((d) => d > 50).length,
        ">100ms": frames.filter((d) => d > 100).length,
      },
    };
  });

  // INP proxy: click / hover key interactive elements, measure response latency
  log("INP proxy pass");
  const inpProxies = [];
  const selectors = [
    "header a[href='#install']",
    "[data-chapter-nav] a:first-child",
    "a[href*='install']",
    "button:not([disabled])",
    "[role='tab']",
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const before = await page.evaluate(() => performance.now());
      await el.hover().catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      await el.click({ delay: 5 }).catch(() => {});
      const after = await page.evaluate(() => performance.now());
      inpProxies.push({ selector: sel, latencyMs: after - before });
    } catch (e) {
      inpProxies.push({ selector: sel, error: String(e).slice(0, 120) });
    }
  }

  // Pull observed slow events
  const inpEvents = await page.evaluate(() => {
    const arr = window.__perf.inpEvents.slice().sort(
      (a, b) => b.duration - a.duration,
    );
    return arr.slice(0, 12);
  });

  // Lenis OFF test: destroy lenis, rescroll, compare frame budget
  let lenisOffResult = null;
  if (lenisCheck.mounted && lenisCheck.hasDestroy) {
    log("lenis off rescroll");
    lenisOffResult = await page.evaluate(async () => {
      try {
        window.lenis.destroy();
      } catch (e) {
        return { error: String(e) };
      }
      window.scrollTo({ top: 0, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 300));

      const frames = [];
      let last = performance.now();
      let stop = false;
      const onFrame = (t) => {
        frames.push(t - last);
        last = t;
        if (!stop) requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);

      const vh = window.innerHeight;
      const sh = document.documentElement.scrollHeight;
      const steps = Math.min(20, Math.ceil(sh / vh));
      for (let i = 0; i < steps; i++) {
        window.scrollBy({ top: vh, left: 0, behavior: "instant" });
        await new Promise((r) => setTimeout(r, 250));
      }
      stop = true;
      await new Promise((r) => setTimeout(r, 50));

      const total = frames.length;
      const dropped = frames.filter((d) => d > 20).length;
      const worst = frames.reduce((a, b) => Math.max(a, b), 0);
      const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, total);
      return {
        totalFrames: total,
        droppedFrames: dropped,
        worstFrameMs: worst,
        avgFrameMs: avg,
        effectiveFps: total > 0 ? 1000 / avg : 0,
      };
    });
  }

  await browser.close();

  // Bundle audit summarization
  const byType = {};
  for (const r of requests) {
    const key = (r.mime || "unknown").split(";")[0];
    byType[key] = byType[key] || { count: 0, bytes: 0 };
    byType[key].count++;
    byType[key].bytes += r.encodedDataLength || 0;
  }
  const jsChunks = requests
    .filter(
      (r) =>
        /javascript|ecmascript/.test(r.mime || "") ||
        /\.(js|mjs)(\?|$)/.test(r.url),
    )
    .map((r) => ({
      url: r.url,
      kb: +(r.encodedDataLength / 1024).toFixed(1),
      status: r.status,
    }))
    .sort((a, b) => b.kb - a.kb);
  const cssChunks = requests
    .filter((r) => /\.css(\?|$)/.test(r.url) || (r.mime || "").includes("css"))
    .map((r) => ({
      url: r.url,
      kb: +(r.encodedDataLength / 1024).toFixed(1),
    }))
    .sort((a, b) => b.kb - a.kb);
  const fontFiles = requests
    .filter(
      (r) =>
        /\.(woff2?|ttf|otf)(\?|$)/.test(r.url) ||
        (r.mime || "").includes("font"),
    )
    .map((r) => ({
      url: r.url,
      kb: +(r.encodedDataLength / 1024).toFixed(1),
      status: r.status,
    }));
  const imageFiles = requests
    .filter(
      (r) =>
        /\.(png|jpe?g|webp|avif|svg|gif)(\?|$)/.test(r.url) ||
        (r.mime || "").startsWith("image/"),
    )
    .map((r) => ({
      url: r.url,
      kb: +(r.encodedDataLength / 1024).toFixed(1),
    }))
    .sort((a, b) => b.kb - a.kb);

  return {
    target: TARGET,
    loadMs,
    httpStatus: resp?.status() ?? null,
    nav,
    coreMetrics,
    lenisCheck,
    lenisOffResult,
    imageAudit,
    fontAudit,
    scrollResult,
    inpProxies,
    slowEvents: inpEvents,
    network: {
      totalRequests: requests.length,
      totalBytes: requests.reduce((a, r) => a + (r.encodedDataLength || 0), 0),
      byType,
      jsChunks: jsChunks.slice(0, 15),
      jsTotalKb: +(
        jsChunks.reduce((a, r) => a + r.kb, 0)
      ).toFixed(1),
      cssChunks: cssChunks.slice(0, 10),
      fontFiles,
      topImages: imageFiles.slice(0, 10),
      imageCount: imageFiles.length,
    },
  };
}

const report = await runCold();
await fs.writeFile(RAW_JSON, JSON.stringify(report, null, 2));

function fmt(n, digits = 0) {
  if (n == null) return "n/a";
  if (typeof n !== "number") return String(n);
  return n.toFixed(digits);
}

const md = `# PERF AUDIT — ${report.target}

Run: ${new Date().toISOString()}
Conditions: emulated mobile viewport (390x844), 4x CPU throttle, ~4G network (1.6Mbps / 150ms RTT), Chrome headless.

## Core Web Vitals (cold load, throttled)

| Metric | Value | Budget | Verdict |
|---|---|---|---|
| HTTP status | ${report.httpStatus} | 200 | ${report.httpStatus === 200 ? "PASS" : "FAIL"} |
| TTFB | ${fmt(report.nav?.ttfb)} ms | <600 ms | ${(report.nav?.ttfb ?? 1e9) < 600 ? "PASS" : "POOR"} |
| FCP | ${fmt(report.coreMetrics.fcp)} ms | <1800 ms | ${(report.coreMetrics.fcp ?? 1e9) < 1800 ? "PASS" : "POOR"} |
| LCP | ${fmt(report.coreMetrics.lcp)} ms | <2500 ms | ${(report.coreMetrics.lcp ?? 1e9) < 2500 ? "PASS" : "POOR"} |
| CLS | ${fmt(report.coreMetrics.cls, 3)} | <0.1 | ${(report.coreMetrics.cls ?? 1) < 0.1 ? "PASS" : "POOR"} |
| TBT (proxy) | ${fmt(report.coreMetrics.tbt)} ms | <200 ms | ${(report.coreMetrics.tbt ?? 1e9) < 200 ? "PASS" : "POOR"} |
| Long tasks | ${report.coreMetrics.longTaskCount} (max ${fmt(report.coreMetrics.longTaskMaxMs)} ms) | <5 | ${report.coreMetrics.longTaskCount < 5 ? "PASS" : "POOR"} |
| Time to networkidle2 | ${report.loadMs} ms | <5000 ms | ${report.loadMs < 5000 ? "PASS" : "POOR"} |

## Bundle / network

- Requests: **${report.network.totalRequests}**
- Total transferred: **${(report.network.totalBytes / 1024).toFixed(1)} KB**
- JS total (encoded): **${report.network.jsTotalKb} KB** across ${report.network.jsChunks.length} listed chunks
- CSS total: ${report.network.cssChunks.reduce((a, c) => a + c.kb, 0).toFixed(1)} KB
- Fonts: ${report.network.fontFiles.length} files, ${report.network.fontFiles.reduce((a, f) => a + f.kb, 0).toFixed(1)} KB
- Images: ${report.network.imageCount}

### Top 10 JS chunks (encoded KB)
${report.network.jsChunks.slice(0, 10).map((c, i) => `${i + 1}. ${c.kb} KB — ${c.url.replace(/^https?:\/\/[^/]+/, "")}`).join("\n")}

### Top images
${report.network.topImages.slice(0, 6).map((c, i) => `${i + 1}. ${c.kb} KB — ${c.url.replace(/^https?:\/\/[^/]+/, "")}`).join("\n") || "_none_"}

## Scroll jank (chapter-by-chapter scrollBy)

| Metric | Lenis ON | Lenis OFF |
|---|---|---|
| Frames captured | ${report.scrollResult.totalFrames} | ${report.lenisOffResult?.totalFrames ?? "n/a"} |
| Effective FPS | ${fmt(report.scrollResult.effectiveFps, 1)} | ${fmt(report.lenisOffResult?.effectiveFps, 1)} |
| Avg frame ms | ${fmt(report.scrollResult.avgFrameMs, 1)} | ${fmt(report.lenisOffResult?.avgFrameMs, 1)} |
| Dropped (>20ms) | ${report.scrollResult.droppedFrames} | ${report.lenisOffResult?.droppedFrames ?? "n/a"} |
| Bad (>33ms) | ${report.scrollResult.badFrames} | n/a |
| Worst frame ms | ${fmt(report.scrollResult.worstFrameMs)} | ${fmt(report.lenisOffResult?.worstFrameMs)} |

Frame histogram (Lenis ON): ${JSON.stringify(report.scrollResult.sampleHistogram)}

Lenis mounted: ${report.lenisCheck.mounted} (has destroy: ${report.lenisCheck.hasDestroy})

## INP proxy (top slow events)
${
  report.slowEvents.length === 0
    ? "_no events > 16ms observed_"
    : report.slowEvents.slice(0, 8).map((e, i) => `${i + 1}. ${e.name} — ${fmt(e.duration, 1)} ms`).join("\n")
}

### Hover/click latencies
${report.inpProxies.map((p) => `- \`${p.selector}\` → ${p.latencyMs != null ? fmt(p.latencyMs, 1) + " ms" : `error: ${p.error}`}`).join("\n")}

## Layout shift offenders (top 5)
${
  report.coreMetrics.layoutShifts.length === 0
    ? "_no shifts observed_"
    : report.coreMetrics.layoutShifts
        .slice(0, 5)
        .map(
          (s, i) =>
            `${i + 1}. value=${s.value.toFixed(3)} at t=${fmt(s.startTime)} ms; sources: ${s.sources
              .map((src) => src.node + (src.id ? "#" + src.id : "") + (src.cls ? "." + String(src.cls).slice(0, 50) : ""))
              .join(", ")}`,
        )
        .join("\n")
}

## Images missing dimensions (potential CLS)
- ${report.imageAudit.missingDimensions} of ${report.imageAudit.totalImages} images lack explicit width/height
${report.imageAudit.offenders
  .slice(0, 5)
  .map((o, i) => `${i + 1}. ${o.src} (natural ${o.naturalW}x${o.naturalH}, rendered ${o.clientW}x${o.clientH})`)
  .join("\n")}

## Fonts loaded
${report.fontAudit.map((f) => `- ${f.family} ${f.weight} ${f.style} — status=${f.status} display=${f.display}`).join("\n") || "_n/a_"}
`;

await fs.writeFile(MD_PATH, md);
console.log(MD_PATH);
console.log(RAW_JSON);
