// Reproduce the gate-flow wedge through browse-session.ts (the path the
// raw-client falsifier bypassed). One process, one kuri, shared sessions
// map across probe1->probe2, exactly like routes.ts /v1/browse/go.
// Traced client.ts logs kuri-trace lines to ~/.unbrowse/logs/.
import * as kuri from "../src/kuri/client.ts";
import {
  getOrCreateBrowseSession,
  dropBrowseSession,
  type BrowseSession,
  type BrowseSessionClient,
} from "../src/api/browse-session.ts";

const client: BrowseSessionClient = {
  start: () => kuri.start(),
  newTab: () => kuri.newTab(),
  harStart: (t: string) => kuri.harStart(t).then(() => {}),
  closeTab: (t: string) => kuri.closeTab(t),
  discoverTabs: async () => (await kuri.discoverTabs()).map((x: any) => ({ id: x.id, url: x.url })),
  getCurrentUrl: (t: string) => kuri.getCurrentUrl(t),
  getPort: () => 0,
};
const inject = async () => ({});
const sessions = new Map<string, BrowseSession>();

async function probe(label: string, url: string, full: boolean) {
  console.log(`\n=== ${label} go ${url} ===`);
  const s = await getOrCreateBrowseSession(sessions, client, inject);
  console.log(`${label} session=${s.sessionId} tabId=${s.tabId} (pre-navigate url=${s.url})`);
  await kuri.navigate(s.tabId, url);                       // routes.ts:2747 equivalent
  await new Promise((r) => setTimeout(r, 1500));
  let title: unknown = null, href: unknown = null;
  try { title = await kuri.evaluate(s.tabId, "document.title"); } catch (e) { title = `EVAL_THREW:${(e as Error)?.message ?? e}`; }
  try { href = await kuri.getCurrentUrl(s.tabId); } catch (e) { href = `URL_THREW:${(e as Error)?.message ?? e}`; }
  s.url = String(href || url);
  console.log(`${label} RESULT title=${JSON.stringify(title)} href=${JSON.stringify(href)} tabId=${s.tabId}`);
  if (full) {
    try { await kuri.evaluate(s.tabId, "document.documentElement.outerHTML.slice(0,512)"); } catch {}
  }
  await dropBrowseSession(sessions, client, s);            // unbrowse_close (browse-session level)
  await new Promise((r) => setTimeout(r, 400));
  return String(title);
}

await kuri.start();
const t1 = await probe("PROBE1(HN)", "https://news.ycombinator.com/", true);
const t2 = await probe("PROBE2(npm)", "https://www.npmjs.com/package/openai", true);
const t3 = await probe("PROBE3(lobste)", "https://lobste.rs/", true);
await kuri.stop().catch(() => {});
const pass = (t: string) => t.length > 0 && !t.startsWith("EVAL_THREW") && t !== "null" && t !== "undefined";
console.log(JSON.stringify({ probe1: t1, probe2: t2, probe3: t3, p1: pass(t1), p2: pass(t2), p3: pass(t3) }, null, 2));
process.exit(pass(t1) && pass(t2) && pass(t3) ? 0 : 1);
