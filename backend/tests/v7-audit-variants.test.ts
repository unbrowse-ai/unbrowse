/**
 * v7.0 audit-log — header-inject + payload-field variant tests (W12 wave, 2026-05-28).
 *
 * W8 shipped the `fill` variant real. W12 extends the audit log to
 * support `header-inject` and `payload-field` end-to-end:
 *
 *   - Schema gate now requires variant-specific locator + rejects
 *     sibling locators (a header-inject row carrying selectorHash is
 *     a category error — Deut 19:15, each variant is a distinct
 *     witness, never two-mouths from the same body).
 *   - payloadPath validation: JSON-path shape (`$.` or `$['...']`),
 *     <=200 chars, no `=` or `:` or `"`.
 *   - Route gate rejects body.variant != URL variant
 *     (`route_body_variant_mismatch`).
 *   - Forbidden cleartext fields list extended to include raw
 *     `headerName` (canary against the most-common smuggling shape).
 *
 * Same Map-backed in-memory KV as v7-audit-log.test.ts — KV semantics,
 * not mocks (CLAUDE.md "Never mock in tests": the in-memory KV IS KV
 * semantics; it does not stub the surface under test, only its
 * substrate).
 *
 * Heb 4:13 — every fill is witnessed. The receipt is the witness; the
 * variant is the witness-shape (Deut 19:15 — two or three witnesses,
 * each distinct).
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { auditRoutes } from "../src/routes/audit.js";
import {
  canonicalizeSignedFragment,
  type AuditFillBody,
  type AuditVariant,
} from "../src/services/audit.js";
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

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hash));
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

/**
 * Variant-aware signed body builder. Defaults carry the variant's required
 * locator; overrides can substitute / clear it for negative tests.
 *
 * Deut 19:15 — the variant IS the witness-shape; the factory enforces it
 * so positive tests are honest (a `header-inject` body without
 * headerNameHash is not a real header-inject row, it's a category error).
 */
async function buildVariantBody(
  variant: AuditVariant,
  pubHex: string,
  privKey: CryptoKey,
  overrides: Partial<AuditFillBody> = {},
): Promise<AuditFillBody> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = bytesToBase64(nonceBytes);
  const contextHash = await sha256Hex(`https://example.com/api/x:${variant}:1716000000`);
  const commitment = await sha256Hex(`secret-value-bytes:${nonce}`);

  const variantLocator: Partial<AuditFillBody> = {};
  if (variant === "fill") {
    variantLocator.selectorHash = await sha256Hex("input#password");
  } else if (variant === "header-inject") {
    // Deliberately a sensitive header name so the canary asserts the
    // server sees only the hash, never the raw name.
    variantLocator.headerNameHash = await sha256Hex("Authorization");
  } else {
    variantLocator.payloadPath = "$.q";
  }

  const partial: Omit<AuditFillBody, "signature"> = {
    pointer: "op://Vault/Login/password",
    nonce,
    contextHash,
    commitment,
    walletPubkey: pubHex,
    signatureScheme: "ed25519-v7.0",
    variant,
    ...variantLocator,
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

// ─── 1. header-inject happy-path ───────────────────────────────────────────

describe("POST /v1/audit/header-inject — valid Ed25519 body", () => {
  test("returns 200 + receiptId; stores headerNameHash, not raw header name", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildVariantBody("header-inject", pubHex, privKey);

    const { status, json } = await postJson(app, env, "/v1/audit/header-inject", body);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.verify_ok).toBe(true);
    expect(json.idempotent).toBe(false);

    // CANARY: the body sent "Authorization" through sha256 client-side.
    // The server-stored row must carry only the hash, never the raw name.
    // Deut 19:15 — the hash is the witness; the raw name was never
    // admitted to the substrate.
    const expectedHash = await sha256Hex("Authorization");
    const dump = kv._dump();
    expect(dump.size).toBe(2);
    let foundPrimary: string | undefined;
    for (const [k, v] of dump) {
      if (k.startsWith("audit:") && !k.startsWith("audit:receipt:")) {
        foundPrimary = v;
        break;
      }
    }
    expect(foundPrimary).toBeDefined();
    const stored = JSON.parse(foundPrimary!);
    expect(stored.variant).toBe("header-inject");
    expect(stored.headerNameHash).toBe(expectedHash);
    // Negative: stored row carries no raw header name. Bytewise grep.
    expect(foundPrimary!).not.toContain("Authorization");
    expect(foundPrimary!).not.toContain("Cookie");
  });
});

