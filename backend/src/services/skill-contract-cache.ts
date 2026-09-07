/**
 * skill-contract-cache.ts — the skill-/contract as a MEMOIZED PROMISE.
 *
 * Docker-layer-cache semantics (crypto-was-all-you-needed.md, made real):
 *   - a skill-contract's value is memoized under a content-addressed pointer
 *     (value↔pointer; the lookup key is the hash of the contract's FINGERPRINT,
 *     the pointer is the hash of the value → fpKey→pointer→value indirection).
 *   - HIT replays the cached value (no recompute).
 *   - MISS recomputes (re-executes the promise) and stores it.
 *   - INVALIDATION needs no flush: it auto-triggers through the content hash —
 *     change any load-bearing input (skill version, an endpoint's reliability/
 *     verification, the intent, the model) and the fingerprint hash moves, so
 *     the old pointer is no longer the lookup key → MISS → re-execute. The old
 *     value persists immutably (old layers stay), it just isn't looked up.
 *
 * Store + index are injected so the docker-cache semantics witness hermetically;
 * the route wires KV-backed, best-effort (a KV outage degrades to always-miss,
 * never a wrong value). Private (backend-only).
 */

import type { SkillManifest } from "../types.js";

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every load-bearing input. Change any → new hash → cache miss → re-execute.
 *  Under-keying here would serve a STALE value (worse than a miss), so this must
 *  capture skill identity+version, each endpoint's reliability/verification, the
 *  intent, and the model. */
export function fingerprintSkillContract(skill: SkillManifest, intent: string, model: string): string {
  const eps = (skill.endpoints ?? [])
    .map((e) => `${e.endpoint_id}@${e.verification_status ?? "?"}:${(e.reliability_score ?? 0).toFixed(2)}`)
    .sort()
    .join("|");
  return `v1;skill=${skill.skill_id}@${skill.version};model=${model};intent=${intent.trim().toLowerCase()};eps=${eps}`;
}

/** Content-addressed value store: put(value)→"sha256:<hex>", get(pointer)→value
 *  (follows one pointer→pointer hop if a stored value is itself a pointer). */
export interface ContentStore {
  put(value: string): Promise<string>;
  get(pointer: string): Promise<string | null>;
}

export interface PointerIndex {
  get(key: string): Promise<string | null>;
  put(key: string, pointer: string): Promise<void>;
}

export interface MemoResult {
  value: string;
  pointer: string;
  hit: boolean;
}

/**
 * Resolve a skill-contract value as a memoized promise. HIT → cached value;
 * MISS → `recompute()` then store. `recompute` is the only thing allowed to
 * throw (e.g. the LLM has no key) — a thrown recompute is NOT memoized.
 */
export async function memoizeSkillValue(opts: {
  store: ContentStore;
  index: PointerIndex;
  fingerprint: string;
  recompute: () => Promise<string>;
}): Promise<MemoResult> {
  const fpKey = `skill-memo:${await sha256Hex(opts.fingerprint)}`;
  const existingPtr = await opts.index.get(fpKey);
  if (existingPtr) {
    const cached = await opts.store.get(existingPtr);
    if (cached != null) return { value: cached, pointer: existingPtr, hit: true };  // HIT replays
  }
  const value = await opts.recompute();                                            // MISS rebuilds
  const pointer = await opts.store.put(value);
  await opts.index.put(fpKey, pointer);                                            // fpKey → pointer → value
  return { value, pointer, hit: false };
}

/** KV-backed content store. Best-effort: a KV error degrades to a miss (recompute),
 *  never a wrong value. Follows one pointer→pointer indirection hop. */
export function kvContentStore(kv: { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> }): ContentStore {
  return {
    async put(value) {
      const ptr = `sha256:${await sha256Hex(value)}`;
      try { await kv.put(`cas:${ptr}`, value); } catch { /* best-effort */ }
      return ptr;
    },
    async get(pointer) {
      let p: string | null = pointer;
      for (let hop = 0; p && p.startsWith("sha256:") && hop < 2; hop++) {
        let v: string | null;
        try { v = await kv.get(`cas:${p}`); } catch { return null; }
        if (v == null) return null;
        if (v.startsWith("sha256:")) { p = v; continue; }   // pointer → pointer
        return v;                                           // → value
      }
      return null;
    },
  };
}

/** KV-backed fingerprint→pointer index. Best-effort (errors → miss). */
export function kvPointerIndex(kv: { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> }): PointerIndex {
  return {
    async get(key) { try { return await kv.get(key); } catch { return null; } },
    async put(key, pointer) { try { await kv.put(key, pointer); } catch { /* best-effort */ } },
  };
}
