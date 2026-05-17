// Falsifier for the silent wrong-tab adopt in isBrowseSessionLive.
// Real kuri, no mocks. Two cases:
//  A) session.url is a placeholder (fresh, never-navigated) and its real
//     tab_id is gone; the only live tab is kuri's startup about:blank.
//     CORRECT behavior: isBrowseSessionLive => false (no identity signal;
//     do not silently bind the session to the unrelated startup tab).
//     Pre-fix this returns TRUE (the wedge: snap then reads wrong tab).
//  B) legit id-drift: session.url is a MEANINGFUL url and the only tab is
//     at exactly that url (kuri churned the tab id). CORRECT: => true
//     (adopt; this drift tolerance must be preserved).
import * as kuri from "../src/kuri/client.ts";
import { isBrowseSessionLive, type BrowseSession, type BrowseSessionClient } from "../src/api/browse-session.ts";

const client: BrowseSessionClient = {
  start: () => kuri.start(),
  newTab: () => kuri.newTab(),
  harStart: (t: string) => kuri.harStart(t).then(() => {}),
  closeTab: (t: string) => kuri.closeTab(t),
  discoverTabs: async () => (await kuri.discoverTabs()).map((x: any) => ({ id: x.id, url: x.url })),
  getCurrentUrl: (t: string) => kuri.getCurrentUrl(t),
  getPort: () => 0,
};

await kuri.start();
// Ensure exactly one live tab. Fresh kuri => the startup about:blank tab.
let tabs = (await kuri.discoverTabs()).map((x: any) => ({ id: x.id, url: x.url }));
// Close every tab except one so tabs.length === 1 (the lone-tab branch).
for (const t of tabs.slice(1)) { try { await kuri.closeTab(t.id); } catch {} }
await new Promise((r) => setTimeout(r, 500));
tabs = (await kuri.discoverTabs()).map((x: any) => ({ id: x.id, url: x.url }));
const lone = tabs[0];
console.log(`lone tab: id=${lone?.id} url=${JSON.stringify(lone?.url)} (tab count=${tabs.length})`);

// CASE A: fresh placeholder session, bogus (vanished) tab id.
const sA: BrowseSession = { sessionId: "A", tabId: "BOGUS_VANISHED_TAB_ID", url: "about:blank", harActive: true, domain: "" };
const aLive = await isBrowseSessionLive(sA, client);
const aReboundToLone = sA.tabId === lone?.id;
console.log(`CASE A (placeholder session, vanished tab): isBrowseSessionLive=${aLive} reboundToLoneStartupTab=${aReboundToLone}`);

// CASE B: legit id-drift. Navigate the lone tab to a real URL, then make a
// session whose url == that real url but tabId is stale/bogus.
let bOk = "skipped";
if (lone?.id) {
  try {
    await kuri.navigate(lone.id, "https://lobste.rs/");
    await new Promise((r) => setTimeout(r, 1500));
    const sB: BrowseSession = { sessionId: "B", tabId: "STALE_DRIFTED_ID", url: "https://lobste.rs/", harActive: true, domain: "lobste.rs" };
    const bLive = await isBrowseSessionLive(sB, client);
    bOk = `isBrowseSessionLive=${bLive} reboundToLone=${sB.tabId === lone.id}`;
  } catch (e) { bOk = `threw:${(e as Error)?.message ?? e}`; }
}
console.log(`CASE B (meaningful-url id-drift, must still adopt): ${bOk}`);
await kuri.stop().catch(() => {});

// Verdict: A must be false (honest), B must be live (drift preserved).
const aPass = aLive === false && aReboundToLone === false;
const bPass = /isBrowseSessionLive=true/.test(bOk);
console.log(JSON.stringify({ caseA_no_silent_adopt: aPass, caseB_drift_preserved: bPass, overall: aPass && bPass }, null, 2));
process.exit(aPass && bPass ? 0 : 1);