// ─── 2. Route-body-variant mismatch ────────────────────────────────────────

describe("POST /v1/audit/header-inject — route/body variant mismatch", () => {
  test("body.variant='fill' posted to /header-inject → 400 route_body_variant_mismatch", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    // Build a valid fill body (with selectorHash) — post to the wrong route.
    const body = await buildVariantBody("fill", pubHex, privKey);

    const { status, json } = await postJson(app, env, "/v1/audit/header-inject", body);
    expect(status).toBe(400);
    expect(json.error).toBe("route_body_variant_mismatch");
    expect(json.expected).toBe("header-inject");
    expect(json.got).toBe("fill");
    // Nothing persisted.
    expect(kv._dump().size).toBe(0);
  });
});

// ─── 3. header-inject WITHOUT headerNameHash → 400 ─────────────────────────

describe("POST /v1/audit/header-inject — missing required locator", () => {
  test("body without headerNameHash → 400 missing_required_for_variant", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildVariantBody("header-inject", pubHex, privKey, {
      headerNameHash: undefined,
    });
    // The factory's variantLocator default sets headerNameHash; the
    // override clears it. Sanity:
    expect(body.headerNameHash).toBeUndefined();

    const { status, json } = await postJson(app, env, "/v1/audit/header-inject", body);
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_body");
    expect(json.field).toBe("headerNameHash");
    expect((json.reason as string)).toContain("missing_required_for_variant");
    expect(kv._dump().size).toBe(0);
  });
});

// ─── 4. header-inject WITH selectorHash → 400 (sibling locator forbidden) ──

describe("POST /v1/audit/header-inject — forbidden sibling locator", () => {
  test("body with both headerNameHash AND selectorHash → 400 unexpected_field_for_variant", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const selectorHash = await sha256Hex("input#password");
    const body = await buildVariantBody("header-inject", pubHex, privKey, {
      selectorHash,
    });

    const { status, json } = await postJson(app, env, "/v1/audit/header-inject", body);
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_body");
    expect(json.field).toBe("selectorHash");
    expect((json.reason as string)).toContain("unexpected_field_for_variant");
    expect(kv._dump().size).toBe(0);
  });
});

// ─── 5. payload-field happy-path with valid $.q ────────────────────────────

describe("POST /v1/audit/payload-field — valid JSON-path", () => {
  test("payloadPath='$.q' → 200; stored row carries the path", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildVariantBody("payload-field", pubHex, privKey, {
      payloadPath: "$.q",
    });

    const { status, json } = await postJson(app, env, "/v1/audit/payload-field", body);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.verify_ok).toBe(true);

    const dump = kv._dump();
    let primary: string | undefined;
    for (const [k, v] of dump) {
      if (k.startsWith("audit:") && !k.startsWith("audit:receipt:")) primary = v;
    }
    expect(primary).toBeDefined();
    const stored = JSON.parse(primary!);
    expect(stored.variant).toBe("payload-field");
    expect(stored.payloadPath).toBe("$.q");
  });

  test("payloadPath=\"$['user-id']\" bracket form → 200", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const body = await buildVariantBody("payload-field", pubHex, privKey, {
      payloadPath: "$['user-id']",
    });

    const { status, json } = await postJson(app, env, "/v1/audit/payload-field", body);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });
});

// ─── 6. payload-field with embedded value (`=`) → 400 ──────────────────────

describe("POST /v1/audit/payload-field — payload smuggling rejected", () => {
  test("payloadPath='user=admin' (contains '=') → 400", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    // Build a body with smuggled value-shaped path. The factory signs the
    // canonical fragment (pointer/nonce/contextHash/commitment), which
    // does NOT include payloadPath — so the signature is still valid,
    // proving the schema gate is what catches the smuggling, not signature
    // verification.
    const body = await buildVariantBody("payload-field", pubHex, privKey, {
      payloadPath: "user=admin",
    });

    const { status, json } = await postJson(app, env, "/v1/audit/payload-field", body);
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_body");
    expect(json.field).toBe("payloadPath");
    expect(kv._dump().size).toBe(0);
  });

  test("payloadPath with embedded ':' → 400", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const { pubHex, privKey } = await genKeypair();
    const body = await buildVariantBody("payload-field", pubHex, privKey, {
      payloadPath: "$.headers.Authorization:Bearer",
    });
    const { status, json } = await postJson(app, env, "/v1/audit/payload-field", body);
    expect(status).toBe(400);
    expect(json.field).toBe("payloadPath");
  });

  test("payloadPath with double-quote → 400", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const { pubHex, privKey } = await genKeypair();
    const body = await buildVariantBody("payload-field", pubHex, privKey, {
      payloadPath: `$["x"]`,
    });
    const { status, json } = await postJson(app, env, "/v1/audit/payload-field", body);
    expect(status).toBe(400);
    expect(json.field).toBe("payloadPath");
  });
});

