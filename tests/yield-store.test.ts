/**
 * yield-store.test — the pipe between holes: a write's yield fills a downstream hole.
 */
import { describe, expect, it } from "bun:test";
import {
  recordYields,
  fillHolesFromYields,
  getYieldCache,
  isYieldStale,
  clearSessionYields,
  type YieldStore,
} from "../src/runtime/yield-store.js";
import type { OperationBinding } from "../src/types/skill.js";

const provides = (kv: Record<string, unknown>): OperationBinding[] =>
  Object.entries(kv).map(([key, example_value]) => ({ key, source: "response", example_value }));
const requires = (...keys: string[]): OperationBinding[] =>
  keys.map((key) => ({ key, required: true, source: "body" }));

describe("yield-store — write→hole pipe", () => {
  it("the golden path: a write's provides fills a downstream requires hole", () => {
    const store: YieldStore = new Map();
    // write op yields id=101
    expect(recordYields("s1", provides({ id: 101 }), { store })).toBe(1);
    // downstream op needs {id, title}; title supplied, id is an unfilled hole
    const params: Record<string, unknown> = { title: "hi" };
    const { filled } = fillHolesFromYields("s1", requires("id", "title"), params, { store });
    expect(filled).toEqual(["id"]);
    expect(params).toEqual({ title: "hi", id: 101 });
  });

  it("never overwrites an already-filled hole", () => {
    const store: YieldStore = new Map();
    recordYields("s1", provides({ id: 101 }), { store });
    const params = { id: 999 };
    const { filled } = fillHolesFromYields("s1", requires("id"), params, { store });
    expect(filled).toEqual([]);
    expect(params.id).toBe(999);
  });

  it("yields are session-scoped — no cross-session bleed", () => {
    const store: YieldStore = new Map();
    recordYields("s1", provides({ id: 101 }), { store });
    const params: Record<string, unknown> = {};
    const { filled } = fillHolesFromYields("s2", requires("id"), params, { store });
    expect(filled).toEqual([]);
    expect(params).toEqual({});
  });

  it("single_use yields are consumed on fill", () => {
    const store: YieldStore = new Map();
    const su: OperationBinding[] = [{ key: "token", source: "response", example_value: "t1", single_use: true }];
    recordYields("s1", su, { store });
    const p1: Record<string, unknown> = {};
    expect(fillHolesFromYields("s1", requires("token"), p1, { store }).filled).toEqual(["token"]);
    // second consumer gets nothing — the single-use yield was consumed
    const p2: Record<string, unknown> = {};
    expect(fillHolesFromYields("s1", requires("token"), p2, { store }).filled).toEqual([]);
  });

  it("stale (ttl) yields do not fill", () => {
    const store: YieldStore = new Map();
    const old = new Date(Date.now() - 10_000).toISOString();
    recordYields("s1", [{ key: "id", source: "response", example_value: 5, ttl_ms: 1000, observed_at: old }], { store });
    const params: Record<string, unknown> = {};
    const { filled } = fillHolesFromYields("s1", requires("id"), params, { store });
    expect(filled).toEqual([]);
  });

  it("getYieldCache returns the cache for the chain-walker, clear drops it", () => {
    const store: YieldStore = new Map();
    recordYields("s1", provides({ id: 1 }), { store });
    expect(getYieldCache("s1", { store })?.get("id")?.value).toBe(1);
    clearSessionYields("s1", { store });
    expect(getYieldCache("s1", { store })).toBeUndefined();
  });

  it("isYieldStale honours ttl", () => {
    const now = 1_000_000;
    expect(isYieldStale({ value: 1, observed_at: new Date(now - 2000).toISOString(), ttl_ms: 1000 }, now)).toBe(true);
    expect(isYieldStale({ value: 1, observed_at: new Date(now - 500).toISOString(), ttl_ms: 1000 }, now)).toBe(false);
    expect(isYieldStale({ value: 1, observed_at: new Date(now).toISOString() }, now)).toBe(false); // no ttl = never stale
  });
});
