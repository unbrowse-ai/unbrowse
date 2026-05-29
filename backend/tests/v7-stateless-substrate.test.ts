/**
 * Day-3 Land worker A tests — stateless-substrate.ts conformance.
 *
 * Spec: .planning/v7-rip/STATELESS_BOUNDARY.md §G + §H falsifier gates.
 *
 * No mocks. Map-backed in-memory KV (same pattern as crypto-sub.test.ts).
 * Real Web Crypto for sha256 derivation. Real defineNamespace closures.
 */

import { describe, expect, test } from "bun:test";
import {
  defineNamespace,
  deriveCacheKey,
  deriveCacheKeyFromHash,
  defaultKeyPrefix,
  isBindingMissingError,
  isValidationError,
  type BindingMissingError,
  type NamespaceSpec,
  type PutResult,
  type StoredRow,
  type ValidationError,
} from "../src/services/stateless-substrate.js";
import type { Env } from "../src/types.js";

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Map-backed KVNamespace stand-in. Exposes `_store` so tests can assert
 * row count + raw contents. Mirrors crypto-sub.test.ts `makeMemoryKv`.
 */
function makeMemoryKv(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    _store: store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix, limit }: { prefix?: string; limit?: number } = {}) => {
      const allKeys = [...store.keys()];
      const matching = prefix ? allKeys.filter((k) => k.startsWith(prefix)) : allKeys;
      matching.sort();
      const bounded = typeof limit === "number" ? matching.slice(0, limit) : matching;
      return {
        keys: bounded.map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      };
    },
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace & { _store: Map<string, string> };
  return kv;
}

const WALLET_A = "a".repeat(64); // 64-char hex
const WALLET_B = "b".repeat(64);

function makeSig(seed: number = 0xab): Uint8Array {
  const sig = new Uint8Array(64);
  sig.fill(seed);
  return sig;
}

// A minimal TraceState-shaped body for testing.
interface TraceBody {
  domain: string;
  sessionId: string;
  recorded_at: number;
}

const traceSpec: NamespaceSpec<TraceBody> = {
  name: "TRACE_STATE",
  bindingResolver: (env: Env) => env.RESPONSE_CACHE, // reuse the optional binding slot for the test
  schemaValidator: (body: unknown): ValidationError | null => {
    if (!body || typeof body !== "object") {
      return { field: "$body", reason: "must be an object" };
    }
    const b = body as Record<string, unknown>;
    if (typeof b.domain !== "string") return { field: "domain", reason: "must be a string" };
    if (typeof b.sessionId !== "string") return { field: "sessionId", reason: "must be a string" };
    if (typeof b.recorded_at !== "number") return { field: "recorded_at", reason: "must be a number" };
    return null;
  },
  expirationTtlSec: 604_800, // 7d
};

// A minimal SettingsState-shaped body for the second-namespace test.
interface SettingsBody {
  key: "default_proxy" | "headless" | "auth_capture_mode";
  value_pointer: string;
  updated_at: number;
}

const settingsSpec: NamespaceSpec<SettingsBody> = {
  name: "SETTINGS_STATE",
  bindingResolver: (env: Env) => env.STATS_KV, // reuse for the test
  schemaValidator: (body: unknown): ValidationError | null => {
    if (!body || typeof body !== "object") return { field: "$body", reason: "must be an object" };
    const b = body as Record<string, unknown>;
    if (b.key !== "default_proxy" && b.key !== "headless" && b.key !== "auth_capture_mode") {
      return { field: "key", reason: "must be one of the ALLOWED_SET" };
    }
    if (typeof b.value_pointer !== "string") return { field: "value_pointer", reason: "must be a string" };
    if (typeof b.updated_at !== "number") return { field: "updated_at", reason: "must be a number" };
    return null;
  },
};

function makeEnv(bindings: Partial<Env> = {}): Env {
  return {
    STATS_KV: makeMemoryKv(),
    ...bindings,
  } as unknown as Env;
}

// ─── 1. deriveCacheKey — sha256(sig).slice(0,32) ──────────────────────────

