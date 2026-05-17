// Deterministic NON-LLM parallel collector for the MCP release gate.
// Amended SKILL.md (2026-05-17): collection MAY be parallel + non-LLM;
// JUDGMENT stays single in-thread agent. This file emits ZERO verdicts.
// It runs each probe's faithful sequence via the real getInProcessApp +
// app.inject path (same surface mcp.ts uses) across a bounded worker
// pool, writing the 8 artifact files the existing bench-gate-judge.ts /
// bench-gate-compare.ts already consume. Resume-safe: a probe whose
// execute.meta.json exists is skipped.
//
// Endpoint pick is DETERMINISTIC (top of available_endpoints, already
// score-sorted by resolve) — a structural rule, not a verdict. Params
// are DETERMINISTICALLY derived from the probe URL querystring (a
// structural primitive). The PASS/FAIL verdict is NOT computed here; the
// in-thread agent renders it later from these raw artifacts vs
// harness/probes/GATE_JUDGE.md.
import { getInProcessApp } from "../src/runtime/in-process-app.ts";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUN_DIR = process.argv[2];
if (!RUN_DIR) { console.error("usage: bun scripts/mcp-gate-parallel-collect.ts <run-dir>"); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(RUN_DIR, "manifest.json"), "utf8"));
const probes: Array<{ probe_id: string; intent: string; url: string; lane: string }> = manifest.probes;
const CONC = Number(process.env.UNBROWSE_GATE_CONCURRENCY) || 30;
const HDR = { "content-type": "application/json", "x-unbrowse-client-id": "mcp-gate-parallel" };

const app = await getInProcessApp();

function hostOf(u?: string): string { try { return new URL(String(u)).host; } catch { return ""; } }
async function post(url: string, body: unknown): Promise<any> {
  const res = await app.inject({ method: "POST", url, headers: HDR, payload: JSON.stringify(body) });
  let parsed: any; try { parsed = JSON.parse(res.body); } catch { parsed = { _raw: res.body }; }
  return { status: res.statusCode, body: parsed };
}
function pickEndpoints(resolveResult: any): any[] {
  const r = resolveResult ?? {};
  const cands = r.available_endpoints ?? r.result?.available_endpoints
    ?? (Array.isArray(r.result) && r.result[0]?.endpoint_id ? r.result : null)
    ?? r.available_operations ?? r.result?.available_operations ?? [];
  return Array.isArray(cands) ? cands : [];
}
function derivedParams(u: string): Record<string, string> {
  try { const p: Record<string, string> = {}; new URL(u).searchParams.forEach((v, k) => { p[k] = v; }); return p; }
  catch { return {}; }
}
function w(dir: string, name: string, content: string) { writeFileSync(join(dir, name), content); }

