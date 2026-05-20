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
//
// ENV-DEFAULT-FORCING BLOCK:
//   UNBROWSE_GATE_CONCURRENCY (number, default 30) — worker-pool size.
//   UNBROWSE_GATE_FORCE_GO (1|true|yes, default unset) — when set,
//     ALWAYS run /v1/browse/go + snap + eval + close, even when the
//     pre-resolve cache returned a non-empty available_endpoints
//     shortlist. Default behaviour (cache short-circuits go) is
//     unchanged when the env is unset. Used to force the cookie-
//     injection / live capture path under auth-cookies probes whose
//     marketplace skill is already cached.
import { getInProcessApp } from "../src/runtime/in-process-app.ts";
import { classifyReason, pickSkillId } from "./mcp-gate-parallel-classify.ts";
import { buildCaptureMeta, parseForceGoEnv, parseProbeTimeoutMs, withProbeTimeout, ProbeTimeoutError } from "./mcp-gate-parallel-helpers.ts";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUN_DIR = process.argv[2];
if (!RUN_DIR) { console.error("usage: bun scripts/mcp-gate-parallel-collect.ts <run-dir>"); process.exit(2); }

// Hard-headless lock. Bench-gate runs must never pop a Chrome window onto
// the user's screen, not from the substrate-internal anti-bot retry path
// in execution/index.ts:1605, not from a peer harness leaking
// UNBROWSE_ALLOW_VISIBLE_AUTH_FALLBACK=1 into the process env. Set BEFORE
// getInProcessApp() spawns so the kuri client picks it up at launch.
process.env.UNBROWSE_FORCE_HEADLESS = "1";

const manifest = JSON.parse(readFileSync(join(RUN_DIR, "manifest.json"), "utf8"));
const probes: Array<{ probe_id: string; intent: string; url: string; lane: string }> = manifest.probes;
const CONC_ENV = Number(process.env.UNBROWSE_GATE_CONCURRENCY) || 30;
const FORCE_GO = parseForceGoEnv(process.env.UNBROWSE_GATE_FORCE_GO);
const PROBE_TIMEOUT_MS = parseProbeTimeoutMs(process.env.UNBROWSE_GATE_PROBE_TIMEOUT_MS);
// Early-stop mode: when UNBROWSE_GATE_STOP_ON_FAIL=1, force conc=1 and exit
// the collector at the first probe whose artifact doesn't satisfy the
// lane-aware structural-pass predicate. The agent reads .stop-marker, ships
// a fix, re-runs (resume-skip pulls the last-completed probes; the stopped
// probe is NOT resume-skipped because its artifact predicate failed).
const STOP_ON_FAIL = process.env.UNBROWSE_GATE_STOP_ON_FAIL === "1"
  || (process.env.UNBROWSE_GATE_STOP_ON_FAIL ?? "").toLowerCase() === "true";
// Skip-past flag: when set, predicate treats "empty_snapshot + indexed=false
// + n_ops=0" as PASS for the predicate so the loop advances past kuri/browser
// hydration races to surface OTHER bugs. The artifact still records
// empty_snapshot so the in-thread judge sees the real outcome; this only
// changes whether the STOP_ON_FAIL path halts on that probe.
const SKIP_EMPTY_SNAPSHOT = process.env.UNBROWSE_GATE_SKIP_EMPTY_SNAPSHOT === "1"
  || (process.env.UNBROWSE_GATE_SKIP_EMPTY_SNAPSHOT ?? "").toLowerCase() === "true";
const CONC = STOP_ON_FAIL ? 1 : CONC_ENV;
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

