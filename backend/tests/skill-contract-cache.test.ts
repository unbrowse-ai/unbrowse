import { test, expect } from "bun:test";
import { makeSkill } from "./fixtures/skill";
import {
  fingerprintSkillContract,
  memoizeSkillValue,
  kvContentStore,
  kvPointerIndex,
  sha256Hex,
} from "../src/services/skill-contract-cache";

// Witness for the skill-/contract as a MEMOIZED PROMISE (docker-layer-cache):
// hit replays, fingerprint-change invalidates → re-execute, value↔pointer indirection.

// in-memory KV (the injected substrate; real route uses statsKV)
function memKV() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) };
}
function harness() {
  const kv = memKV();
  return { kv, store: kvContentStore(kv), index: kvPointerIndex(kv) };
}

// ── HIT replays: same fingerprint → recompute fires ONCE ────────────────────
test("memoized promise: same fingerprint → MISS then HIT, recompute fires once", async () => {
  const { store, index } = harness();
  const skill = makeSkill();
  const fp = fingerprintSkillContract(skill, "find a widget", "contract-llm-chain-v1");
  let recomputes = 0;
  const recompute = async () => { recomputes++; return `answer-${recomputes}`; };

  const first = await memoizeSkillValue({ store, index, fingerprint: fp, recompute });
  expect(first.hit).toBe(false);
  expect(first.value).toBe("answer-1");
  expect(first.pointer.startsWith("sha256:")).toBe(true);   // value addressed by content hash

  const second = await memoizeSkillValue({ store, index, fingerprint: fp, recompute });
  expect(second.hit).toBe(true);                            // HIT replays
  expect(second.value).toBe("answer-1");                   // byte-identical, NOT recomputed
  expect(second.pointer).toBe(first.pointer);              // same content pointer
  expect(recomputes).toBe(1);                              // the promise executed exactly once
});

// ── INVALIDATION through the content hash: change an input → MISS → re-execute ─
test("fingerprint change (version / reliability) → old pointer misses → re-executes", async () => {
  const { store, index } = harness();
  const base = makeSkill();
  let recomputes = 0;
  const recompute = async () => { recomputes++; return `answer-${recomputes}`; };

  await memoizeSkillValue({ store, index, fingerprint: fingerprintSkillContract(base, "q", "m"), recompute });
  expect(recomputes).toBe(1);

  // bump the skill VERSION → fingerprint moves → cache miss → re-execute
  const bumped = makeSkill({ version: "2.0.0" });
  const r2 = await memoizeSkillValue({ store, index, fingerprint: fingerprintSkillContract(bumped, "q", "m"), recompute });
  expect(r2.hit).toBe(false);
  expect(recomputes).toBe(2);                              // Docker rebuild: changed input → recompute

  // drop an endpoint's RELIABILITY → fingerprint moves again → miss → re-execute
  const degraded = makeSkill({ endpoints: [
    { endpoint_id: "ep_search", method: "GET", url_template: "https://acme.com/api/search?q={q}", description: "Search", reliability_score: 0.10, verification_status: "verified" },
    { endpoint_id: "ep_detail", method: "GET", url_template: "https://acme.com/api/product/{id}", description: "Detail", reliability_score: 0.88, verification_status: "verified" },
  ] as never });
  const r3 = await memoizeSkillValue({ store, index, fingerprint: fingerprintSkillContract(degraded, "q", "m"), recompute });
  expect(r3.hit).toBe(false);
  expect(recomputes).toBe(3);

  // and the ORIGINAL fingerprint still HITS its old immutable value (old layer persists)
  const back = await memoizeSkillValue({ store, index, fingerprint: fingerprintSkillContract(base, "q", "m"), recompute });
  expect(back.hit).toBe(true);
  expect(back.value).toBe("answer-1");
  expect(recomputes).toBe(3);                              // no extra recompute
});

// ── value→pointer→value, and pointer→pointer→value indirection (if surfaced) ──
test("content store: value→pointer round-trips, and follows a pointer→pointer hop", async () => {
  const { kv, store } = harness();
  const ptr = await store.put("the-value");
  expect(ptr).toBe(`sha256:${await sha256Hex("the-value")}`);
  expect(await store.get(ptr)).toBe("the-value");          // value ↔ pointer

  // surface an indirection: an alias pointer whose stored content is ANOTHER pointer
  const alias = "sha256:aliaspointer";
  await kv.put(`cas:${alias}`, ptr);                       // alias → ptr → value
  expect(await store.get(alias)).toBe("the-value");        // followed pointer→pointer→value
  expect(await store.get("sha256:does-not-exist")).toBeNull();
});

// ── intent is load-bearing: different intent → different fingerprint (no false share)
test("different intent → different fingerprint (no false cache share)", async () => {
  const skill = makeSkill();
  const a = fingerprintSkillContract(skill, "find a widget", "m");
  const b = fingerprintSkillContract(skill, "delete everything", "m");
  expect(a).not.toBe(b);
});