async function runProbe(p: { probe_id: string; intent: string; url: string; lane: string }): Promise<string> {
  const dir = join(RUN_DIR, p.probe_id);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, "execute.meta.json"))) return `${p.probe_id} SKIP (already collected)`;

  // pre-resolve (cache-hit shortcut)
  const pre = await post("/v1/intent/resolve", { intent: p.intent, projection: { raw: true }, params: { url: p.url }, context: { url: p.url } });
  let preEps = pickEndpoints(pre.body);

  let close: any = { body: {} }, snap: any = { body: {} }, evalRes: any = { body: {} };
  if (preEps.length === 0) {
    // Disjoint per-probe session_id: with the create-on-unknown-id +
    // per-broker create-lock fix, each concurrent probe owns its own
    // isolated tab (no cross-render). probe_id is unique per manifest row.
    const sid = `gate-${p.probe_id}`;
    const go = await post("/v1/browse/go", { url: p.url, session_id: sid });
    if (go.status === 200 && go.body?.session_id) {
      snap = await post("/v1/browse/snap", { session_id: sid, detail_level: "minimal" });
      evalRes = await post("/v1/browse/eval", { session_id: sid, expression: "JSON.stringify(document.documentElement.outerHTML).slice(0,8192)" });
      close = await post("/v1/browse/close", { session_id: sid });
    } else {
      close = { body: { _go_failed: go.body } };
    }
  }

  const post2 = await post("/v1/intent/resolve", { intent: p.intent, projection: { raw: true }, params: { url: p.url }, context: { url: p.url } });
  const eps = pickEndpoints(post2.body);
  const cb = close.body ?? {};
  const sb = snap.body ?? {};
  const skillId = cb.skill_id ?? post2.body?.trace?.skill_id ?? pre.body?.trace?.skill_id ?? null;

  // host self-check: raw isolation evidence at this concurrency (NOT a verdict)
  const snapHost = hostOf(sb.current_url);
  const intendedHost = hostOf(p.url);
  const isoSelfCheck = { snap_current_url: sb.current_url ?? null, intended_host: intendedHost, snap_host: snapHost,
    host_match: snapHost ? snapHost === intendedHost : null };

  const blockSignals: string[] = [];
  if (sb.warning) blockSignals.push(String(sb.warning));
  if (evalRes.body?.error) blockSignals.push(String(evalRes.body.error));

  w(dir, "capture.meta.json", JSON.stringify({
    total_endpoints_captured: cb.endpoint_count ?? 0,
    n_operations: eps.length,
    captured_title: sb.page_title || (typeof sb.root_aria === "string" ? sb.root_aria.slice(0, 120) : ""),
    browser_block_signals: blockSignals,
    filter_rejections: null, capture_path: null,
    request_count: cb.request_count ?? 0,
    indexed: cb.indexed ?? false, mode: cb.mode ?? "none",
    skill_id: skillId, iso_self_check: isoSelfCheck,
  }, null, 2));

  const evalStr = typeof evalRes.body?.result === "string" ? evalRes.body.result : JSON.stringify(evalRes.body ?? {});
  w(dir, "capture.html.excerpt", evalStr.slice(0, 8192));

  w(dir, "index.store.json", JSON.stringify({
    stored: cb.indexed === true && !!skillId, skill_id: skillId,
    reason: cb.indexed ? "indexed" : (cb.next_step ?? cb._go_failed ? "go_failed" : "capture_did_not_emit_skill_id"),
  }, null, 2));

  w(dir, "resolve.shortlist.json", JSON.stringify(post2.body, null, 2));

  const pick = eps[0] ?? null;
  w(dir, "resolve.pick.json", JSON.stringify(
    pick ? { ...pick, picked_from: post2.body?.available_endpoints || (Array.isArray(post2.body?.result) ? "available_endpoints" : "available_operations") }
         : { picked_from: "none", status: post2.body?.status ?? "no_match" }, null, 2));

  if (pick && skillId) {
    const params = { endpoint_id: pick.endpoint_id, url: p.url, ...derivedParams(p.url) };
    w(dir, "execute.input.json", JSON.stringify({ skill: skillId, endpoint: pick.endpoint_id, intent: p.intent, context_url: p.url, params }, null, 2));
    const ex = await post(`/v1/skills/${skillId}/execute`, { params, projection: { raw: true }, context_url: p.url, intent: p.intent });
    const resultBody = ex.body?.result ?? ex.body;
    const raw = typeof resultBody === "string" ? resultBody : JSON.stringify(resultBody);
    w(dir, "execute.response.raw", raw);
    w(dir, "execute.meta.json", JSON.stringify({
      status_code: ex.body?.trace?.status_code ?? ex.status ?? null,
      response_bytes: Buffer.byteLength(raw, "utf8"),
      decision_trace: ex.body?.trace?.decision_trace ?? [],
    }, null, 2));
  } else {
    w(dir, "execute.input.json", JSON.stringify({ skill: null, endpoint: null, intent: p.intent, context_url: p.url, params: {}, note: "no_match: execute not run" }, null, 2));
    const handoff = JSON.stringify(post2.body?.next_step ?? post2.body?.next_action ?? post2.body ?? {});
    w(dir, "execute.response.raw", handoff);
    w(dir, "execute.meta.json", JSON.stringify({ status_code: null, response_bytes: Buffer.byteLength(handoff, "utf8"), decision_trace: [] }, null, 2));
  }
  const flag = isoSelfCheck.host_match === false ? " *** ISO-MISMATCH (raw evidence; judge in-thread) ***" : "";
  return `${p.probe_id} done eps=${eps.length} indexed=${cb.indexed ?? false} iso=${isoSelfCheck.host_match}${flag}`;
}

// bounded worker pool
console.log(`[collector] ${probes.length} probes, concurrency=${CONC} (NOTE: >6 exceeds the N<=6 verified-clean band; per-probe iso_self_check is the in-run isolation falsifier — raw evidence, judged in-thread, NOT a script verdict)`);
let idx = 0; let doneN = 0;
async function worker(wid: number) {
  while (true) {
    const i = idx++; if (i >= probes.length) return;
    try { const msg = await runProbe(probes[i]!); doneN++; console.log(`[w${wid}] (${doneN}/${probes.length}) ${msg}`); }
    catch (e) { doneN++; console.log(`[w${wid}] (${doneN}/${probes.length}) ${probes[i]!.probe_id} ERROR ${(e as Error)?.message ?? e}`); }
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, probes.length) }, (_, k) => worker(k)));
console.log(`[collector] all ${probes.length} probes collected to ${RUN_DIR}. NO verdicts emitted. Next: in-thread judge vs harness/probes/GATE_JUDGE.md.`);
process.exit(0);
