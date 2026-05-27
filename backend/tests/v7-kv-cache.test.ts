/**
 * KV response-cache helper — W17 wave (2026-05-28).
 *
 * Same Map-backed in-memory KVNamespace pattern as v7-audit-log.test.ts and
 * crypto-sub.test.ts (per CLAUDE.md "Never mock in tests": the in-memory KV
 * IS KV semantics; it does not stub the surface under test, only its
 * substrate). The withCache helper itself is exercised here without
 * stubbing — every code path through it sees real reads/writes against a
 * Map that implements the cf KVNamespace contract.
 *
 * Heb 6:18 — the etag is the immutable witness; the same input always
 * yields the same etag. Matt 6:34 — sufficient unto the day; what was
 * computed need not be recomputed.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  withCache,
  resolveCacheKey,
  auditVerifyCacheKey,
  sponsorCacheKey,
  marketplaceCacheKey,
  buildCacheHeaders,
  CacheNotModified,
  normalizeResolveUrl,
} from "../src/services/kv-cache.js";
import { auditRoutes } from "../src/routes/audit.js";
import {
  canonicalizeSignedFragment,
  type AuditFillBody,
} from "../src/services/audit.js";
import type { Env } from "../src/types.js";

// ─── In-memory KVNamespace stand-in ────────────────────────────────────────

interface MemoryKV extends KVNamespace {
  _dump(): Map<string, string>;
  _putCalls: number;
  _getCalls: number;
}

function makeMemoryKv(): MemoryKV {
  const store = new Map<string, string>();
  let putCalls = 0;
  let getCalls = 0;
  const kv = {
    get: async (key: string) => {
      getCalls++;
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      putCalls++;
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts?: { prefix?: string; limit?: number }) => {
      const prefix = opts?.prefix ?? "";
      const limit = opts?.limit ?? 1000;
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    _dump: () => store,
    get _putCalls() {
      return putCalls;
    },
    get _getCalls() {
      return getCalls;
    },
  };
  return kv as unknown as MemoryKV;
}

function makeCtx(): { waitUntil(p: Promise<unknown>): void; _awaitAll(): Promise<void> } {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(p) {
      promises.push(p);
    },
    async _awaitAll() {
      // Settle every queued background task so the test's assertions
      // see post-write state. Errors are swallowed (waitUntil itself
      // doesn't surface them); the helper's internal .catch arms
      // already log them.
      await Promise.allSettled(promises);
    },
  };
}

function makeEnv(kv: KVNamespace | undefined): Env {
  return {
    RESPONSE_CACHE: kv,
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-test",
  } as unknown as Env;
}

// ─── 1. Cache miss → compute called once; returns hit:false ────────────────

describe("withCache — basic miss/hit semantics", () => {
  test("miss → compute called once; returns hit:false with deterministic etag", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const ctx = makeCtx();

    let computeCalls = 0;
    const r1 = await withCache<{ x: number }>(
      env,
      "cache:test:basic",
      60,
      { ctx },
      async () => {
        computeCalls++;
        return { x: 42 };
      },
    );
    expect(computeCalls).toBe(1);
    expect(r1.hit).toBe(false);
    expect(r1.status).toBe("MISS");
    expect(r1.value).toEqual({ x: 42 });
    expect(r1.etag.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(r1.etag)).toBe(true);

    // Wait for background put to land.
    await ctx._awaitAll();
    expect(kv._dump().has("cache:test:basic")).toBe(true);
  });

  test("hit within TTL → compute NOT called; same etag", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const ctx = makeCtx();

    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { x: 42 };
    };
    const r1 = await withCache(env, "cache:test:hit", 60, { ctx }, compute);
    await ctx._awaitAll();

    const r2 = await withCache(env, "cache:test:hit", 60, { ctx }, compute);
    expect(computeCalls).toBe(1); // Hit suppressed second compute.
    expect(r2.hit).toBe(true);
    expect(r2.status).toBe("HIT");
    expect(r2.etag).toBe(r1.etag); // Deterministic — same value, same etag.
  });
});

// ─── 2. bypass:true → compute called even on hit ───────────────────────────

describe("withCache — bypass honors Cache-Control: no-cache", () => {
  test("bypass:true → compute fires even when cache row exists", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const ctx = makeCtx();

    let v = 1;
    const compute = async () => ({ v: v++ });
    const r1 = await withCache(env, "cache:test:bypass", 60, { ctx }, compute);
    await ctx._awaitAll();
    expect(r1.value).toEqual({ v: 1 });

    const r2 = await withCache(env, "cache:test:bypass", 60, { bypass: true, ctx }, compute);
    expect(r2.status).toBe("BYPASS");
    expect(r2.hit).toBe(false);
    expect(r2.value).toEqual({ v: 2 }); // Fresh compute.

    // Bypass still writes through.
    await ctx._awaitAll();
    const r3 = await withCache(env, "cache:test:bypass", 60, { ctx }, compute);
    expect(r3.hit).toBe(true);
    expect(r3.value).toEqual({ v: 2 }); // The bypass write is what we see now.
  });
});

// ─── 3. SWR — past ttl/2 → returns stale + fires refresh in ctx.waitUntil ──

describe("withCache — staleWhileRevalidate", () => {
  test("row past ttl/2 returns stale + kicks off refresh; later read sees fresh", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const ctx = makeCtx();

    // Seed an old row by writing manually with _cached_at in the past.
    const oldRow = {
      _cached_at: Date.now() - 40_000, // 40s ago
      _ttl_sec: 60, // ttl/2 = 30s → 40s is stale
      _etag: "deadbeefdeadbeef",
      value: { v: "old" },
    };
    await kv.put("cache:test:swr", JSON.stringify(oldRow));

    let computeCalls = 0;
    const compute = async () => {
      computeCalls++;
      return { v: "fresh" };
    };

    const r = await withCache(
      env,
      "cache:test:swr",
      60,
      { staleWhileRevalidate: true, ctx },
      compute,
    );
    // Stale-while-revalidate served the OLD value immediately.
    expect(r.status).toBe("STALE-WHILE-REVALIDATE");
    expect(r.hit).toBe(true);
    expect(r.value).toEqual({ v: "old" });
    // The refresh promise is queued via ctx.waitUntil — compute may have
    // started in the same microtask (V8 begins the async body synchronously
    // up to the first await) but cannot have COMPLETED before we drain.
    // The load-bearing invariant is that withCache returned `r` WITHOUT
    // awaiting compute — the stale value reached the caller first.

    // Drain the background refresh.
    await ctx._awaitAll();
    expect(computeCalls).toBe(1);

    // Next read sees the fresh value.
    const ctx2 = makeCtx();
    const r2 = await withCache(
      env,
      "cache:test:swr",
      60,
      { staleWhileRevalidate: true, ctx: ctx2 },
      compute,
    );
    expect(r2.value).toEqual({ v: "fresh" });
  });
});

// ─── 4. honorIfNoneMatch matches → throws CacheNotModified ─────────────────

describe("withCache — honorIfNoneMatch / 304 short-circuit", () => {
  test("matching etag throws CacheNotModified with etag attached", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const ctx = makeCtx();

    const r1 = await withCache(
      env,
      "cache:test:inm",
      60,
      { ctx },
      async () => ({ msg: "hello" }),
    );
    await ctx._awaitAll();

    let thrown: CacheNotModified | null = null;
    try {
      await withCache(
        env,
        "cache:test:inm",
        60,
        { honorIfNoneMatch: r1.etag, ctx },
        async () => ({ msg: "would-not-be-called" }),
      );
    } catch (err) {
      if (err instanceof CacheNotModified) thrown = err;
      else throw err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.etag).toBe(r1.etag);
  });

  test("non-matching etag returns 200-ish hit, no throw", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const ctx = makeCtx();

    await withCache(env, "cache:test:inm2", 60, { ctx }, async () => ({ msg: "x" }));
    await ctx._awaitAll();

    const r = await withCache(
      env,
      "cache:test:inm2",
      60,
      { honorIfNoneMatch: "0000000000000000", ctx },
      async () => ({ msg: "x" }),
    );
    expect(r.hit).toBe(true);
    expect(r.status).toBe("HIT");
  });
});

// ─── 5. Binding absent → falls through to compute, no throw, no cache write ─

describe("withCache — RESPONSE_CACHE binding absent", () => {
  test("compute fires; status=BINDING-MISSING; no throw", async () => {
    const env = makeEnv(undefined); // RESPONSE_CACHE undefined
    let computeCalls = 0;
    const r = await withCache(
      env,
      "cache:test:nobinding",
      60,
      {},
      async () => {
        computeCalls++;
        return { x: 7 };
      },
    );
    expect(computeCalls).toBe(1);
    expect(r.status).toBe("BINDING-MISSING");
    expect(r.hit).toBe(false);
    expect(r.value).toEqual({ x: 7 });
  });
});

// ─── 6. Audit-verify route smoke — first MISS, second HIT, NO pointer leak ──

const ADMIN_KEY = "test-admin-secret-key";

function makeAuditEnv(responseCache: KVNamespace, auditLog: KVNamespace): Env {
  return {
    RESPONSE_CACHE: responseCache,
    AUDIT_LOG: auditLog,
    ADMIN_KEY,
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-test",
  } as unknown as Env;
}

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function bytesToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash));
}
async function genKeypair() {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: bytesToHex(pubRaw), privKey: kp.privateKey };
}
async function buildSignedFillBody(
  pubHex: string,
  privKey: CryptoKey,
  pointer = "op://Vault/Login/password",
): Promise<AuditFillBody> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = bytesToBase64(nonceBytes);
  const contextHash = await sha256Hex("ctx:" + Math.random());
  const commitment = await sha256Hex(`val:${nonce}`);
  const selectorHash = await sha256Hex("input#password");
  const partial: Omit<AuditFillBody, "signature"> = {
    pointer,
    nonce,
    contextHash,
    commitment,
    walletPubkey: pubHex,
    signatureScheme: "ed25519-v7.0",
    variant: "fill",
    selectorHash,
  };
  const canonical = canonicalizeSignedFragment(partial);
  const sigBytes = await crypto.subtle.sign(
    { name: "Ed25519" },
    privKey,
    new TextEncoder().encode(canonical),
  );
  return { ...partial, signature: bytesToHex(sigBytes) };
}

describe("audit-verify route integration — cache MISS then HIT", () => {
  test("first verify = MISS, second = HIT, body contains ONLY {verify_ok, scheme} — no pointer", async () => {
    const app = new Hono();
    app.route("/", auditRoutes);
    const responseCache = makeMemoryKv();
    const auditLog = makeMemoryKv();
    const env = makeAuditEnv(responseCache, auditLog);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildSignedFillBody(
      pubHex,
      privKey,
      "op://Vault/UNIQUE-LEAK-CANARY-W17-CACHE/field",
    );

    // POST: persist the row.
    const postRes = await app.fetch(
      new Request("http://test.local/v1/audit/fill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    const postJson = (await postRes.json()) as Record<string, unknown>;
    const receiptId = postJson.receiptId as string;
    expect(postJson.verify_ok).toBe(true);

    // First verify = MISS.
    const v1Res = await app.fetch(
      new Request(`http://test.local/v1/audit/verify/${receiptId}`),
      env,
    );
    expect(v1Res.status).toBe(200);
    expect(v1Res.headers.get("X-Cache")).toBe("MISS");
    const v1Etag = v1Res.headers.get("ETag");
    expect(v1Etag).toMatch(/^"[0-9a-f]{16}"$/);
    const v1Body = (await v1Res.json()) as Record<string, unknown>;
    expect(v1Body.verify_ok).toBe(true);
    expect(v1Body.scheme).toBe("ed25519-v7.0");
    expect(v1Body.receiptId).toBe(receiptId);
    // Pointer leak guard: cached payload carries ONLY {verify_ok, scheme}.
    expect("pointer" in v1Body).toBe(false);
    expect(JSON.stringify(v1Body)).not.toContain("UNIQUE-LEAK-CANARY");

    // Second verify = HIT (same etag).
    const v2Res = await app.fetch(
      new Request(`http://test.local/v1/audit/verify/${receiptId}`),
      env,
    );
    expect(v2Res.status).toBe(200);
    expect(v2Res.headers.get("X-Cache")).toBe("HIT");
    expect(v2Res.headers.get("ETag")).toBe(v1Etag);
    const v2Body = (await v2Res.json()) as Record<string, unknown>;
    expect(v2Body.verify_ok).toBe(true);
    expect("pointer" in v2Body).toBe(false);
    expect(JSON.stringify(v2Body)).not.toContain("UNIQUE-LEAK-CANARY");

    // Hard scope assertion on what KV actually stored under
    // cache:audit-verify:* — the row's `value` field carries ONLY the
    // two whitelisted keys, NEVER the pointer/body.
    const cacheRowJson = responseCache._dump().get(auditVerifyCacheKey(receiptId));
    expect(cacheRowJson).toBeDefined();
    const cacheRow = JSON.parse(cacheRowJson!);
    expect(Object.keys(cacheRow.value).sort()).toEqual(["scheme", "verify_ok"]);
    expect(JSON.stringify(cacheRow)).not.toContain("UNIQUE-LEAK-CANARY");
  });

  test("If-None-Match matching etag → 304 Not Modified, no body", async () => {
    const app = new Hono();
    app.route("/", auditRoutes);
    const responseCache = makeMemoryKv();
    const auditLog = makeMemoryKv();
    const env = makeAuditEnv(responseCache, auditLog);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildSignedFillBody(pubHex, privKey);
    await app.fetch(
      new Request("http://test.local/v1/audit/fill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    const postJson = (await (await app.fetch(
      new Request("http://test.local/v1/audit/fill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    )).json()) as Record<string, unknown>;
    const receiptId = postJson.receiptId as string;

    // Warm cache.
    const v1 = await app.fetch(
      new Request(`http://test.local/v1/audit/verify/${receiptId}`),
      env,
    );
    const etag = v1.headers.get("ETag")!;

    // Hit again with If-None-Match.
    const v2 = await app.fetch(
      new Request(`http://test.local/v1/audit/verify/${receiptId}`, {
        headers: { "if-none-match": etag },
      }),
      env,
    );
    expect(v2.status).toBe(304);
    expect(v2.headers.get("ETag")).toBe(etag);
    expect(v2.headers.get("X-Cache")).toBe("HIT");
  });

  test("Cache-Control: no-cache forces BYPASS, fresh compute hits AUDIT_LOG", async () => {
    const app = new Hono();
    app.route("/", auditRoutes);
    const responseCache = makeMemoryKv();
    const auditLog = makeMemoryKv();
    const env = makeAuditEnv(responseCache, auditLog);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildSignedFillBody(pubHex, privKey);
    await app.fetch(
      new Request("http://test.local/v1/audit/fill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    // Get receiptId via second POST returning idempotent:true.
    const postRes2 = await app.fetch(
      new Request("http://test.local/v1/audit/fill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    const receiptId = ((await postRes2.json()) as Record<string, unknown>).receiptId as string;

    // Warm cache.
    await app.fetch(
      new Request(`http://test.local/v1/audit/verify/${receiptId}`),
      env,
    );
    // Bypass.
    const bypassRes = await app.fetch(
      new Request(`http://test.local/v1/audit/verify/${receiptId}`, {
        headers: { "cache-control": "no-cache" },
      }),
      env,
    );
    expect(bypassRes.status).toBe(200);
    expect(bypassRes.headers.get("X-Cache")).toBe("BYPASS");
  });
});

// ─── 7. Key derivation sanity ──────────────────────────────────────────────

describe("key derivation helpers", () => {
  test("normalizeResolveUrl sorts query params + lowercases host", () => {
    const a = normalizeResolveUrl("https://EXAMPLE.com/path?b=2&a=1");
    const b = normalizeResolveUrl("https://example.com/path?a=1&b=2");
    expect(a).toBe(b);
  });

  test("resolveCacheKey is deterministic over same (intent, normalized url)", async () => {
    const k1 = await resolveCacheKey("search posts", "https://example.com/?a=1&b=2");
    const k2 = await resolveCacheKey("search posts", "https://example.com/?b=2&a=1");
    expect(k1).toBe(k2);
    expect(k1.startsWith("cache:resolve:")).toBe(true);
  });

  test("namespace conventions match the doc strings", () => {
    expect(marketplaceCacheKey("EXAMPLE.com")).toBe("cache:marketplace:example.com");
    expect(sponsorCacheKey("agent-abc", "2026-05-28")).toBe("cache:sponsor:agent-abc:2026-05-28");
    expect(auditVerifyCacheKey("a".repeat(64))).toBe(`cache:audit-verify:${"a".repeat(64)}`);
  });
});

// ─── 8. buildCacheHeaders shape ────────────────────────────────────────────

describe("buildCacheHeaders", () => {
  test("emits X-Cache and ETag headers", () => {
    const h = buildCacheHeaders({
      value: { x: 1 },
      hit: true,
      etag: "abcdef0123456789",
      status: "HIT",
    });
    expect(h["X-Cache"]).toBe("HIT");
    expect(h.ETag).toBe(`"abcdef0123456789"`);
  });
});
