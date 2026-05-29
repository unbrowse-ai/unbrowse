/**
 * v7-covenant-endpoint — the ONE unified write surface POST /v1/covenant +
 * the peer-federation mirror (W26-C, 2026-05-28).
 *
 * No mocks of the surface under test. Real Web Crypto (Ed25519 generateKey/
 * sign), real in-process Hono app, in-memory KV with faithful list semantics
 * (same MemoryKV pattern as v7-audit-log.test.ts). The peer mirror is tested
 * against a real `Bun.serve` peer (captured fetch), and the graceful-no-op path
 * with no peer configured (CLAUDE.md: never mock the network; the in-memory KV
 * IS KV semantics, the Bun.serve peer IS a real HTTP peer).
 *
 * Eph 4:4 — one body: the unified endpoint dispatches the 4-tuple covenant
 * envelope into the right sibling service. Gen 2:18 — ezer kenegdo: the peer
 * mirror is the facing helper.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { covenantRoutes } from "../src/routes/covenant.js";
import {
  mirrorToCovenantLedger,
  type MirrorableReceipt,
} from "../src/services/covenant-peer.js";
import { deriveCovenantReceiptPtr, canonicalize } from "../src/services/covenant-core.js";
import {
  canonicalizeSignedFragment as auditSignedFragment,
  type AuditFillBody,
} from "../src/services/audit.js";
import {
  canonicalizeSignedFragment as sessionSignedFragment,
  type SessionParkBody,
} from "../src/services/session-state.js";
import type { Env } from "../src/types.js";

// ─── In-memory KVNamespace stand-in (Map-backed, prefix-list-capable) ──────

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
  };
  return kv as unknown as MemoryKV;
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    AUDIT_LOG: makeMemoryKv(),
    SESSION_STATE: makeMemoryKv(),
    TRACE_STATE: makeMemoryKv(),
    SETTINGS_STATE: makeMemoryKv(),
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-test",
    ...over,
  } as unknown as Env;
}

function mountApp() {
  const app = new Hono();
  app.route("/", covenantRoutes);
  return app;
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function bytesToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
async function genKeypair(): Promise<{ pubHex: string; privKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: bytesToHex(pubRaw), privKey: kp.privateKey };
}
async function sha256Hex(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToHex(new Uint8Array(hash));
}
async function signHex(privKey: CryptoKey, canonical: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privKey, new TextEncoder().encode(canonical));
  return bytesToHex(sig);
}
function nonce(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

async function postJson(app: Hono, env: Env, path: string, body: unknown) {
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ─── 1. actuate:navigate → audit breath-act dispatch ────────────────────────

describe("POST /v1/covenant — actuate:navigate (breath-act dispatch)", () => {
  test("dispatches to audit, returns unified receipt + covenantReceiptPtr", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { pubHex, privKey } = await genKeypair();

    const n = nonce();
    const contextHash = await sha256Hex("https://x.com:/:bucket");
    const commitment = await sha256Hex(`v:${n}`);
    // breath-act variant signs over {pointer, nonce, contextHash, commitment}.
    const partial: Pick<AuditFillBody, "pointer" | "nonce" | "contextHash" | "commitment"> = {
      pointer: "arg://breath/navigate",
      nonce: n,
      contextHash,
      commitment,
    };
    const signature = await signHex(privKey, auditSignedFragment(partial));

    const { status, json } = await postJson(app, env, "/v1/covenant", {
      kind: "actuate:navigate",
      params: { ...partial, walletPubkey: pubHex, urlHash: await sha256Hex("https://x.com") },
      identity: `wallet:${pubHex}`,
      signature,
      signatureScheme: "ed25519-v7.0",
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    // Public (no aiko key) → mechanism (kind/action) STRIPPED (W33-C opacity).
    expect(json.kind).toBeUndefined();
    expect(json.action).toBeUndefined();
    expect(json.verify_ok).toBe(true);
    expect(typeof json.receiptId).toBe("string");
    expect((json.covenantReceiptPtr as string).startsWith("sha256:")).toBe(true);

    // KV row written under AUDIT_LOG.
    const dump = (env.AUDIT_LOG as unknown as MemoryKV)._dump();
    expect(dump.size).toBeGreaterThan(0);
  });
});

// ─── 2. observe:snap → eval-read dispatch ───────────────────────────────────

describe("POST /v1/covenant — observe:snap (eval-read dispatch)", () => {
  test("dispatches to audit eval-read, returns unified receipt", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { pubHex, privKey } = await genKeypair();

    const n = nonce();
    const urlHash = (await sha256Hex("https://x.com/home")).slice(0, 32);
    // eval-read signs over {sessionId, urlHash, readKind, byteCount, selectorHash, nonce}.
    const signedFragment = JSON.stringify({
      sessionId: "sess-1",
      urlHash,
      readKind: "snap",
      byteCount: 4096,
      selectorHash: null,
      nonce: n,
    });
    const signature = await signHex(privKey, signedFragment);

    const { status, json } = await postJson(app, env, "/v1/covenant", {
      kind: "observe:snap",
      params: { sessionId: "sess-1", urlHash, byteCount: 4096, nonce: n, walletPubkey: pubHex },
      identity: `wallet:${pubHex}`,
      signature,
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.kind).toBeUndefined();
    expect(json.action).toBeUndefined();
    expect(json.verify_ok).toBe(true);

    const dump = (env.AUDIT_LOG as unknown as MemoryKV)._dump();
    const keys = Array.from(dump.keys());
    expect(keys.some((k) => k.startsWith("audit-eval-read:"))).toBe(true);
  });
});

// ─── 3. build:skill → declare (breath-act build) dispatch ───────────────────

describe("POST /v1/covenant — build:skill (declare dispatch)", () => {
  test("dispatches to audit build-skill row, returns unified receipt", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { pubHex, privKey } = await genKeypair();

    const n = nonce();
    const contextHash = await sha256Hex("skill:manifest:bucket");
    const commitment = await sha256Hex(`manifest:${n}`);
    const partial = {
      pointer: "arg://breath/skill",
      nonce: n,
      contextHash,
      commitment,
    };
    const signature = await signHex(privKey, auditSignedFragment(partial));

    const { status, json } = await postJson(app, env, "/v1/covenant", {
      kind: "build:skill",
      params: { ...partial, walletPubkey: pubHex },
      identity: `wallet:${pubHex}`,
      signature,
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.kind).toBeUndefined();
    expect(json.action).toBeUndefined();
    expect(json.verify_ok).toBe(true);
  });
});

// ─── 4a. Cross-wallet write → 403 ───────────────────────────────────────────

describe("POST /v1/covenant — cross-wallet guard", () => {
  test("params.walletPubkey != signing identity → 403", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { pubHex, privKey } = await genKeypair();
    const other = (await genKeypair()).pubHex;

    const n = nonce();
    const partial = {
      pointer: "arg://breath/navigate",
      nonce: n,
      contextHash: await sha256Hex("x"),
      commitment: await sha256Hex(`v:${n}`),
    };
    const signature = await signHex(privKey, auditSignedFragment(partial));

    const { status, json } = await postJson(app, env, "/v1/covenant", {
      kind: "actuate:navigate",
      params: { ...partial, walletPubkey: other }, // mismatched
      identity: `wallet:${pubHex}`,
      signature,
    });

    expect(status).toBe(403);
    expect(json.error).toBe("cross_wallet_forbidden");
  });
});

// ─── 4b. Binding-missing → 503 ──────────────────────────────────────────────

describe("POST /v1/covenant — binding-missing honesty", () => {
  test("no AUDIT_LOG binding → 503 with _binding_missing", async () => {
    const app = mountApp();
    // Env WITHOUT AUDIT_LOG.
    const env = { STATS_KV: {} as KVNamespace } as unknown as Env;
    const { pubHex, privKey } = await genKeypair();

    const n = nonce();
    const partial = {
      pointer: "arg://breath/navigate",
      nonce: n,
      contextHash: await sha256Hex("x"),
      commitment: await sha256Hex(`v:${n}`),
    };
    const signature = await signHex(privKey, auditSignedFragment(partial));

    const { status, json } = await postJson(app, env, "/v1/covenant", {
      kind: "actuate:navigate",
      params: { ...partial, walletPubkey: pubHex },
      identity: `wallet:${pubHex}`,
      signature,
    });

    expect(status).toBe(503);
    expect(json._binding_missing).toBe("AUDIT_LOG");
    expect((json.covenantReceiptPtr as string).startsWith("sha256:")).toBe(true);
  });
});

// ─── 5a. Peer mirror fires when COVENANT_LEDGER_URL set (captured fetch) ────

describe("mirrorToCovenantLedger — opaque op fires", () => {
  test("with AIKO_OP_URL set, POSTs /op with OPAQUE body (captured)", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      captured.push({ url: u, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({ receipt_ptr: "sha256:peerledger" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const receipt: MirrorableReceipt = {
      kind: "actuate",
      action: "navigate",
      params: { pointer: "arg://breath/navigate", walletPubkey: "ab".repeat(32) },
      witness: "verse:Genesis 1:3",
      identity: "wallet:" + "ab".repeat(32),
      covenantReceiptPtr: "sha256:shared-address",
    };

    const result = await mirrorToCovenantLedger(
      { AIKO_OP_URL: "http://aiko.local:8787" },
      receipt,
      { fetchImpl: fakeFetch },
    );

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(captured.length).toBe(1);
    expect(captured[0].url).toBe("http://aiko.local:8787/op");
    const sent = captured[0].body as Record<string, unknown>;
    // OPAQUE: unbrowse-native vocab only.
    expect(sent.op_class).toBe("action");
    expect(sent.op_kind).toBe("navigate");
    expect(sent.unbrowse_receipt_ptr).toBe("sha256:shared-address");
    // The covenant verb + scripture witness must NEVER cross the wire.
    expect(sent.kind).toBeUndefined();
    expect(sent.witness).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("actuate");
    expect(JSON.stringify(sent)).not.toContain("verse:");
    expect(result.ledgerReceiptPtr).toBe("sha256:peerledger");
  });

  test("fires against a REAL Bun.serve aiko proxy", async () => {
    const seen: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/op") {
          seen.push(await req.json());
          return new Response(JSON.stringify({ receipt_ptr: "sha256:realpeer" }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await mirrorToCovenantLedger(
        { AIKO_OP_URL: `http://localhost:${server.port}` },
        {
          kind: "observe",
          action: "snap",
          params: {},
          witness: "verse:Genesis 1:4",
          identity: "wallet:" + "cd".repeat(32),
          covenantReceiptPtr: "sha256:real-shared",
        },
      );
      expect(result.ok).toBe(true);
      expect(result.ledgerReceiptPtr).toBe("sha256:realpeer");
      expect(seen.length).toBe(1);
      const body = seen[0] as Record<string, unknown>;
      expect(body.op_class).toBe("read");
      expect(body.witness).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});

// ─── 5b. Peer mirror graceful no-op when unset ──────────────────────────────

describe("mirrorToCovenantLedger — graceful no-op", () => {
  test("with no peer configured, skips without throwing", async () => {
    let fetchCalled = false;
    const fakeFetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const result = await mirrorToCovenantLedger(
      {}, // no COVENANT_LEDGER_URL, no PEER_URLS
      {
        kind: "build",
        action: "skill",
        params: {},
        witness: "verse:Genesis 1:11",
        identity: "wallet:" + "ef".repeat(32),
        covenantReceiptPtr: "sha256:no-peer",
      },
      { fetchImpl: fakeFetch },
    );

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fetchCalled).toBe(false);
  });
});

// ─── 6. covenantReceiptPtr matches deriveCovenantReceiptPtr(canonical body) ──

describe("POST /v1/covenant — shared content-address proof", () => {
  test("response covenantReceiptPtr == deriveCovenantReceiptPtr(canonical)", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { pubHex, privKey } = await genKeypair();

    const n = nonce();
    const partial = {
      pointer: "arg://breath/navigate",
      nonce: n,
      contextHash: await sha256Hex("ctx"),
      commitment: await sha256Hex(`v:${n}`),
    };
    const signature = await signHex(privKey, auditSignedFragment(partial));
    const params = { ...partial, walletPubkey: pubHex };

    const { json } = await postJson(app, env, "/v1/covenant", {
      kind: "actuate:navigate",
      params,
      identity: `wallet:${pubHex}`,
      signature,
      signatureScheme: "ed25519-v7.0",
    });

    // Recompute the canonical body the route hashes (same insertion order).
    const expectedCanonical = canonicalize({
      kind: "actuate",
      action: "navigate",
      params,
      witness: "verse:Genesis 1:3", // DEFAULT_WITNESS.actuate (no witness on the wire)
      identity: `wallet:${pubHex.toLowerCase()}`,
      signatureScheme: "ed25519-v7.0",
      signature,
    });
    const expected = await deriveCovenantReceiptPtr(expectedCanonical);
    expect(json.covenantReceiptPtr).toBe(expected);
  });
});

// ─── 7. session_park dispatch (sibling-service call-into) ────────────────────

describe("POST /v1/covenant — actuate:session_park (session-state dispatch)", () => {
  test("dispatches to session-state, persists row", async () => {
    const app = mountApp();
    const env = makeEnv();
    const { pubHex, privKey } = await genKeypair();

    const body: Omit<SessionParkBody, "signature"> = {
      sessionId: "park-1",
      targetUrl: "https://x.com",
      targetId: "tab-1",
      contextId: "ctx-1",
      boundPointers: [],
      capturedEndpointsHash: await sha256Hex("endpoints"),
      walletPubkey: pubHex,
      signatureScheme: "ed25519-v7.2",
      parked_at: Date.now(),
    };
    const signature = await signHex(privKey, sessionSignedFragment(body as SessionParkBody));

    const { status, json } = await postJson(app, env, "/v1/covenant", {
      kind: "actuate:session_park",
      params: { ...body },
      identity: `wallet:${pubHex}`,
      signature,
      signatureScheme: "ed25519-v7.2",
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.kind).toBeUndefined();
    expect(json.action).toBeUndefined();
    expect(json.verify_ok).toBe(true);

    const dump = (env.SESSION_STATE as unknown as MemoryKV)._dump();
    expect(Array.from(dump.keys()).some((k) => k.startsWith("session:"))).toBe(true);
  });
});
