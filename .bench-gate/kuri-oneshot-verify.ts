// Falsifier for the "kuri works once then wedges" bug.
// Drives the PATCHED src/kuri/client.ts directly: ONE kuri broker, N
// sequential newTab->navigate->evaluate->closeTab cycles. Pre-fix, cycle 2+
// wedged (snap empty / "CDP command failed") because findReusableIdleTab
// reused the headless chrome://newtab NTP. Post-fix it must reuse only
// about:blank / create a fresh CDP target, so every cycle returns the title.
import { start, stop, newTab, navigate, evaluate, closeTab, getCurrentUrl } from "../src/kuri/client.ts";

const URLS = [
  "https://news.ycombinator.com/",
  "https://lobste.rs/",
  "https://news.ycombinator.com/newest",
  "https://lobste.rs/recent",
];

function ok(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

const results: Array<{ cycle: number; url: string; tabId: string; title: unknown; href: unknown; pass: boolean }> = [];

await start();
try {
  for (let i = 0; i < URLS.length; i++) {
    const url = URLS[i]!;
    const tabId = await newTab();
    if (!tabId) { results.push({ cycle: i + 1, url, tabId: "", title: "NO_TAB", href: "", pass: false }); continue; }
    await navigate(tabId, url);
    // brief settle for SSR
    await new Promise((r) => setTimeout(r, 1500));
    let title: unknown = null;
    let href: unknown = null;
    try { title = await evaluate(tabId, "document.title"); } catch (e) { title = `EVAL_THREW:${ok((e as Error)?.message ?? e)}`; }
    try { href = await getCurrentUrl(tabId); } catch (e) { href = `URL_THREW:${ok((e as Error)?.message ?? e)}`; }
    const t = ok(title);
    const pass = t.length > 0 && !t.startsWith("EVAL_THREW") && t !== "null" && t !== "undefined" && !t.toLowerCase().includes("cdp command failed");
    results.push({ cycle: i + 1, url, tabId, title, href, pass });
    await closeTab(tabId).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }
} finally {
  await stop().catch(() => {});
}

const passed = results.filter((r) => r.pass).length;
console.log(JSON.stringify({ total: results.length, passed, all_pass: passed === results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
