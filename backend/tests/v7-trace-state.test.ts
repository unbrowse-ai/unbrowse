/**
 * v7.2.0-preview.0 trace-state — wire + verify + KV path.
 *
 * Day-3 Land worker B (2026-05-28). Mirrors v7-session-park.test.ts +
 * v7-audit-log.test.ts shape — Map-backed KVNamespace stand-in, real
 * Ed25519 keypairs (no mocks), real Web Crypto sign/verify.
 *
 * Test coverage:
 *   T1. POST /v1/trace/append valid body → 200 + cacheKey.
 *   T2. POST with body.value (forbidden top-level) → 400.
 *   T3. POST with traces[0].url forbidden field → 400.
 *   T4. Idempotent: repeat POST → same cacheKey, no KV row growth.
 *   T5. GET /v1/trace/by-receipt/:cacheKey WITHOUT WalletSig → 401.
 *   T6. GET with mismatched wallet → 404 (structural cross-wallet isolation).
 *   T7. Binding missing: TRACE_STATE undefined → 503 envelope.
 *
 * Dan 7:10 — the books are sig-keyed; each wallet's books are bound
 * to its own steward.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { traceRoutes } from "../src/routes/trace.js";
import {
  canonicalizeSignedFragment,
  deriveCacheKeyHex,
  tracePrimaryKey,
  type TraceAppendBody,
} from "../src/services/trace-state.js";
import type { Env } from "../src/types.js";

// ─── In-memory KVNamespace stand-in (Map-backed, real KV semantics) ─────────

interface MemoryKV extends KVNamespace {
  _dump(): Map<string, string>;
}

function makeMemoryKv(): MemoryKV {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
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
  };
  return kv as unknown as MemoryKV;
}

function makeEnv(opts: { kv?: KVNamespace } = {}): Env {
  return {
    TRACE_STATE: opts.kv,
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-test",
  } as unknown as Env;
}

function mountApp() {
  const app = new Hono();
  app.route("/", traceRoutes);
  return app;
}

// ─── Hex / keypair / sign helpers ──────────────────────────────────────────

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function genKeypair(): Promise<{ pubHex: string; privKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: bytesToHex(pubRaw), privKey: kp.privateKey };
}

async function signFragmentHex(
  body: TraceAppendBody,
  privKey: CryptoKey,
): Promise<string> {
  const fragment = canonicalizeSignedFragment(body);
  const bytes = new TextEncoder().encode(fragment);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privKey, bytes);
  return bytesToHex(new Uint8Array(sigBuf));
}

function randomNonceB64(): string {
  const u8 = new Uint8Array(32);
  crypto.getRandomValues(u8);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

async function makeValidBody(opts: {
  pubHex: string;
  privKey: CryptoKey;
  sessionId?: string;
  domain?: string;
}): Promise<TraceAppendBody> {
  const draft: TraceAppendBody = {
    walletPubkey: opts.pubHex,
    signatureScheme: "ed25519-v7.0",
    signature: "00".repeat(64), // overwritten below
    nonce: randomNonceB64(),
    sessionId: opts.sessionId ?? `sess-${Math.random().toString(36).slice(2)}`,
    domain: opts.domain ?? "example.com",
    traces: [
      { step: "server_fetch", duration_ms: 142, status_class: "2xx" },
      { step: "decision", duration_ms: 3 },
    ],
  };
  draft.signature = await signFragmentHex(draft, opts.privKey);
  return draft;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("v7.2.0-preview.0 trace-state (T1) — POST valid body", () => {
  test("POST /v1/trace/append with valid sig returns 200 + cacheKey", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const res = await app.request(
      "/v1/trace/append",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res.status).toBe(200);
    const ack = (await res.json()) as {
      ok: boolean;
      cacheKey: string;
      verify_ok: boolean;
      idempotent: boolean;
      _binding_status: string;
    };
    expect(ack.ok).toBe(true);
    expect(ack.verify_ok).toBe(true);
    expect(ack.idempotent).toBe(false);
    expect(ack._binding_status).toBe("wired");
    expect(ack.cacheKey.length).toBe(32);
    const expectedCacheKey = await deriveCacheKeyHex(body.signature);
    expect(ack.cacheKey).toBe(expectedCacheKey);
    // KV row at wallet-prefixed key.
    const key = tracePrimaryKey(pubHex, expectedCacheKey);
    expect(await kv.get(key)).not.toBeNull();
  });
});

describe("v7.2.0-preview.0 trace-state (T2) — forbidden top-level field", () => {
  test("POST body carrying `value` is rejected with 400", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const valid = await makeValidBody({ pubHex, privKey });
    const tainted = { ...valid, value: "OAUTH-LEAK-CANARY" };

    const res = await app.request(
      "/v1/trace/append",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tainted),
      },
      env,
    );
    expect(res.status).toBe(400);
    const ack = (await res.json()) as { error: string; field: string };
    expect(ack.error).toBe("invalid_body");
    expect(ack.field.toLowerCase()).toBe("value");
    expect(kv._dump().size).toBe(0);
  });
});

describe("v7.2.0-preview.0 trace-state (T3) — forbidden traces[].url", () => {
  test("POST body carrying traces[0].url is rejected with 400", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const valid = await makeValidBody({ pubHex, privKey });
    // Inject forbidden field inside the trace step.
    const tainted = {
      ...valid,
      traces: [
        {
          step: "server_fetch",
          duration_ms: 142,
          status_class: "2xx" as const,
          url: "https://example.com/api?token=LEAK",
        },
      ],
    };

    const res = await app.request(
      "/v1/trace/append",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tainted),
      },
      env,
    );
    expect(res.status).toBe(400);
    const ack = (await res.json()) as { error: string; field: string };
    expect(ack.error).toBe("invalid_body");
    expect(ack.field).toContain("url");
    expect(kv._dump().size).toBe(0);
  });
});

describe("v7.2.0-preview.0 trace-state (T4) — idempotent re-POST", () => {
  test("repeat POST returns same cacheKey, no KV row growth", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const res1 = await app.request(
      "/v1/trace/append",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res1.status).toBe(200);
    const ack1 = (await res1.json()) as { cacheKey: string; idempotent: boolean };
    expect(ack1.idempotent).toBe(false);
    const sizeAfterFirst = kv._dump().size;

    const res2 = await app.request(
      "/v1/trace/append",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res2.status).toBe(200);
    const ack2 = (await res2.json()) as { cacheKey: string; idempotent: boolean };
    expect(ack2.cacheKey).toBe(ack1.cacheKey);
    expect(ack2.idempotent).toBe(true);
    expect(kv._dump().size).toBe(sizeAfterFirst);
  });
});

describe("v7.2.0-preview.0 trace-state (T5) — missing WalletSig on GET", () => {
  test("GET /v1/trace/by-receipt/:cacheKey without sig → 401", async () => {
    const env = makeEnv({ kv: makeMemoryKv() });
    const app = mountApp();
    const fakeCacheKey = "a".repeat(32);
    const res = await app.request(`/v1/trace/by-receipt/${fakeCacheKey}`, {}, env);
    expect(res.status).toBe(401);
    const ack = (await res.json()) as { error: string };
    expect(ack.error).toBe("unauthorized");
  });
});

describe("v7.2.0-preview.0 trace-state (T6) — mismatched wallet → 404", () => {
  test("WALLET-A sig over WALLET-B's cacheKey returns 404 (structural isolation)", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const walletA = await genKeypair();
    const walletB = await genKeypair();

    // Wallet-B writes a trace row.
    const bodyB = await makeValidBody({
      pubHex: walletB.pubHex,
      privKey: walletB.privKey,
    });
    const parkRes = await app.request(
      "/v1/trace/append",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyB),
      },
      env,
    );
    expect(parkRes.status).toBe(200);
    const ackB = (await parkRes.json()) as { cacheKey: string };
    const cacheKey = ackB.cacheKey;

    // Wallet-A signs a challenge over the SAME cacheKey.
    const ts = Date.now();
    const messageBytes = new TextEncoder().encode(`${cacheKey}:${ts}`);
    const sigABuf = await crypto.subtle.sign(
      { name: "Ed25519" },
      walletA.privKey,
      messageBytes,
    );
    const sigA = bytesToHex(new Uint8Array(sigABuf));

    const res = await app.request(
      `/v1/trace/by-receipt/${cacheKey}`,
      {
        method: "GET",
        headers: {
          Authorization: `WalletSig ${sigA}`,
          "X-Wallet-Pubkey": walletA.pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    // Wallet-A's sig verifies (it's a real Ed25519 sig over the
    // challenge), but the KV key prefix `trace:<walletA>:<cacheKey>`
    // has no row — wallet-B's row is at `trace:<walletB>:<cacheKey>`.
    // Structurally invisible → 404.
    expect(res.status).toBe(404);
    const ack = (await res.json()) as { error: string };
    expect(ack.error).toBe("trace_not_found");
  });
});

describe("v7.2.0-preview.0 trace-state (T7) — binding missing → 503", () => {
  test("TRACE_STATE undefined returns 503 envelope with _binding_missing", async () => {
    const env = makeEnv({ kv: undefined });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const res = await app.request(
      "/v1/trace/append",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(res.status).toBe(503);
    const ack = (await res.json()) as {
      error: string;
      _binding_missing: string;
      _wave_hint: string;
    };
    expect(ack.error).toBe("trace_state_binding_missing");
    expect(ack._binding_missing).toBe("TRACE_STATE");
    expect(ack._wave_hint).toContain("TRACE_STATE");
  });
});