describe("deriveCacheKey", () => {
  test("returns a 32-char hex string matching crypto.subtle.digest first-32-chars", async () => {
    const sig = new Uint8Array(64).fill(0xab);
    const cacheKey = await deriveCacheKey(sig);
    expect(cacheKey.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(cacheKey)).toBe(true);

    // Cross-check directly against Web Crypto.
    const hash = await crypto.subtle.digest("SHA-256", sig);
    const u8 = new Uint8Array(hash);
    let hex = "";
    for (let i = 0; i < u8.length; i++) hex += u8[i].toString(16).padStart(2, "0");
    expect(cacheKey).toBe(hex.slice(0, 32));
  });

  test("different signatures produce different cache keys", async () => {
    const a = await deriveCacheKey(makeSig(0x01));
    const b = await deriveCacheKey(makeSig(0x02));
    expect(a).not.toBe(b);
  });

  test("deriveCacheKeyFromHash returns the first 32 chars of a longer hash", () => {
    const fullHash = "deadbeef".repeat(8); // 64 chars
    expect(deriveCacheKeyFromHash(fullHash)).toBe("deadbeefdeadbeefdeadbeefdeadbeef");
  });

  test("deriveCacheKeyFromHash strips 0x prefix and lowercases", () => {
    const fullHash = "0xDEADBEEF" + "abcd".repeat(15); // 64 chars after prefix-strip
    expect(deriveCacheKeyFromHash(fullHash).startsWith("deadbeef")).toBe(true);
  });

  test("deriveCacheKeyFromHash throws on short input", () => {
    expect(() => deriveCacheKeyFromHash("short")).toThrow();
  });
});

// ─── 2. defineNamespace produces an adapter named per spec ────────────────

describe("defineNamespace", () => {
  test("returns a StatelessNamespace whose name matches the spec", () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    expect(ns.name).toBe("TRACE_STATE");
    expect(ns.signatureScheme).toBe("ed25519-v7.0");
  });

  test("keyPrefix returns the default short-form lowercased", () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    expect(ns.keyPrefix(WALLET_A)).toBe(`trace:${WALLET_A}:`);
  });

  test("defaultKeyPrefix strips _STATE / _LOG / _CACHE suffixes consistently", () => {
    expect(defaultKeyPrefix("TRACE_STATE", WALLET_A)).toBe(`trace:${WALLET_A}:`);
    expect(defaultKeyPrefix("SETTINGS_STATE", WALLET_A)).toBe(`settings:${WALLET_A}:`);
    expect(defaultKeyPrefix("SESSION_STATE", WALLET_A)).toBe(`session:${WALLET_A}:`);
    expect(defaultKeyPrefix("AUDIT_LOG", WALLET_A)).toBe(`audit:${WALLET_A}:`);
  });
});

// ─── 3 + 4. put / get round-trip, idempotency ─────────────────────────────

describe("put / get round-trip", () => {
  test("put returns {cacheKey, fullKey, idempotent: false} on first write", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const kv = makeMemoryKv();
    const env = makeEnv({ RESPONSE_CACHE: kv });
    const body: TraceBody = { domain: "example.com", sessionId: "sess_1", recorded_at: 1000 };
    const sig = makeSig(0x11);

    const result = await ns.put(env, body, sig, WALLET_A);
    expect(isBindingMissingError(result)).toBe(false);
    expect(isValidationError(result)).toBe(false);
    const put = result as PutResult;
    expect(put.idempotent).toBe(false);
    expect(put.cacheKey.length).toBe(32);
    expect(put.fullKey).toBe(`trace:${WALLET_A}:${put.cacheKey}`);
    expect(kv._store.size).toBe(1);
  });

  test("repeat put with same body returns idempotent: true; KV row count unchanged", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const kv = makeMemoryKv();
    const env = makeEnv({ RESPONSE_CACHE: kv });
    const body: TraceBody = { domain: "example.com", sessionId: "sess_1", recorded_at: 1000 };
    const sig = makeSig(0x12);

    const first = (await ns.put(env, body, sig, WALLET_A)) as PutResult;
    expect(first.idempotent).toBe(false);
    expect(kv._store.size).toBe(1);

    const second = (await ns.put(env, body, sig, WALLET_A)) as PutResult;
    expect(second.idempotent).toBe(true);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(kv._store.size).toBe(1);
  });

  test("get after put returns the stored row with walletPubkey set", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const kv = makeMemoryKv();
    const env = makeEnv({ RESPONSE_CACHE: kv });
    const body: TraceBody = { domain: "example.org", sessionId: "sess_2", recorded_at: 2000 };
    const sig = makeSig(0x13);

    const put = (await ns.put(env, body, sig, WALLET_A)) as PutResult;
    const got = (await ns.get(env, put.cacheKey, WALLET_A)) as StoredRow<TraceBody>;
    expect(got).not.toBeNull();
    expect(got.body.domain).toBe("example.org");
    expect(got.body.sessionId).toBe("sess_2");
    expect(got.walletPubkey).toBe(WALLET_A);
    expect(got.cacheKey).toBe(put.cacheKey);
    expect(got.signature_scheme).toBe("ed25519-v7.0");
    expect(typeof got.stored_at).toBe("number");
  });
});

