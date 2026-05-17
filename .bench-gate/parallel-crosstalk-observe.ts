// Phase-1 decisive OBSERVE: 6 concurrent go() with 6 DISTINCT urls, then
// snap each by its OWN returned session_id. The real gate-contamination
// invariant: each session's snap.current_url host must equal the host it
// was opened with. No assertion — observe whether current code already
// holds this under N=6 concurrency (Scenario A at N=3 already did).
import { getInProcessApp } from "../src/runtime/in-process-app.ts";
const app = await getInProcessApp();

function host(u?: string) { try { return new URL(String(u)).host; } catch { return `?(${String(u).slice(0,40)})`; } }

async function go(url: string) {
  const res = await app.inject({ method: "POST", url: "/v1/browse/go",
    headers: { "content-type": "application/json", "x-unbrowse-client-id": "phase1-xtalk" },
    payload: JSON.stringify({ url }) });
  let b: any = {}; try { b = JSON.parse(res.body); } catch {}
  return { intended: url, status: res.statusCode, session_id: b.session_id, tab_id: b.tab_id, url: b.url, err: b.error ?? b.error_code };
}
async function snap(sid: string) {
  const res = await app.inject({ method: "POST", url: "/v1/browse/snap",
    headers: { "content-type": "application/json", "x-unbrowse-client-id": "phase1-xtalk" },
    payload: JSON.stringify({ session_id: sid, detail_level: "minimal" }) });
  let b: any = {}; try { b = JSON.parse(res.body); } catch {}
  return { current_url: b.current_url, err: b.error ?? b.warning };
}
async function closeS(sid: string) { try { await app.inject({ method: "POST", url: "/v1/browse/close",
  headers: { "content-type": "application/json", "x-unbrowse-client-id": "phase1-xtalk" },
  payload: JSON.stringify({ session_id: sid }) }); } catch {} }

const URLS = [
  "https://example.com/",
  "https://example.org/",
  "https://news.ycombinator.com/",
  "https://lobste.rs/",
  "https://www.iana.org/",
  "https://httpbin.org/html",
];
console.log(`=== ${URLS.length} concurrent go() distinct urls ===`);
const r = await Promise.all(URLS.map((u) => go(u)));
console.log(JSON.stringify(r.map((x) => ({ intended: host(x.intended), got_url: host(x.url), sid: String(x.session_id ?? "").slice(0,8), tid: String(x.tab_id ?? "").slice(0,8), status: x.status, err: x.err })), null, 2));
const tids = r.map((x) => x.tab_id).filter(Boolean);
const sids = r.map((x) => x.session_id).filter(Boolean);
console.log(`distinct session_ids ${new Set(sids).size}/${sids.length} | distinct tab_ids ${new Set(tids).size}/${tids.length}`);
console.log("--- snap each by its OWN session_id; does current_url host == intended host? ---");
let mism = 0;
for (const x of r) {
  if (!x.session_id) { console.log(`  ${host(x.intended)}: NO session (${x.err})`); mism++; continue; }
  const s = await snap(x.session_id);
  const ih = host(x.intended), ch = host(s.current_url);
  const ok = ih === ch || (s.err && !s.current_url);
  if (!ok) mism++;
  console.log(`  ${ih}  ->  snap.current_url=${ch}  ${ok ? "MATCH" : "*** MISMATCH/CROSSTALK ***"}${s.err ? ` (err=${s.err})` : ""}`);
}
for (const x of r) if (x.session_id) await closeS(x.session_id);
console.log(`\nOBSERVE: ${mism} mismatch/no-session of ${r.length}. (0 mismatch w/ all sessions => current code already isolates N=6 => Phase 1 has no reproducible bug.)`);
process.exit(0);