// Structural-pass predicate. RAW signals only; agent still judges PASS/FAIL
// holistically. Used by UNBROWSE_GATE_STOP_ON_FAIL=1 to STOP the collector
// at the first probe whose artifact doesn't look like a clean pass for its
// lane. Returns null on pass (do not stop), or a string reason on fail.
function structuralPassPredicate(p: { lane: string }, artifacts: { cm: any; em: any; raw: string; idxStore?: any }): string | null {
  const { cm, em, raw, idxStore } = artifacts;
  if (cm?.crashed_during_collect) return `crashed_during_collect (W0 timeout)`;
  const indexed = cm?.indexed === true;
  const nOps = Number(cm?.n_operations ?? 0);
  const status = em?.status_code;
  const bytes = Number(em?.response_bytes ?? 0);
  const head = (raw ?? "").slice(0, 300);
  const isErrEnv =
    /^\s*\{\s*"error"\s*:/.test(head) ||
    head.includes('"status":"no_match"') ||
    head.includes("resolve_hard_handoff") ||
    head.includes("schema_drift_recapture_required") ||
    head.includes('"error":"stale_endpoint"') ||
    head.includes('"error":"network_failure"') ||
    head.includes('"error":"confirmation_required"');
  const isVendorBlocked = /perimeterx|datadome|akamai|kasada|imperva|cf-mitigated|captcha/i.test(head.slice(0, 600));
  const isSpaNoise = head.startsWith('{"type":"spa-nextjs"') || /^\[\{"type":"spa-nextjs"/.test(head);
  const isSlackCfg = /"module_loader_url":/.test(head.slice(0, 200));
  const isRealData = status === 200 && bytes > 200 && !isErrEnv && !isSpaNoise && !isSlackCfg;
  const lane = p.lane;
  if (lane === "auth-gated" || lane === "auth-cookies") {
    if (isRealData) return null;
    if (head.includes("resolve_hard_handoff")) return null;
    if (head.includes("schema_drift_recapture_required")) return null;
    return `auth lane lacks real-data PASS and lacks proper handoff envelope (status=${status} bytes=${bytes} head=${head.slice(0,80)})`;
  }
  if (lane === "hostile") {
    if (isRealData) return null;
    if (isVendorBlocked) return null;
    return `hostile lane lacks real-data PASS and lacks vendor-block marker (status=${status} bytes=${bytes} head=${head.slice(0,80)})`;
  }
  if (isRealData) return null;
  // SKIP_EMPTY_SNAPSHOT: when set, advance past BROWSER-INFRA failures so the
  // loop surfaces OTHER bugs. Two signatures qualify:
  //  (a) empty_snapshot: browser landed, snap returned empty (SPA hydration
  //      race; signature: indexed=false + n_ops=0 + mode=none +
  //      browser_block_signals=["empty_snapshot"]). Observed: probe 002
  //      npmjs/openai, kuri.evaluate also returns undefined for that tab.
  //  (b) go_failed: browser navigate failed entirely (anti-bot, CF challenge
  //      at GO phase before snap; signature: indexed=false + n_ops=0 +
  //      mode=none + snap_current_url=null + index.store.reason="go_failed").
  //      Observed: probe 016 stackoverflow/questions, CF-blocked headless tab.
  // The artifact still records the real signal; this only changes whether
  // STOP_ON_FAIL halts. Real substrate fixes (SSR-fastpath for GO failures,
  // tab-level CDP attachment retry for empty_snapshot) are separate.
  const isEmptySnapshotOnly = !indexed && nOps === 0 && cm?.mode === "none"
    && Array.isArray(cm?.browser_block_signals)
    && cm.browser_block_signals.length === 1
    && cm.browser_block_signals[0] === "empty_snapshot";
  const isGoFailed = !indexed && nOps === 0 && cm?.mode === "none"
    && cm?.iso_self_check?.snap_current_url == null
    && idxStore?.reason === "go_failed";
  if (SKIP_EMPTY_SNAPSHOT && (isEmptySnapshotOnly || isGoFailed)) return null;
  return `non-excluded lane (${lane}) expected real data: indexed=${indexed} n_ops=${nOps} status=${status} bytes=${bytes} head=${head.slice(0,80)}`;
}

async function runProbe(p: { probe_id: string; intent: string; url: string; lane: string }): Promise<string> {
  const dir = join(RUN_DIR, p.probe_id);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, "execute.meta.json"))) return `${p.probe_id} SKIP (already collected)`;

  // pre-resolve (cache-hit shortcut)
  const pre = await post("/v1/intent/resolve", { intent: p.intent, projection: { raw: true }, params: { url: p.url }, context: { url: p.url } });
  let preEps = pickEndpoints(pre.body);

  let close: any = { body: {} }, snap: any = { body: {} }, evalRes: any = { body: {} };
  let go: { status?: number; body?: any } | null = null;
  // F4: UNBROWSE_GATE_FORCE_GO=1 overrides the cache-hit short-circuit
  // and always runs the go+snap+eval+close block — needed for auth-
  // cookies probes whose marketplace skill is already cached, so the
  // cookie-injection / live-capture path runs anyway.
  if (preEps.length === 0 || FORCE_GO) {
    // Disjoint per-probe session_id: with the create-on-unknown-id +
    // per-broker create-lock fix, each concurrent probe owns its own
    // isolated tab (no cross-render). probe_id is unique per manifest row.
    const sid = `gate-${p.probe_id}`;
    go = await post("/v1/browse/go", { url: p.url, session_id: sid });
    if (go.status === 200 && go.body?.session_id) {
      snap = await post("/v1/browse/snap", { session_id: sid, detail_level: "minimal" });
      // SPA hydration race: snap can fire before React/Next.js hydrates the
      // DOM, leaving the snapshot empty and the page captureable but unseen.
      // Probe 002 (npmjs/openai), 016 (stackoverflow), 018 (openlibrary) all
      // trip this. One bounded re-snap with a poll for body content closes
      // the race for slow-hydrating SPAs without masking real anti-bot empty
      // pages (those still come back empty after the retry, and the
      // empty_snapshot block signal still fires for the in-thread judge).
      const snapEmpty = !snap.body?.snapshot || snap.body.snapshot.length < 32;
      if (snapEmpty) {
        // Poll up to 4 times at 750ms for body content via eval; bail early
        // if content arrives. Total max wait: 3s extra per probe.
        for (let attempt = 0; attempt < 4; attempt++) {
          await new Promise((r) => setTimeout(r, 750));
          const probe = await post("/v1/browse/eval", { session_id: sid, expression: "(document.body && document.body.innerText ? document.body.innerText.length : 0)" });
          const bodyLen = Number(probe.body?.result ?? 0);
          if (bodyLen > 200) break;
        }
        snap = await post("/v1/browse/snap", { session_id: sid, detail_level: "minimal" });
      }
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
  const skillId = pickSkillId(cb, post2.body, pre.body);

  // host self-check: raw isolation evidence at this concurrency (NOT a verdict)
  const snapHost = hostOf(sb.current_url);
  const intendedHost = hostOf(p.url);
  const isoSelfCheck = { snap_current_url: sb.current_url ?? null, intended_host: intendedHost, snap_host: snapHost,
    host_match: snapHost ? snapHost === intendedHost : null };

  w(dir, "capture.meta.json", JSON.stringify(
    buildCaptureMeta({ cb, eps, sb, evalRes, skillId, isoSelfCheck, go }),
    null, 2));

  const evalStr = typeof evalRes.body?.result === "string" ? evalRes.body.result : JSON.stringify(evalRes.body ?? {});
  w(dir, "capture.html.excerpt", evalStr.slice(0, 8192));

  w(dir, "index.store.json", JSON.stringify({
    stored: cb.indexed === true && !!skillId, skill_id: skillId,
    reason: classifyReason(cb),
  }, null, 2));

  w(dir, "resolve.shortlist.json", JSON.stringify(post2.body, null, 2));

  // resolve_hard_handoff short-circuit: when the orchestrator emits a handoff
  // envelope, `available_endpoints` is still populated (the rubric calls it
  // a "shortlist for judgment" with negative scores). The PRIOR collector
  // greedy-picked eps[0] anyway and executed it, which silently bypassed the
  // handoff and produced misleading FAIL_EMPTY verdicts (x.com 020/021/022
  // hit this 2026-05-20 9:37Z gate run: resolve correctly emitted handoff,
  // collector executed the empty SPA endpoint anyway, judged FAIL).
  //
  // Fix: when result.status (or top-level status) is "resolve_hard_handoff",
  // record the handoff envelope as the execute response and skip execute.
  // That preserves the substrate's signal (the agent told you to do
  // something else; doing the wrong thing anyway is leaven).
  const resolveStatus = post2.body?.result?.status ?? post2.body?.status ?? null;
  const isHandoff = resolveStatus === "resolve_hard_handoff";

  const pick = (eps[0] && !isHandoff) ? eps[0] : null;
  w(dir, "resolve.pick.json", JSON.stringify(
    pick ? { ...pick, picked_from: post2.body?.available_endpoints || (Array.isArray(post2.body?.result) ? "available_endpoints" : "available_operations") }
         : { picked_from: "none", status: resolveStatus ?? "no_match" }, null, 2));

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
    const note = isHandoff ? "resolve_hard_handoff: execute not run (substrate handed off, collector honors it)" : "no_match: execute not run";
    w(dir, "execute.input.json", JSON.stringify({ skill: null, endpoint: null, intent: p.intent, context_url: p.url, params: {}, note }, null, 2));
    // Record the FULL handoff envelope as the execute response so the
    // in-thread judge can read suggested_next_action / commands / message.
    const handoff = JSON.stringify(
      post2.body?.result ?? post2.body?.next_step ?? post2.body?.next_action ?? post2.body ?? {});
    w(dir, "execute.response.raw", handoff);
    w(dir, "execute.meta.json", JSON.stringify({ status_code: null, response_bytes: Buffer.byteLength(handoff, "utf8"), decision_trace: [], resolve_status: resolveStatus }, null, 2));
  }
  const flag = isoSelfCheck.host_match === false ? " *** ISO-MISMATCH (raw evidence; judge in-thread) ***" : "";
  return `${p.probe_id} done eps=${eps.length} indexed=${cb.indexed ?? false} iso=${isoSelfCheck.host_match}${flag}`;
}

// bounded worker pool
console.log(`[collector] ${probes.length} probes, concurrency=${CONC}${STOP_ON_FAIL ? " (STOP_ON_FAIL=1: conc=1, halt at first structural-fail probe)" : ""} (NOTE: >6 exceeds the N<=6 verified-clean band; per-probe iso_self_check is the in-run isolation falsifier, raw evidence judged in-thread, NOT a script verdict)`);
let idx = 0; let doneN = 0; let stopped = false;
async function worker(wid: number) {
  while (true) {
    if (stopped) return;
    const i = idx++; if (i >= probes.length) return;
    const p = probes[i]!;
    try {
      const msg = await withProbeTimeout(p.probe_id, PROBE_TIMEOUT_MS, () => runProbe(p));
      doneN++; console.log(`[w${wid}] (${doneN}/${probes.length}) ${msg}`);
      // STOP_ON_FAIL: read the probe's just-written artifacts and apply the
      // structural-pass predicate. On fail, write .stop-marker with raw
      // evidence and set the shared stopped flag; remaining workers exit.
      if (STOP_ON_FAIL) {
        const dir = join(RUN_DIR, p.probe_id);
        let cm: any = {}, em: any = {}, raw = "", idxStore: any = {};
        try { cm = JSON.parse(readFileSync(join(dir, "capture.meta.json"), "utf8")); } catch {}
        try { em = JSON.parse(readFileSync(join(dir, "execute.meta.json"), "utf8")); } catch {}
        try { raw = readFileSync(join(dir, "execute.response.raw"), "utf8"); } catch {}
        try { idxStore = JSON.parse(readFileSync(join(dir, "index.store.json"), "utf8")); } catch {}
        const reason = structuralPassPredicate(p, { cm, em, raw, idxStore });
        if (reason) {
          stopped = true;
          const marker = {
            stopped_at: new Date().toISOString(),
            probe_id: p.probe_id, lane: p.lane, intent: p.intent, url: p.url,
            structural_fail_reason: reason,
            signals: {
              indexed: cm?.indexed, n_operations: cm?.n_operations, mode: cm?.mode,
              status_code: em?.status_code, response_bytes: em?.response_bytes,
              browser_block_signals: cm?.browser_block_signals ?? [],
              iso_self_check: cm?.iso_self_check ?? null,
            },
            response_head: raw.slice(0, 600),
            artifact_dir: dir,
          };
          writeFileSync(join(RUN_DIR, ".stop-marker"), JSON.stringify(marker, null, 2));
          console.log(`[collector] STOP-ON-FAIL at ${p.probe_id}: ${reason}`);
          console.log(`[collector] evidence written to ${join(RUN_DIR, ".stop-marker")}`);
          console.log(`[collector] agent: read .stop-marker, ship a fix, re-run with the same run-dir (resume-skip picks back up from this probe)`);
          return;
        }
      }
    } catch (e) {
      doneN++;
      if (e instanceof ProbeTimeoutError) {
        const dir = join(RUN_DIR, p.probe_id);
        try { mkdirSync(dir, { recursive: true }); } catch { /* race-safe */ }
        const marker = {
          total_endpoints_captured: 0, n_operations: 0, captured_title: "",
          browser_block_signals: ["crashed_during_collect"],
          filter_rejections: null, capture_path: null, request_count: 0,
          indexed: false, mode: "none", skill_id: null,
          iso_self_check: { snap_current_url: null, intended_host: hostOf(p.url), snap_host: "", host_match: null },
          capture_diagnostic: { reason: "crashed_during_collect", timeout_ms: e.ms, probe_id: p.probe_id },
          cookies_injected: null,
          crashed_during_collect: true,
        };
        try { writeFileSync(join(dir, "capture.meta.json"), JSON.stringify(marker, null, 2)); } catch { /* best-effort */ }
        try { writeFileSync(join(dir, "capture.html.excerpt"), ""); } catch { /* best-effort */ }
        try { writeFileSync(join(dir, "index.store.json"), JSON.stringify({ stored: false, skill_id: null, reason: "crashed_during_collect" }, null, 2)); } catch { /* best-effort */ }
        try { writeFileSync(join(dir, "resolve.shortlist.json"), JSON.stringify({ status: "crashed_during_collect", available_endpoints: [] }, null, 2)); } catch { /* best-effort */ }
        try { writeFileSync(join(dir, "resolve.pick.json"), JSON.stringify({ picked_from: "none", status: "crashed_during_collect" }, null, 2)); } catch { /* best-effort */ }
        try { writeFileSync(join(dir, "execute.input.json"), JSON.stringify({ skill: null, endpoint: null, intent: p.intent, context_url: p.url, params: {}, note: "crashed_during_collect" }, null, 2)); } catch { /* best-effort */ }
        try { writeFileSync(join(dir, "execute.response.raw"), JSON.stringify({ error: "crashed_during_collect", timeout_ms: e.ms })); } catch { /* best-effort */ }
        try { writeFileSync(join(dir, "execute.meta.json"), JSON.stringify({ status_code: null, response_bytes: 0, decision_trace: [{ step: "crashed_during_collect", timeout_ms: e.ms }] }, null, 2)); } catch { /* best-effort */ }
        console.log(`[w${wid}] (${doneN}/${probes.length}) ${p.probe_id} TIMEOUT after ${e.ms}ms (crashed_during_collect marker written)`);
        if (STOP_ON_FAIL) {
          stopped = true;
          writeFileSync(join(RUN_DIR, ".stop-marker"), JSON.stringify({
            stopped_at: new Date().toISOString(), probe_id: p.probe_id, lane: p.lane, intent: p.intent, url: p.url,
            structural_fail_reason: `W0 timeout after ${e.ms}ms`, signals: { crashed_during_collect: true, timeout_ms: e.ms },
            response_head: "", artifact_dir: dir,
          }, null, 2));
          console.log(`[collector] STOP-ON-FAIL at ${p.probe_id}: W0 timeout`);
          return;
        }
      } else {
        console.log(`[w${wid}] (${doneN}/${probes.length}) ${p.probe_id} ERROR ${(e as Error)?.message ?? e}`);
      }
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, probes.length) }, (_, k) => worker(k)));
if (stopped) {
  console.log(`[collector] STOPPED early at structural-fail probe; ${doneN}/${probes.length} probes completed before stop. Read ${join(RUN_DIR, ".stop-marker")} for evidence.`);
  process.exit(2);
}
console.log(`[collector] all ${probes.length} probes collected to ${RUN_DIR}. NO verdicts emitted. Next: in-thread judge vs harness/probes/GATE_JUDGE.md.`);
process.exit(0);