// ─── 5. cross-wallet structural protection ────────────────────────────────

describe("cross-wallet structural protection", () => {
  test("get with wrong wallet (right cacheKey) returns null (prefix-mismatch)", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const kv = makeMemoryKv();
    const env = makeEnv({ RESPONSE_CACHE: kv });
    const body: TraceBody = { domain: "ex.com", sessionId: "s", recorded_at: 1 };

    const put = (await ns.put(env, body, makeSig(0x21), WALLET_A)) as PutResult;
    // Right cacheKey, but wallet B has no row at trace:<B>:<cacheKey>.
    const got = await ns.get(env, put.cacheKey, WALLET_B);
    expect(got).toBeNull();
    // Confirm the actual KV row is unreachable from wallet B's prefix.
    expect(kv._store.has(`trace:${WALLET_B}:${put.cacheKey}`)).toBe(false);
    expect(kv._store.has(`trace:${WALLET_A}:${put.cacheKey}`)).toBe(true);
  });
});

// ─── 6. list returns rows for one wallet only, newest-first ───────────────

describe("list", () => {
  test("list returns all rows for the wallet, sorted newest-first by stored_at", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const kv = makeMemoryKv();
    const env = makeEnv({ RESPONSE_CACHE: kv });

    // Three rows for WALLET_A under distinct sigs.
    const r1 = (await ns.put(env, { domain: "a.com", sessionId: "1", recorded_at: 1 }, makeSig(0x31), WALLET_A)) as PutResult;
    // Force a small stored_at gap so the sort is observable.
    await new Promise((r) => setTimeout(r, 5));
    const r2 = (await ns.put(env, { domain: "b.com", sessionId: "2", recorded_at: 2 }, makeSig(0x32), WALLET_A)) as PutResult;
    await new Promise((r) => setTimeout(r, 5));
    const r3 = (await ns.put(env, { domain: "c.com", sessionId: "3", recorded_at: 3 }, makeSig(0x33), WALLET_A)) as PutResult;

    // One row for WALLET_B — must NOT appear in wallet A's listing.
    await ns.put(env, { domain: "z.com", sessionId: "z", recorded_at: 99 }, makeSig(0x34), WALLET_B);

    const listed = (await ns.list(env, WALLET_A, 100)) as StoredRow<TraceBody>[];
    expect(listed.length).toBe(3);
    // Newest-first by stored_at: r3, r2, r1.
    expect(listed[0]!.cacheKey).toBe(r3.cacheKey);
    expect(listed[1]!.cacheKey).toBe(r2.cacheKey);
    expect(listed[2]!.cacheKey).toBe(r1.cacheKey);
    // Cross-wallet: every returned row carries wallet A.
    for (const row of listed) {
      expect(row.walletPubkey).toBe(WALLET_A);
      expect(row.body.domain).not.toBe("z.com");
    }
  });
});

// ─── 7. Binding-missing: graceful envelope, never throws ──────────────────

describe("binding-missing path", () => {
  test("put with missing binding returns BindingMissingError envelope", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const env = makeEnv({ RESPONSE_CACHE: undefined });
    const body: TraceBody = { domain: "ex.com", sessionId: "s", recorded_at: 1 };

    const result = await ns.put(env, body, makeSig(0x41), WALLET_A);
    expect(isBindingMissingError(result)).toBe(true);
    const bm = result as BindingMissingError;
    expect(bm._binding_missing).toBe("TRACE_STATE");
    expect(bm.hint).toContain("wrangler kv:namespace create TRACE_STATE");
  });

  test("get with missing binding returns BindingMissingError envelope", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const env = makeEnv({ RESPONSE_CACHE: undefined });
    const result = await ns.get(env, "dummycachekey", WALLET_A);
    expect(isBindingMissingError(result)).toBe(true);
  });

  test("list with missing binding returns BindingMissingError envelope", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const env = makeEnv({ RESPONSE_CACHE: undefined });
    const result = await ns.list(env, WALLET_A, 50);
    expect(isBindingMissingError(result)).toBe(true);
  });
});

// ─── 8. Schema validation: spec validator + forbidden-field substrate gate ─

