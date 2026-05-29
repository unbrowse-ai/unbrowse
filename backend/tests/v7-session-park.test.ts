/**
 * v7.2.0-preview.0 session-park / session-restore — wire + verify + KV path.
 *
 * W23 wave (2026-05-28). Mirrors the v7-audit-log.test.ts shape: Map-backed
 * KVNamespace stand-in (real KV semantics, not stubs — per CLAUDE.md
 * "no mocks" rule the in-memory KV IS KV semantics).
 *
 * Test coverage:
 *   5. POST /v1/session/park with valid wallet sig → 200 + receiptId.
 *   6. POST with body.cookieValue (forbidden field) → 400.
 *   7. GET /v1/session/restore/:id WITHOUT WalletSig header → 401.
 *   8. GET with WALLET-A sig for a session prefixed by WALLET-B → 404
 *      (structurally invisible — not a leak; same as "does not exist").
 *   9. GET with matching wallet → returns row on real KV; honest 503 on
 *      inert binding.
 *
 * Mt 6:19-20 — the KV-cached pointer-chain laid up where moth nor rust
 * corrupts. Two witnesses (Deut 19:15): the verified sig AND the
 * wallet-prefixed KV key are both required for a successful read.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sessionStateRoutes } from "../src/routes/session-state.js";
import {
  canonicalizeSignedFragment,
  deriveReceiptId,
  sessionPrimaryKey,
  type SessionParkBody,
} from "../src/services/session-state.js";
import type { Env } from "../src/types.js";

// ─── In-memory KVNamespace stand-in (Map-backed) ───────────────────────────

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
    SESSION_STATE: opts.kv,
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-test",
  } as unknown as Env;
}

function mountApp() {
  const app = new Hono();
  app.route("/", sessionStateRoutes);
  return app;
}

// ─── Hex / keypair helpers ─────────────────────────────────────────────────

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash));
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
  body: SessionParkBody,
  privKey: CryptoKey,
): Promise<string> {
  const fragment = canonicalizeSignedFragment(body);
  const bytes = new TextEncoder().encode(fragment);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privKey, bytes);
  return bytesToHex(new Uint8Array(sigBuf));
}

async function signChallengeHex(
  sessionId: string,
  timestampMs: number,
  privKey: CryptoKey,
): Promise<string> {
  const message = `${sessionId}:${timestampMs}`;
  const bytes = new TextEncoder().encode(message);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privKey, bytes);
  return bytesToHex(new Uint8Array(sigBuf));
}

async function makeValidBody(opts: {
  pubHex: string;
  privKey: CryptoKey;
  sessionId?: string;
}): Promise<SessionParkBody> {
  const sessionId = opts.sessionId ?? `sess-${Math.random().toString(36).slice(2)}`;
  const draft: SessionParkBody = {
    sessionId,
    targetUrl: "https://example.com/login",
    targetId: "TARGET-1",
    contextId: "CTX-1",
    boundPointers: [],
    capturedEndpointsHash: await sha256Hex(`${sessionId}:empty`),
    walletPubkey: opts.pubHex,
    signatureScheme: "ed25519-v7.2",
    signature: "00".repeat(64), // overwritten below
    parked_at: Date.now(),
  };
  draft.signature = await signFragmentHex(draft, opts.privKey);
  return draft;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("v7.2.0-preview.0 session-park (T5)", () => {
  test("POST /v1/session/park with valid wallet sig returns 200 + receiptId (real KV)", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });

    const res = await app.request(
      "/v1/session/park",
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
      receiptId: string;
      verify_ok: boolean;
      parked: boolean;
      idempotent?: boolean;
    };
    expect(ack.ok).toBe(true);
    expect(ack.verify_ok).toBe(true);
    expect(ack.parked).toBe(true);
    expect(ack.idempotent).toBe(false);
    const expectedReceiptId = await deriveReceiptId(body);
    expect(ack.receiptId).toBe(expectedReceiptId);
    // KV should have a row at the wallet-prefixed key.
    const key = sessionPrimaryKey(pubHex, body.sessionId);
    expect(await kv.get(key)).not.toBeNull();
  });
});

describe("v7.2.0-preview.0 session-park (T6) — forbidden-field gate", () => {
  test("POST body carrying cookieValue is rejected with 400", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const valid = await makeValidBody({ pubHex, privKey });
    // Inject forbidden field.
    const tainted = { ...valid, cookieValue: "OAUTH-LEAK-CANARY-DO-NOT-PERSIST" };

    const res = await app.request(
      "/v1/session/park",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tainted),
      },
      env,
    );
    expect(res.status).toBe(400);
    const ack = (await res.json()) as { error: string; field: string; reason: string };
    expect(ack.error).toBe("invalid_body");
    expect(ack.field.toLowerCase()).toBe("cookievalue");
    // KV must NOT have stored the tainted body.
    expect(kv._dump().size).toBe(0);
  });
});

describe("v7.2.0-preview.0 session-restore (T7) — missing auth", () => {
  test("GET without WalletSig header returns 401", async () => {
    const env = makeEnv({ kv: makeMemoryKv() });
    const app = mountApp();
    const res = await app.request("/v1/session/restore/any-session-id", {}, env);
    expect(res.status).toBe(401);
    const ack = (await res.json()) as { error: string };
    expect(ack.error).toBe("unauthorized");
  });
});

describe("v7.2.0-preview.0 session-restore (T8) — cross-wallet structural isolation", () => {
  test("WALLET-A sig for a session parked by WALLET-B returns 404 (not a leak)", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();

    const walletA = await genKeypair();
    const walletB = await genKeypair();

    // WALLET-B parks a session.
    const sessionId = "cross-wallet-test-session";
    const bodyB = await makeValidBody({
      pubHex: walletB.pubHex,
      privKey: walletB.privKey,
      sessionId,
    });
    const parkRes = await app.request(
      "/v1/session/park",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyB),
      },
      env,
    );
    expect(parkRes.status).toBe(200);
    // KV row exists at wallet-B's prefix.
    expect(await kv.get(sessionPrimaryKey(walletB.pubHex, sessionId))).not.toBeNull();

    // WALLET-A signs a restore challenge for the SAME sessionId.
    const ts = Date.now();
    const sigA = await signChallengeHex(sessionId, ts, walletA.privKey);

    const res = await app.request(
      `/v1/session/restore/${encodeURIComponent(sessionId)}`,
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
    // The sig over (sessionId || ts) verifies — wallet-A is a real
    // signer. The KV key derived from wallet-A's pubkey is
    // structurally different from wallet-B's key, so the read finds
    // no row. 404 (not 403), and the body is the same "exists vs not"
    // collapsed envelope to avoid enumeration oracles.
    expect(res.status).toBe(404);
    const ack = (await res.json()) as { error: string; sessionId: string };
    expect(ack.error).toBe("session_not_found");
    expect(ack.sessionId).toBe(sessionId);

    // Sanity: wallet-B with the SAME sessionId DOES get its row.
    const sigB = await signChallengeHex(sessionId, ts, walletB.privKey);
    const resB = await app.request(
      `/v1/session/restore/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `WalletSig ${sigB}`,
          "X-Wallet-Pubkey": walletB.pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(resB.status).toBe(200);
    const ackB = (await resB.json()) as { ok: boolean; row: { sessionId: string } };
    expect(ackB.ok).toBe(true);
    expect(ackB.row.sessionId).toBe(sessionId);
  });
});

describe("v7.2.0-preview.0 session-restore (T9) — matching wallet path", () => {
  test("GET with matching wallet on real KV returns 200 + row", async () => {
    const kv = makeMemoryKv();
    const env = makeEnv({ kv });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const sessionId = "happy-path";
    const body = await makeValidBody({ pubHex, privKey, sessionId });
    await app.request(
      "/v1/session/park",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );

    const ts = Date.now();
    const sig = await signChallengeHex(sessionId, ts, privKey);
    const res = await app.request(
      `/v1/session/restore/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `WalletSig ${sig}`,
          "X-Wallet-Pubkey": pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    const ack = (await res.json()) as {
      ok: boolean;
      row: { sessionId: string; targetUrl: string; walletPubkey: string };
      _binding_status: string;
    };
    expect(ack.ok).toBe(true);
    expect(ack.row.sessionId).toBe(sessionId);
    expect(ack.row.targetUrl).toBe(body.targetUrl);
    expect(ack._binding_status).toBe("wired");
  });

  test("GET with matching wallet on inert KV returns 503 honest envelope", async () => {
    // No KV binding — simulates v7.2.0-preview.0 pre-provisioned state.
    const env = makeEnv({ kv: undefined });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const sessionId = "inert-binding-test";
    const ts = Date.now();
    const sig = await signChallengeHex(sessionId, ts, privKey);
    const res = await app.request(
      `/v1/session/restore/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `WalletSig ${sig}`,
          "X-Wallet-Pubkey": pubHex,
          "X-Wallet-Timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(503);
    const ack = (await res.json()) as {
      error: string;
      sessionId: string;
      _wave_hint: string;
    };
    expect(ack.error).toBe("session_state_binding_inert");
    expect(ack.sessionId).toBe(sessionId);
    expect(ack._wave_hint).toContain("v7.3");
  });
});

describe("v7.2.0-preview.0 session-park — POST with inert KV returns 200 parked=false", () => {
  test("inert KV binding: POST succeeds with parked=false + _binding_status=inert", async () => {
    const env = makeEnv({ kv: undefined });
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const body = await makeValidBody({ pubHex, privKey });
    const res = await app.request(
      "/v1/session/park",
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
      verify_ok: boolean;
      parked: boolean;
      _binding_status: string;
      receiptId: string;
    };
    expect(ack.ok).toBe(true);
    expect(ack.verify_ok).toBe(true);
    expect(ack.parked).toBe(false);
    expect(ack._binding_status).toBe("inert");
    expect(ack.receiptId.length).toBe(64);
  });
});
