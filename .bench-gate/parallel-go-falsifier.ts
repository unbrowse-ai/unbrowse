// Phase-1 OBSERVE harness (no assertions yet). Real getInProcessApp +
// concurrent app.inject — the parallel path production MCP cannot exercise
// (single-flight stdio). Goal: observe the true pre-fix concurrent
// creation-path behavior so the mutation-tested assertion is grounded in
// reality, not guessed (anti-painted-lamp; memory feedback_xfail_mutation_test).
import { getInProcessApp } from "../src/runtime/in-process-app.ts";

const app = await getInProcessApp();

async function go(url: string, sessionId?: string) {
  const payload: Record<string, unknown> = { url };
  if (sessionId) payload.session_id = sessionId;
  const res = await app.inject({
    method: "POST",
    url: "/v1/browse/go",
    headers: { "content-type": "application/json", "x-unbrowse-client-id": "phase1-falsifier" },
    payload: JSON.stringify(payload),
  });
  let body: any = {};
  try { body = JSON.parse(res.body); } catch { body = { _raw: res.body?.slice(0, 200) }; }
  return { status: res.statusCode, session_id: body.session_id, tab_id: body.tab_id, url: body.url, err: body.error ?? body.error_code };
}

async function snap(sessionId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/browse/snap",
    headers: { "content-type": "application/json", "x-unbrowse-client-id": "phase1-falsifier" },
    payload: JSON.stringify({ session_id: sessionId, detail_level: "minimal" }),
  });
  let body: any = {};
  try { body = JSON.parse(res.body); } catch { body = {}; }
  return { status: res.statusCode, current_url: body.current_url, title: body.page_title, err: body.error ?? body.warning };
}

async function closeS(sessionId: string) {
  try {
    await app.inject({
      method: "POST", url: "/v1/browse/close",
      headers: { "content-type": "application/json", "x-unbrowse-client-id": "phase1-falsifier" },
      payload: JSON.stringify({ session_id: sessionId }),
    });
  } catch { /* best effort */ }
}

const U = "https://example.com/";

console.log("=== Scenario A: 3 concurrent go(), SAME url, NO session_id ===");
const a = await Promise.all([go(U), go(U), go(U)]);
console.log(JSON.stringify(a, null, 2));
const aSids = a.map((r) => r.session_id).filter(Boolean);
const aTids = a.map((r) => r.tab_id).filter(Boolean);
console.log(`A distinct session_ids: ${new Set(aSids).size}/${aSids.length} | distinct tab_ids: ${new Set(aTids).size}/${aTids.length}`);
for (const r of a) if (r.session_id) console.log(`  A snap ${String(r.session_id).slice(0, 8)}:`, JSON.stringify(await snap(r.session_id)));
for (const r of a) if (r.session_id) await closeS(r.session_id);

console.log("\n=== Scenario B: 3 concurrent go(), SAME url, DISTINCT explicit session_ids ===");
const b = await Promise.all([go(U, "phase1-B1"), go(U, "phase1-B2"), go(U, "phase1-B3")]);
console.log(JSON.stringify(b, null, 2));
const bTids = b.map((r) => r.tab_id).filter(Boolean);
console.log(`B distinct tab_ids: ${new Set(bTids).size}/${bTids.length} (expect 3 if isolated)`);
for (const sid of ["phase1-B1", "phase1-B2", "phase1-B3"]) console.log(`  B snap ${sid}:`, JSON.stringify(await snap(sid)));
for (const sid of ["phase1-B1", "phase1-B2", "phase1-B3"]) await closeS(sid);

console.log("\n=== OBSERVE ONLY — no verdict. Read the distinct-id ratios + snap current_urls above. ===");
process.exit(0);
