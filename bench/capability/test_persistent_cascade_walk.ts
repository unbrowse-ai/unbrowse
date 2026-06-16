// Witness (jesus-loop): the persistent values-ledger cascade is WIRED INTO walkPrerequisiteChain.
// Two independent witnesses (Matt 18:16):
//   PART 1 — BEHAVIORAL, on a REAL temp ledger: drive cachedResolution with the EXACT
//            key/principal/dependsOn the walk builds, and prove the four invariants:
//            (a) persist+replay, (b) principal partition, (c) pointer→pointer cascade, (d) cacheable gate.
//   PART 2 — STRUCTURAL: the walk's source actually passes principal + dependsOn + cacheable to
//            cachedResolution (the primitive proven in part 1 is genuinely called by the walk).
// Run: bun bench/capability/test_persistent_cascade_walk.ts
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedResolution } from "../../src/values/cached-resolution.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

// The exact per-step key the walk builds: `prereq ${skill_id}|${prereqId}|${queryIntent}`.
const keyFor = (prereqId: string) => `prereq sk_demo|${prereqId}|find the latest order`;
const TTL = 600_000;

// A prerequisite execution the walk would run: returns { ok, yields }. We control the yielded value so
// a VALUE change is observable. `calls` counts real recomputes (a replay must NOT increment it).
function makePrereq(value: string) {
  let calls = 0;
  const run = async () => { calls++; return { ok: true, yields: { token: value } }; };
  return { run, calls: () => calls };
}
const cacheable = (r: { ok: boolean; yields: Record<string, unknown> }) => r.ok && Object.keys(r.yields).length > 0;

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "cascade-walk-"));
  try {
    // ---- PART 1a: PERSIST + REPLAY (ACC#1) ----
    const A1 = makePrereq("AAA");
    const first = await cachedResolution({ key: keyFor("login"), ttlMs: TTL, dir, cacheable, recompute: A1.run });
    ok(first.cached === false && A1.calls() === 1, "first walk EXECUTES the prerequisite (cold miss)");
    ok(typeof first.pointer === "string" && first.pointer!.length > 0, "a content pointer is surfaced for the step");
    const A2 = makePrereq("AAA");
    const replay = await cachedResolution({ key: keyFor("login"), ttlMs: TTL, dir, cacheable, recompute: A2.run });
    ok(replay.cached === true && A2.calls() === 0, "second walk REPLAYS from the ledger (no re-execute)");
    ok((replay.value as any).yields.token === "AAA", "replayed yields are the stored ones");

    // ---- PART 1b: PRINCIPAL PARTITION (ACC#3) — a different principal never replays the authed yield ----
    const P1 = makePrereq("alice-token");
    await cachedResolution({ key: keyFor("login"), ttlMs: TTL, dir, principal: "alice-cred", cacheable, recompute: P1.run });
    const P2 = makePrereq("bob-token");
    const bob = await cachedResolution({ key: keyFor("login"), ttlMs: TTL, dir, principal: "bob-cred", cacheable, recompute: P2.run });
    ok(bob.cached === false && P2.calls() === 1, "different principal → NO cross-tenant replay (recompute)");
    const P1b = makePrereq("alice-token-2");
    const aliceAgain = await cachedResolution({ key: keyFor("login"), ttlMs: TTL, dir, principal: "alice-cred", cacheable, recompute: P1b.run });
    ok(aliceAgain.cached === true && P1b.calls() === 0, "same principal still replays its own partition");

    // ---- PART 1c: POINTER→POINTER CASCADE (ACC#1 live) — step B folds the prior step's pointer ----
    // Step A produces a pointer; step B dependsOn=[A.pointer]. Change A's VALUE → A.pointer changes →
    // B re-keys → B recomputes (cascade). Unchanged A → B replays.
    const Aold = await cachedResolution({ key: keyFor("login"), ttlMs: TTL, dir, principal: "carol", cacheable, recompute: makePrereq("v1").run });
    const Bfirst = makePrereq("feed-1");
    await cachedResolution({ key: keyFor("feed"), ttlMs: TTL, dir, principal: "carol", dependsOn: [Aold.pointer!], cacheable, recompute: Bfirst.run });
    const Breplay = makePrereq("feed-1");
    const bReplay = await cachedResolution({ key: keyFor("feed"), ttlMs: TTL, dir, principal: "carol", dependsOn: [Aold.pointer!], cacheable, recompute: Breplay.run });
    ok(bReplay.cached === true && Breplay.calls() === 0, "B replays while its dependency pointer is unchanged");
    // A's value changes → a NEW pointer; B with the new dependsOn must MISS (cascade-invalidate).
    const Anew = await cachedResolution({ key: keyFor("login2"), ttlMs: TTL, dir, principal: "carol", cacheable, recompute: makePrereq("v2").run });
    ok(Anew.pointer !== Aold.pointer, "a producer VALUE change → a different content pointer");
    const Bafter = makePrereq("feed-2");
    const bAfter = await cachedResolution({ key: keyFor("feed"), ttlMs: TTL, dir, principal: "carol", dependsOn: [Anew.pointer!], cacheable, recompute: Bafter.run });
    ok(bAfter.cached === false && Bafter.calls() === 1, "dependency pointer changed → B cascade-invalidates (recompute)");

    // ---- PART 1d: CACHEABLE GATE — an error / empty prerequisite is NEVER stored ----
    let errCalls = 0;
    const errRun = async () => { errCalls++; return { ok: false, yields: {} as Record<string, unknown> }; };
    const e1 = await cachedResolution({ key: keyFor("broken"), ttlMs: TTL, dir, cacheable, recompute: errRun });
    ok(e1.pointer == null, "an unsuccessful/empty prerequisite is NOT persisted (no pointer)");
    await cachedResolution({ key: keyFor("broken"), ttlMs: TTL, dir, cacheable, recompute: errRun });
    ok(errCalls === 2, "the error prerequisite honestly retries next walk (never a cached blank)");

    // ---- PART 1e: STATELESS PASS-THROUGH — ttl<=0 → behaviour unchanged (no persistence) ----
    let sCalls = 0;
    const sRun = async () => { sCalls++; return { ok: true, yields: { token: "x" } }; };
    await cachedResolution({ key: keyFor("login"), ttlMs: 0, dir, cacheable, recompute: sRun });
    const s2 = await cachedResolution({ key: keyFor("login"), ttlMs: 0, dir, cacheable, recompute: sRun });
    ok(sCalls === 2 && s2.cached === false, "ttl<=0 (UNBROWSE_STATELESS) → pass-through, every call executes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- PART 2: STRUCTURAL — the walk genuinely passes principal + dependsOn + cacheable ----
  const src = readFileSync(new URL("../../src/orchestrator/index.ts", import.meta.url), "utf8");
  const walk = src.slice(src.indexOf("async function walkPrerequisiteChain"), src.indexOf("async function inferParamsFromIntent"));
  // Isolate the actual cachedResolution CALL OBJECT so the checks test what is PASSED, not a
  // nearby declaration or comment (mutation-proven: stripping `principal,`/`dependsOn,` from the
  // call must turn these red — declaration-only greps stayed painted-green and were rejected).
  const callStart = walk.indexOf("await cachedResolution<");
  const callObj = walk.slice(callStart, walk.indexOf("recompute:", callStart));
  ok(callStart >= 0, "walkPrerequisiteChain CALLS cachedResolution (the prereq is persisted)");
  ok(/\n\s*principal,\s*\n/.test(callObj), "the call PASSES principal (verified auth credential → no cross-tenant leak)");
  ok(/const principal = credentialFromAuthHeaders\(baseParams\.auth_headers/.test(walk), "that principal IS the verified auth credential, not a self-asserted header");
  ok(/\n\s*dependsOn,\s*\n/.test(callObj), "the call PASSES dependsOn (the pointer→pointer cascade edge)");
  ok(/const dependsOn = priorPointer \? \[priorPointer\] : undefined/.test(walk), "dependsOn binds the PRIOR step's pointer (the ordered cascade chain)");
  ok(/cacheable:\s*\(r\)\s*=>\s*r\.ok\s*&&\s*Object\.keys\(r\.yields\)\.length\s*>\s*0/.test(callObj), "the call PASSES the cacheable gate excluding error/empty/auth-required results");
  ok(/ttlMs:\s*prereqTtlMs,/.test(callObj) && /UNBROWSE_STATELESS/.test(src), "the call is ttl-gated (pass-through under UNBROWSE_STATELESS)");

  console.log(fails === 0 ? "\nPERSISTENT CASCADE WALK WITNESS PASSES" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main();