// ─── 7. payload-field too long → 400 ───────────────────────────────────────

describe("POST /v1/audit/payload-field — length cap", () => {
  test("payloadPath of 500 chars → 400", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    // 500-char dot-path starting with `$.` — passes shape gate but fails
    // length gate. `a.a.a.a...` x ~125 reps = ~500 chars.
    const longPath = "$." + "a.".repeat(249) + "a";
    expect(longPath.length).toBeGreaterThan(200);
    expect(longPath.length).toBeLessThanOrEqual(510);
    const body = await buildVariantBody("payload-field", pubHex, privKey, {
      payloadPath: longPath,
    });

    const { status, json } = await postJson(app, env, "/v1/audit/payload-field", body);
    expect(status).toBe(400);
    expect(json.field).toBe("payloadPath");
    expect((json.reason as string)).toContain("<= 200");
    expect(kv._dump().size).toBe(0);
  });
});

// ─── 8. CANARY: raw `headerName` field forbidden across all variants ───────

describe("POST any variant — raw headerName field is forbidden cleartext", () => {
  test("variant=header-inject with body.headerName='Cookie' → 400 forbidden_field", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const good = await buildVariantBody("header-inject", pubHex, privKey);
    // Splice in raw header name — the smuggling shape we ban.
    const smuggled = { ...good, headerName: "Cookie" };

    const { status, json } = await postJson(app, env, "/v1/audit/header-inject", smuggled);
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_body");
    expect(json.field).toBe("headerName");
    expect((json.reason as string)).toContain("forbidden");
    expect(kv._dump().size).toBe(0);
  });

  test("variant=fill with body.headerName='Authorization' → 400 forbidden_field (canary across variants)", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);
    const { pubHex, privKey } = await genKeypair();
    const good = await buildVariantBody("fill", pubHex, privKey);
    const smuggled = { ...good, headerName: "Authorization" };
    const { status, json } = await postJson(app, env, "/v1/audit/fill", smuggled);
    expect(status).toBe(400);
    expect(json.field).toBe("headerName");
  });
});

// ─── 9. All 3 variants verify-route round-trip ─────────────────────────────

describe("GET /v1/audit/verify/:receiptId — all three variants round-trip", () => {
  test("fill / header-inject / payload-field each verify_ok=true via verify route", async () => {
    const app = mountApp();
    const kv = makeMemoryKv();
    const env = makeEnv(kv);

    const { pubHex, privKey } = await genKeypair();
    const variants: AuditVariant[] = ["fill", "header-inject", "payload-field"];

    for (const v of variants) {
      const body = await buildVariantBody(v, pubHex, privKey);
      const route = `/v1/audit/${v}`;
      const post = await postJson(app, env, route, body);
      expect(post.status).toBe(200);
      expect(post.json.ok).toBe(true);
      expect(post.json.verify_ok).toBe(true);

      const receiptId = post.json.receiptId as string;
      const verify = await getJson(app, env, `/v1/audit/verify/${receiptId}`);
      expect(verify.status).toBe(200);
      expect(verify.json.verify_ok).toBe(true);
      expect(verify.json.scheme).toBe("ed25519-v7.0");
      // The verify endpoint must NEVER return the pointer or any locator.
      expect("pointer" in verify.json).toBe(false);
      expect("payloadPath" in verify.json).toBe(false);
      expect("headerNameHash" in verify.json).toBe(false);
      expect("selectorHash" in verify.json).toBe(false);
    }

    // Three primary + three pointer rows = 6 KV writes.
    expect(kv._dump().size).toBe(6);
  });
});