describe("schema validation", () => {
  test("put with spec-invalid body returns the spec's ValidationError directly (no KV write)", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const kv = makeMemoryKv();
    const env = makeEnv({ RESPONSE_CACHE: kv });
    const badBody = { domain: 123, sessionId: "s", recorded_at: 1 } as unknown as TraceBody;
    const result = await ns.put(env, badBody, makeSig(0x51), WALLET_A);
    expect(isValidationError(result)).toBe(true);
    const err = result as ValidationError;
    expect(err.field).toBe("domain");
    expect(kv._store.size).toBe(0);
  });

  test("substrate forbidden-field gate rejects bodies carrying 'cookie' (cleartext)", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const kv = makeMemoryKv();
    const env = makeEnv({ RESPONSE_CACHE: kv });
    const sneaky = {
      domain: "ex.com",
      sessionId: "s",
      recorded_at: 1,
      cookie: "session=abc123", // forbidden field
    } as unknown as TraceBody;
    const result = await ns.put(env, sneaky, makeSig(0x52), WALLET_A);
    expect(isValidationError(result)).toBe(true);
    const err = result as ValidationError;
    expect(err.field).toBe("cookie");
    expect(err.reason).toContain("forbidden");
    expect(kv._store.size).toBe(0);
  });

  test("substrate forbidden-field gate rejects 'token' and 'bearer' (case-insensitive)", async () => {
    const ns = defineNamespace<TraceBody>(traceSpec);
    const env = makeEnv({ RESPONSE_CACHE: makeMemoryKv() });
    const r1 = await ns.put(env, { domain: "x", sessionId: "s", recorded_at: 1, Token: "abc" } as unknown as TraceBody, makeSig(0x53), WALLET_A);
    expect(isValidationError(r1)).toBe(true);
    const r2 = await ns.put(env, { domain: "x", sessionId: "s", recorded_at: 1, BEARER: "abc" } as unknown as TraceBody, makeSig(0x54), WALLET_A);
    expect(isValidationError(r2)).toBe(true);
  });
});

// ─── 9. Two namespaces in one test — keyPrefix collision freedom ──────────

describe("two namespaces side-by-side", () => {
  test("TRACE_STATE and SETTINGS_STATE keyPrefixes do not collide", () => {
    const trace = defineNamespace<TraceBody>(traceSpec);
    const settings = defineNamespace<SettingsBody>(settingsSpec);
    const tp = trace.keyPrefix(WALLET_A);
    const sp = settings.keyPrefix(WALLET_A);
    expect(tp).toBe(`trace:${WALLET_A}:`);
    expect(sp).toBe(`settings:${WALLET_A}:`);
    expect(tp.startsWith("trace:")).toBe(true);
    expect(sp.startsWith("settings:")).toBe(true);
    expect(tp).not.toBe(sp);
    // Critical: one prefix is NOT a prefix of the other.
    expect(tp.startsWith(sp)).toBe(false);
    expect(sp.startsWith(tp)).toBe(false);
  });

  test("rows under two namespaces sharing a KV bucket are isolated by prefix", async () => {
    // Both adapters point at the SAME KV map to prove prefix-isolation.
    const sharedKv = makeMemoryKv();
    const traceLocal = defineNamespace<TraceBody>({
      ...traceSpec,
      bindingResolver: () => sharedKv,
    });
    const settingsLocal = defineNamespace<SettingsBody>({
      ...settingsSpec,
      bindingResolver: () => sharedKv,
    });
    const env = makeEnv();

    await traceLocal.put(env, { domain: "ex.com", sessionId: "s", recorded_at: 1 }, makeSig(0x61), WALLET_A);
    await settingsLocal.put(
      env,
      { key: "headless", value_pointer: "false", updated_at: 2 },
      makeSig(0x62),
      WALLET_A,
    );

    expect(sharedKv._store.size).toBe(2);
    const traceList = (await traceLocal.list(env, WALLET_A, 100)) as StoredRow<TraceBody>[];
    const settingsList = (await settingsLocal.list(env, WALLET_A, 100)) as StoredRow<SettingsBody>[];
    expect(traceList.length).toBe(1);
    expect(settingsList.length).toBe(1);
    expect(traceList[0]!.body.domain).toBe("ex.com");
    expect(settingsList[0]!.body.key).toBe("headless");
  });
});

// ─── 10. Custom keyPrefixBuilder override ─────────────────────────────────

describe("custom keyPrefixBuilder", () => {
  test("spec-supplied builder overrides the default", () => {
    const custom = defineNamespace<TraceBody>({
      ...traceSpec,
      keyPrefixBuilder: (name, wallet) => `custom_${name.toLowerCase()}::${wallet}::`,
    });
    expect(custom.keyPrefix(WALLET_A)).toBe(`custom_trace_state::${WALLET_A}::`);
  });
});
