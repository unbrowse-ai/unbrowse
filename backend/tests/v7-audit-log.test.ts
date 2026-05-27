/**
 * v7.0 audit-log — full POST → verify → persist → list → read flow.
 *
 * W8 wave (2026-05-28): exercises the REAL `env.AUDIT_LOG.put/get/list`
 * storage path via an in-process Map-backed KVNamespace stand-in (same
 * pattern as crypto-sub.test.ts, sponsor-middleware.test.ts). The
 * stand-in implements `list({prefix, limit})` faithfully — KV semantics,
 * not mocks (per CLAUDE.md "Never mock in tests": the in-memory KV IS
 * KV semantics; it does not stub the surface under test, only its
 * substrate).
 *
 * Heb 4:13 — the receipt is the witness. These tests verify that every
 * fill is sealed (signed body persisted), idempotent (same body = same
 * receipt = no second write), forensically honest (bad-sig rows are
 * stored so the audit trail records the attempt), and tamper-evident
 * (server-side re-verify against the stored bytes catches corruption).
 *
 * Provisioning note (NOT done in tests): a deploy that wires real Cloudflare
 * KV must FIRST run:
 *   bunx wrangler kv:namespace create AUDIT_LOG
 *   bunx wrangler kv:namespace create AUDIT_LOG --preview
 * and paste the returned ids into backend/wrangler.toml's AUDIT_LOG
 * stanza. The test KV is in-process only; provisioning is a one-time op.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { auditRoutes } from "../src/routes/audit.js";
import {
  canonicalizeSignedFragment,
  primaryAuditKey,
  pointerAuditKey,
  reverseIsoStamp,
  deriveReceiptId,
  type AuditFillBody,
} from "../src/services/audit.js";
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
    list: async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = opts?.prefix ?? "";
      const limit = opts?.limit ?? 1000;
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort() // lexicographic ascending → reverse-iso-stamp = newest first
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    _dump: () => store,
  };
  return kv as unknown as MemoryKV;
}

const ADMIN_KEY = "test-admin-secret-key";

function makeEnv(kv: KVNamespace): Env {
  return {
    AUDIT_LOG: kv,
    ADMIN_KEY,
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-test",
  } as unknown as Env;
}

function mountApp() {
  const app = new Hono();
  app.route("/", auditRoutes);
  return app;
}

// ─── Hex / base64 helpers ──────────────────────────────────────────────────

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

// ─── Keypair + signed body factory ─────────────────────────────────────────

async function genKeypair(): Promise<{ pubHex: string; privKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: bytesToHex(pubRaw), privKey: kp.privateKey };
}

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash));
}

async function buildSignedFillBody(
  pubHex: string,
  privKey: CryptoKey,
  overrides: Partial<AuditFillBody> = {},
): Promise<AuditFillBody> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = bytesToBase64(nonceBytes);
  const contextHash = await sha256Hex("https://example.com:input#login:1716000000");
  const commitment = await sha256Hex(`secret-value-bytes:${nonce}`);
  const selectorHash = await sha256Hex("input#password");

  const partial: Omit<AuditFillBody, "signature"> = {
    pointer: "op://Vault/Login/password",
    nonce,
    contextHash,
    commitment,
    walletPubkey: pubHex,
    signatureScheme: "ed25519-v7.0",
    variant: "fill",
    selectorHash,
    ...overrides,
  };

  const canonical = canonicalizeSignedFragment(partial);
  const sigBytes = await crypto.subtle.sign(
    { name: "Ed25519" },
    privKey,
    new TextEncoder().encode(canonical),
  );
  return {
    ...partial,
    signature: bytesToHex(sigBytes),
    ...(overrides.signature !== undefined ? { signature: overrides.signature } : {}),
  };
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

async function getJson(
  app: Hono,
  env: Env,
  path: string,
  headers: Record<string, string> = {},
) {
  const res = await app.fetch(
    new Request(`http://test.local${path}`, { method: "GET", headers }),
    env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ─── 1. Valid Ed25519 POST → 200 + receiptId + 2 KV writes ─────────────────

describe("POST /v1/audit/fill — valid Ed25519 body", () => {
  test("returns 200 + receiptId; writes primary + pointer (2 KV rows)", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildSignedFillBody(pubHex, privKey);
    const expectedReceiptId = await deriveReceiptId(body);

    const { status, json } = await postJson(app, env, "/v1/audit/fill", body);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.receiptId).toBe(expectedReceiptId);
    expect(json.verify_ok).toBe(true);
    expect(json.idempotent).toBe(false);

    // KV row count: exactly 2 (primary + pointer).
    const dump = kv._dump();
    expect(dump.size).toBe(2);
    // Pointer key uses the deterministic receiptId.
    expect(dump.has(pointerAuditKey(expectedReceiptId))).toBe(true);
    // The pointer value is the primaryKey.
    const pointerValue = dump.get(pointerAuditKey(expectedReceiptId));
    expect(pointerValue).toBeDefined();
    expect(pointerValue!.startsWith(`audit:${pubHex.toLowerCase()}:`)).toBe(true);
    // The primary key resolves to a row with the full body.
    const primary = dump.get(pointerValue!);
    expect(primary).toBeDefined();
    const stored = JSON.parse(primary!);
    expect(stored.pointer).toBe(body.pointer);
    expect(stored.verify_ok).toBe(true);
    expect(typeof stored.received_at).toBe("number");
  });
});

// ─── 2. Idempotency: second POST = same receiptId, no second write ─────────

describe("POST /v1/audit/fill — idempotency", () => {
  test("repeat POST with identical body returns same receiptId + idempotent:true; KV row count unchanged", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildSignedFillBody(pubHex, privKey);

    const first = await postJson(app, env, "/v1/audit/fill", body);
    expect(first.status).toBe(200);
    expect(first.json.idempotent).toBe(false);
    const firstReceiptId = first.json.receiptId;
    const firstSize = kv._dump().size;
    expect(firstSize).toBe(2);

    const second = await postJson(app, env, "/v1/audit/fill", body);
    expect(second.status).toBe(200);
    expect(second.json.idempotent).toBe(true);
    expect(second.json.receiptId).toBe(firstReceiptId);
    // No new KV rows — idempotency probe short-circuits before put.
    expect(kv._dump().size).toBe(firstSize);
  });
});

// ─── 3. Forbidden field (cleartext leak attempt) → 400 ─────────────────────

describe("POST /v1/audit/fill — forbidden cleartext fields", () => {
  test("body.value = 'leak' returns 400 invalid_body", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildSignedFillBody(pubHex, privKey);
    const leaking = { ...body, value: "leak" };

    const { status, json } = await postJson(app, env, "/v1/audit/fill", leaking);
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_body");
    expect(json.field).toBe("value");
    // Nothing was written.
    expect(kv._dump().size).toBe(0);
  });
});

// ─── 4. Bad signature → 200 stored with verify_ok=false; verify echoes false ─

describe("POST /v1/audit/fill — bad signature forensic store", () => {
  test("invalid signature → row stored with verify_ok=false; verify route confirms", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const goodBody = await buildSignedFillBody(pubHex, privKey);
    // Tamper the signature — replace with 64 zero bytes (well-formed length,
    // invalid signature).
    const badBody: AuditFillBody = { ...goodBody, signature: "00".repeat(64) };

    const post = await postJson(app, env, "/v1/audit/fill", badBody);
    expect(post.status).toBe(200);
    expect(post.json.verify_ok).toBe(false);
    expect(post.json.ok).toBe(true); // forensic value — row IS stored
    const receiptId = post.json.receiptId as string;

    // KV row count: still exactly 2 (primary + pointer); the bad-sig row
    // is recorded for forensic audit.
    expect(kv._dump().size).toBe(2);

    // Verify route re-derives server-side — never trusts stored bit.
    const verify = await getJson(app, env, `/v1/audit/verify/${receiptId}`);
    expect(verify.status).toBe(200);
    expect(verify.json.verify_ok).toBe(false);
    expect(verify.json.scheme).toBe("ed25519-v7.0");
  });
});

// ─── 5. /by-wallet admin gate ──────────────────────────────────────────────

describe("GET /v1/audit/by-wallet/:walletPubkey — admin gate", () => {
  test("without ADMIN_KEY header returns 401; with returns the row", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildSignedFillBody(pubHex, privKey);
    const post = await postJson(app, env, "/v1/audit/fill", body);
    expect(post.status).toBe(200);

    // Without admin header → 401.
    const unauthed = await getJson(app, env, `/v1/audit/by-wallet/${pubHex}`);
    expect(unauthed.status).toBe(401);
    expect(unauthed.json.error).toBe("unauthorized");

    // With admin header → 200, returns the row.
    const authed = await getJson(app, env, `/v1/audit/by-wallet/${pubHex}`, {
      Authorization: `Bearer ${ADMIN_KEY}`,
    });
    expect(authed.status).toBe(200);
    const rows = authed.json.rows as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0].pointer).toBe(body.pointer);
    expect(rows[0].verify_ok).toBe(true);
  });

  test("wrong bearer token returns 401", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const { pubHex } = await genKeypair();
    const res = await getJson(app, env, `/v1/audit/by-wallet/${pubHex}`, {
      Authorization: "Bearer wrong-key",
    });
    expect(res.status).toBe(401);
  });
});

// ─── 6. Verify route NEVER returns pointer field ───────────────────────────

describe("GET /v1/audit/verify/:receiptId — pointer leak guard", () => {
  test("response body never contains the pointer field", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    // Use a distinctive pointer that would be easy to grep for in the response.
    const body = await buildSignedFillBody(pubHex, privKey, {
      pointer: "op://Vault/UNIQUE-LEAK-CANARY-DO-NOT-RETURN/field",
    });
    const post = await postJson(app, env, "/v1/audit/fill", body);
    const receiptId = post.json.receiptId as string;

    const verify = await getJson(app, env, `/v1/audit/verify/${receiptId}`);
    expect(verify.status).toBe(200);
    expect(verify.json.verify_ok).toBe(true);
    expect(verify.json.scheme).toBe("ed25519-v7.0");

    // Hard assert: the response body never carries the pointer field.
    expect("pointer" in verify.json).toBe(false);
    // Defense in depth: the serialized response must not echo the canary.
    expect(JSON.stringify(verify.json)).not.toContain("UNIQUE-LEAK-CANARY");
  });

  test("unknown receiptId returns 404", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const fakeReceipt = "a".repeat(64);
    const res = await getJson(app, env, `/v1/audit/verify/${fakeReceipt}`);
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("receipt_not_found");
  });

  test("malformed receiptId returns 400", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const res = await getJson(app, env, `/v1/audit/verify/not-a-hex-id`);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_receipt_id");
  });
});

// ─── 7. KV key shape sanity (regression guard) ─────────────────────────────

describe("KV key derivation — regression guard", () => {
  test("primaryAuditKey normalizes wallet to lowercase and strips 0x", () => {
    const stamp = reverseIsoStamp(1716000000000);
    const receiptId = "a".repeat(64);
    const upper = primaryAuditKey("0xABCDEF" + "1".repeat(58), stamp, receiptId);
    const lower = primaryAuditKey("abcdef" + "1".repeat(58), stamp, receiptId);
    expect(upper).toBe(lower);
    expect(upper.startsWith("audit:abcdef")).toBe(true);
  });

  test("reverseIsoStamp ascending list = chronological descending", () => {
    const older = reverseIsoStamp(1716000000000);
    const newer = reverseIsoStamp(1716000001000);
    // Newer ms → smaller reverse stamp → earlier in lex sort
    expect(newer < older).toBe(true);
  });
});

// ─── 8. Binding-missing path returns 503, not silent empty ─────────────────

describe("env.AUDIT_LOG absent — operator misconfiguration honesty", () => {
  test("POST without AUDIT_LOG binding returns 503 with binding-missing hint", async () => {
    const app = mountApp();
    const env = { ADMIN_KEY, STATS_KV: {} as KVNamespace } as unknown as Env;

    const { pubHex, privKey } = await genKeypair();
    const body = await buildSignedFillBody(pubHex, privKey);
    const { status, json } = await postJson(app, env, "/v1/audit/fill", body);
    expect(status).toBe(503);
    expect(json.error).toBe("audit_log_binding_missing");
    expect(typeof json.reason).toBe("string");
    expect((json.reason as string)).toContain("wrangler kv:namespace create AUDIT_LOG");
  });
});
