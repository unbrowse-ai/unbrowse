// Falsifier for the closeTarget-never-closes-Chrome-tab accumulation bug.
// Real kuri (patched vendored binary), no mocks. 6 cycles of
// newTab -> navigate(distinct url) -> closeTab. Then count Chrome page
// targets on :9222. Pre-fix: closeTarget issued over the target's own
// (dying) page session was silently dropped -> tabs accumulate to ~7
// (startup + 6 leftovers). Post-fix: closeTarget issues over a sibling
// session and is confirmed -> count stays small (startup about:blank +
// at most the in-flight tab).
import * as kuri from "../src/kuri/client.ts";

function pageTargets(): Promise<Array<{ url: string }>> {
  return fetch("http://127.0.0.1:9222/json")
    .then((r) => r.json())
    .then((d: any[]) => d.filter((t) => t.type === "page").map((t) => ({ url: t.url })))
    .catch(() => []);
}

await kuri.start();
const URLS = [
  "https://news.ycombinator.com/",
  "https://lobste.rs/",
  "https://example.com/",
  "https://news.ycombinator.com/newest",
  "https://lobste.rs/recent",
  "https://example.org/",
];
const before = await pageTargets();
console.log(`baseline page targets: ${before.length} ${JSON.stringify(before.map((t) => t.url))}`);

for (let i = 0; i < URLS.length; i++) {
  const tabId = await kuri.newTab();
  await kuri.navigate(tabId, URLS[i]!);
  await new Promise((r) => setTimeout(r, 800));
  await kuri.closeTab(tabId).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const cur = await pageTargets();
  console.log(`cycle ${i + 1} (${URLS[i]}): closed tab ${tabId.slice(0, 8)} -> chrome page targets now ${cur.length}`);
}

await new Promise((r) => setTimeout(r, 800));
const after = await pageTargets();
await kuri.stop().catch(() => {});
console.log(`\nFINAL page targets: ${after.length}`);
console.log(JSON.stringify(after.map((t) => t.url), null, 2));
// Pass: targets did NOT accumulate. Allow startup about:blank + a small
// slack (<=3) for any single in-flight/last tab and Chrome's own.
// Pre-fix this would be ~7 (baseline + 6 never-closed).
const pass = after.length <= 3;
console.log(JSON.stringify({ baseline: before.length, final: after.length, no_accumulation: pass }, null, 2));
process.exit(pass ? 0 : 1);
