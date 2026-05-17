// Faithful one-process reproduction of the MCP gate flow via the SAME
// in-process Fastify app.inject path the MCP/cli use. One persistent app +
// sessions map + kuri client across probe1->probe2 (exactly the MCP process
// shape). Traced client.ts writes kuri-trace to ~/.unbrowse/logs/.
import { getInProcessApp } from "../src/runtime/in-process-app.ts";

const app = await getInProcessApp();

async function inj(method: "GET" | "POST", url: string, body?: unknown) {
  const r = await app.inject({
    method, url,
    headers: { ...(body ? { "content-type": "application/json" } : {}), "x-unbrowse-client-id": "gateflow-trace" },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j: any = null; try { j = JSON.parse(r.body); } catch { j = r.body?.slice?.(0, 300); }
  return { status: r.statusCode, j };
}
const pick = (j: any) => j?.result?.available_endpoints?.[0] ?? j?.available_endpoints?.[0] ?? null;
const sid = (j: any) => j?.session_id ?? j?.result?.session_id ?? null;

async function gateProbe(label: string, intent: string, url: string) {
  console.log(`\n==== ${label} ${url} ====`);
  const pre = await inj("POST", "/v1/intent/resolve", { intent, url });
  console.log(`${label} resolve(pre) status=${pre.status} skill=${pre.j?.result?.skill_id ?? pre.j?.skill_id ?? "-"} eps=${(pre.j?.result?.available_endpoints ?? pre.j?.available_endpoints ?? []).length}`);
  const go = await inj("POST", "/v1/browse/go", { url });
  const session = sid(go.j);
  console.log(`${label} go status=${go.status} session=${session} tab=${go.j?.tab_id ?? "-"} url=${go.j?.url ?? "-"}`);
  const snap = await inj("POST", "/v1/browse/snap", { session_id: session, detail_level: "minimal" });
  const curl = snap.j?.current_url ?? snap.j?.result?.current_url;
  const aria = snap.j?.root_aria ?? snap.j?.result?.root_aria;
  console.log(`${label} snap status=${snap.status} current_url=${curl} root_aria=${String(aria).slice(0, 60)} interactive=${snap.j?.interactive_count ?? snap.j?.result?.interactive_count}`);
  const WEDGED = String(curl || "").startsWith("chrome://") || String(aria || "").includes("Incognito");
  await inj("POST", "/v1/browse/eval", { session_id: session, expression: "document.documentElement.outerHTML.slice(0,512)" }).catch(() => {});
  await inj("POST", "/v1/browse/close", { session_id: session }).catch(() => {});
  const post = await inj("POST", "/v1/intent/resolve", { intent, url });
  const ep = pick(post.j);
  const skill = post.j?.result?.skill_id ?? post.j?.skill_id;
  if (ep && skill) {
    const ex = await inj("POST", `/v1/skills/${skill}/execute`, { endpoint_id: ep.endpoint_id, intent, url, params: {} });
    const n = Array.isArray(ex.j?.result) ? ex.j.result.length : (ex.j?.trace?.success ? "ok" : "?");
    console.log(`${label} execute status=${ex.status} rows=${n}`);
  } else console.log(`${label} execute SKIPPED (no post-resolve endpoint)`);
  console.log(`${label} >>> ${WEDGED ? "WEDGED (chrome://newtab/Incognito)" : "OK"}`);
  return WEDGED;
}

const w1 = await gateProbe("PROBE1", "get top hacker news stories", "https://news.ycombinator.com/");
const w2 = await gateProbe("PROBE2", "get package info", "https://www.npmjs.com/package/openai");
const w3 = await gateProbe("PROBE3", "get lobsters top stories", "https://lobste.rs/");
console.log(JSON.stringify({ probe1_wedged: w1, probe2_wedged: w2, probe3_wedged: w3 }, null, 2));
process.exit(w1 || w2 || w3 ? 1 : 0);
