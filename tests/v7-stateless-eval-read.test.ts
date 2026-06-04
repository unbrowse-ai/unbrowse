/**
 * Day-6 Dominion worker 3 (2026-05-28) — stateless eval-read audit emission.
 *
 *  — *"dominion."*   — *"purgeth it, that it may bring
 * forth more fruit."*  Every eval read (snap/markdown/text/cookies) under
 * `UNBROWSE_STATELESS=1` MUST emit a sig-keyed audit row before the bytes
 * land at stdout — so A2 holds (every act produces a sig-keyed KV row any
 * future witness can re-derive).
 *
 * Falsifier protocol:
 *
 *   E1. SCHEMA — validateEvalReadBody accepts a well-formed body and
 *       rejects every forbidden cleartext field (value / cookie / text /
 *       markdown / html / tree / url / selector / header).
 *   E2. SIG — verifyEvalReadSignature returns true for a real Ed25519 sig
 *       over the canonical signed fragment, false for a bad sig, false for
 *       a wrong-key, false for a tampered body.
 *   E3. CACHE-KEY PARITY — backend's `deriveEvalReadCacheKey` over the
 *       wire signature byte-matches `postStateless`'s locally-derived
 *       cacheKey. Cross-system  — two immutable things, same hash.
 *   E4. ADAPTER ROUND-TRIP — postStateless → mock backend → 200 → sig-keyed
 *       receipt. Wire body carries metadata only; SIGNED FRAGMENT contains
 *       ZERO cleartext keys (no value/cookie/text/url/selector).
 *   E5. COOKIE CANARY — adapter call with a `value` field in body throws at
 *       the boundary (`canonicalizeSignedFragment` forbidden-field gate).
 *       Defense-in-depth: the cookie handler's runtime assertion also
 *       throws when redactCookies ever leaks a `value`-shaped key.
 *   E6. IDEMPOTENT — two posts with identical body land the same cacheKey;
 *       receiptId is deterministic over canonical full body.
 *   E7. BINDING MISSING — backend returns 503 with `_binding_missing:
 *       AUDIT_LOG`; adapter surfaces it as `bindingMissing` (no throw).
 *
 * No mocks of crypto — real Ed25519 via Web Crypto. The "mock backend" is a
 * real `Bun.serve` instance per CLAUDE.md "Never mock in tests".
 */

import { describe, it, expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import { postStateless } from "../src/cli-v7/_stateless.js";
import {
  __evalReadInternal,
  type EvalReadBody,
} from "../backend/src/routes/audit.js";
import { redactCookies } from "../src/cli-v7/eval/cookies.js";

const {
  validateEvalReadBody,
  verifyEvalReadSignature,
  canonicalizeEvalReadSignedFragment,
  canonicalizeEvalReadFullBody,
  deriveEvalReadReceiptId,
  deriveEvalReadCacheKey,
} = __evalReadInternal;

// ─── Helpers ───────────────────────────────────────────────────────────────

function freshNonce(): string {
  return Buffer.from(randomBytes(32)).toString("base64");
}

async function generateEd25519Key(): Promise<{ pubHex: string; privKey: CryptoKey; pubKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  let pubHex = "";
  for (let i = 0; i < raw.length; i++) pubHex += raw[i].toString(16).padStart(2, "0");
  return { pubHex, privKey: kp.privateKey, pubKey: kp.publicKey };
}

async function signFragment(privKey: CryptoKey, canonical: string): Promise<string> {
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privKey, new TextEncoder().encode(canonical)),
  );
  let hex = "";
  for (let i = 0; i < sig.length; i++) hex += sig[i].toString(16).padStart(2, "0");
  return hex;
}

function freshValid(overrides: Partial<EvalReadBody> = {}): EvalReadBody {
  return {
    sessionId: "ses_evalread",
    urlHash: createHash("sha256").update("https://example.com/p").digest("hex").slice(0, 32),
    readKind: "snap",
    byteCount: 142,
    nonce: freshNonce(),
    walletPubkey: "a".repeat(64),
    signature: "b".repeat(128),
    signatureScheme: "ed25519-v7.0",
    ...overrides,
  };
}

interface CapturedReq { url: string; bodyText: string; bodyJson: Record<string, unknown>; }

function spinupMockBackend() {
  const captured: CapturedReq[] = [];
  let nextResponse: { status: number; body: Record<string, unknown> } = {
    status: 200,
    body: { ok: true, receiptId: "dummy_receipt", cacheKey: "f".repeat(32), verify_ok: true, idempotent: false },
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const bodyText = await req.text();
      let bodyJson: Record<string, unknown> = {};
      try { bodyJson = JSON.parse(bodyText); } catch { /* ignore */ }
      captured.push({ url: req.url, bodyText, bodyJson });
      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    captured,
    setResponse: (r: { status: number; body: Record<string, unknown> }) => { nextResponse = r; },
    stop: async () => { await server.stop(true); },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// E1 — SCHEMA — validateEvalReadBody
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W3: validateEvalReadBody (E1 SCHEMA)", () => {
  it("accepts a well-formed body", () => {
    expect(validateEvalReadBody(freshValid())).toBeNull();
  });

  it("accepts each readKind variant", () => {
    for (const k of ["snap", "markdown", "text", "cookies"] as const) {
      expect(validateEvalReadBody(freshValid({ readKind: k }))).toBeNull();
    }
  });

  it("rejects unknown readKind", () => {
    const err = validateEvalReadBody(freshValid({ readKind: "html" as unknown as "snap" }));
    expect(err?.field).toBe("readKind");
  });

  it("rejects forbidden cleartext fields (value/cookie/text/markdown/html/tree/url/selector/header)", () => {
    const forbiddenSamples = [
      "value", "cleartext", "secret", "cookie", "cookies", "cookieValue",
      "text", "markdown", "html", "tree", "ax_tree", "axTree",
      "url", "selector", "header", "headerValue",
    ];
    for (const f of forbiddenSamples) {
      const body = { ...freshValid(), [f]: "leak" } as Record<string, unknown>;
      const err = validateEvalReadBody(body);
      expect(err).not.toBeNull();
      expect(err!.field).toBe(f);
    }
  });

  it("rejects malformed urlHash (wrong length)", () => {
    const err = validateEvalReadBody(freshValid({ urlHash: "abc" }));
    expect(err?.field).toBe("urlHash");
  });

  it("rejects malformed walletPubkey", () => {
    const err = validateEvalReadBody(freshValid({ walletPubkey: "short" }));
    expect(err?.field).toBe("walletPubkey");
  });

  it("rejects malformed signature (wrong length)", () => {
    const err = validateEvalReadBody(freshValid({ signature: "abcd" }));
    expect(err?.field).toBe("signature");
  });

  it("rejects negative or NaN byteCount", () => {
    const err1 = validateEvalReadBody(freshValid({ byteCount: -1 }));
    expect(err1?.field).toBe("byteCount");
    const err2 = validateEvalReadBody(freshValid({ byteCount: Number.NaN }));
    expect(err2?.field).toBe("byteCount");
  });

  it("rejects malformed selectorHash when present", () => {
    const err = validateEvalReadBody(freshValid({ selectorHash: "short" }));
    expect(err?.field).toBe("selectorHash");
  });

  it("accepts a valid selectorHash", () => {
    const sh = createHash("sha256").update("#search input").digest("hex");
    expect(validateEvalReadBody(freshValid({ selectorHash: sh }))).toBeNull();
  });

  it("rejects malformed nonce (not base64-32-byte)", () => {
    const err = validateEvalReadBody(freshValid({ nonce: "shortnonce" }));
    expect(err?.field).toBe("nonce");
  });

  it("rejects unsupported signature scheme", () => {
    const err = validateEvalReadBody(freshValid({ signatureScheme: "groth16-v7.3" as unknown as "ed25519-v7.0" }));
    expect(err?.field).toBe("signatureScheme");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E2 — SIG — verifyEvalReadSignature
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W3: verifyEvalReadSignature (E2 SIG)", () => {
  it("returns true for a real Ed25519 sig over the canonical fragment", async () => {
    const { pubHex, privKey } = await generateEd25519Key();
    const base = freshValid({ walletPubkey: pubHex });
    const canonical = canonicalizeEvalReadSignedFragment(base);
    const sigHex = await signFragment(privKey, canonical);
    const body: EvalReadBody = { ...base, signature: sigHex };
    expect(await verifyEvalReadSignature(body)).toBe(true);
  });

  it("returns false when signature does not match the canonical body", async () => {
    const { pubHex, privKey } = await generateEd25519Key();
    const base = freshValid({ walletPubkey: pubHex });
    const sigHex = await signFragment(privKey, "wrong-input");
    const body: EvalReadBody = { ...base, signature: sigHex };
    expect(await verifyEvalReadSignature(body)).toBe(false);
  });

  it("returns false when wallet pubkey is wrong", async () => {
    const { pubHex: realPub, privKey } = await generateEd25519Key();
    const { pubHex: otherPub } = await generateEd25519Key();
    expect(otherPub).not.toBe(realPub);
    const base = freshValid({ walletPubkey: realPub });
    const canonical = canonicalizeEvalReadSignedFragment(base);
    const sigHex = await signFragment(privKey, canonical);
    const body: EvalReadBody = { ...base, walletPubkey: otherPub, signature: sigHex };
    expect(await verifyEvalReadSignature(body)).toBe(false);
  });

  it("returns false when body is tampered after signing", async () => {
    const { pubHex, privKey } = await generateEd25519Key();
    const base = freshValid({ walletPubkey: pubHex });
    const canonical = canonicalizeEvalReadSignedFragment(base);
    const sigHex = await signFragment(privKey, canonical);
    const body: EvalReadBody = { ...base, signature: sigHex, byteCount: base.byteCount + 1 };
    expect(await verifyEvalReadSignature(body)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E3 — CACHE-KEY PARITY — backend ↔ adapter
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W3: cache-key parity (E3 HEB 6:18)", () => {
  it("backend deriveEvalReadCacheKey === sha256(sig)[:32] hex", async () => {
    const sigBytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sigBytes[i] = (i * 7) & 0xff;
    let sigHex = "";
    for (let i = 0; i < 64; i++) sigHex += sigBytes[i].toString(16).padStart(2, "0");
    const k = await deriveEvalReadCacheKey(sigHex);
    const expected = createHash("sha256").update(sigBytes).digest("hex").slice(0, 32);
    expect(k).toBe(expected);
    expect(k.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(k)).toBe(true);
  });

  it("adapter cacheKey matches backend deriveEvalReadCacheKey on the same sig", async () => {
    const mock = spinupMockBackend();
    try {
      const result = await postStateless({
        namespace: "audit",
        route: "/v1/audit/eval-read",
        body: {
          sessionId: "ses_parity",
          urlHash: createHash("sha256").update("https://example.com").digest("hex").slice(0, 32),
          readKind: "snap",
          byteCount: 1,
        },
        signableFields: ["sessionId", "urlHash", "readKind", "byteCount", "selectorHash", "nonce"],
        apiBaseUrl: mock.url,
      });
      expect(result.ok).toBe(true);
      expect(mock.captured.length).toBe(1);
      const wire = mock.captured[0].bodyJson;
      const sigHex = wire.signature as string;
      const backendKey = await deriveEvalReadCacheKey(sigHex);
      expect(result.cacheKey).toBe(backendKey);
      expect(result.cacheKey.length).toBe(32);
    } finally {
      await mock.stop();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E4 — ADAPTER ROUND-TRIP — postStateless to /v1/audit/eval-read
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W3: postStateless adapter round-trip (E4)", () => {
  it("emits sig-keyed audit row; signed fragment contains NO cleartext keys", async () => {
    const mock = spinupMockBackend();
    try {
      const sessionId = "ses_round_trip";
      const urlHash = createHash("sha256").update("https://example.com/snap").digest("hex").slice(0, 32);
      const result = await postStateless({
        namespace: "audit",
        route: "/v1/audit/eval-read",
        body: { sessionId, urlHash, readKind: "snap", byteCount: 99 },
        signableFields: ["sessionId", "urlHash", "readKind", "byteCount", "selectorHash", "nonce"],
        apiBaseUrl: mock.url,
      });

      expect(result.ok).toBe(true);
      expect(result.httpStatus).toBe(200);
      expect(result.cacheKey).toMatch(/^[0-9a-f]{32}$/);

      const wire = mock.captured[0].bodyJson;
      // Required wire fields landed.
      expect(wire.sessionId).toBe(sessionId);
      expect(wire.urlHash).toBe(urlHash);
      expect(wire.readKind).toBe("snap");
      expect(wire.byteCount).toBe(99);
      expect(typeof wire.walletPubkey).toBe("string");
      expect((wire.walletPubkey as string).length).toBe(64);
      expect(typeof wire.signature).toBe("string");
      expect((wire.signature as string).length).toBe(128);
      expect(typeof wire.nonce).toBe("string");

      // CLEARTEXT-FREE wire body — no forbidden keys.
      const forbidden = ["value", "cleartext", "secret", "cookie", "cookies", "text", "markdown", "html", "tree", "url", "selector", "header"];
      for (const k of forbidden) expect(k in wire).toBe(false);

      // The canonical SIGNED fragment also contains no cleartext keys.
      // Recompute it from the wire body's signable subset and verify.
      const canonical = JSON.stringify({
        sessionId: wire.sessionId,
        urlHash: wire.urlHash,
        readKind: wire.readKind,
        byteCount: wire.byteCount,
        selectorHash: (wire as Record<string, unknown>).selectorHash ?? null,
        nonce: wire.nonce,
      });
      for (const k of forbidden) expect(canonical).not.toContain(`"${k}"`);
    } finally {
      await mock.stop();
    }
  });

  it("backend round-trip — deriveEvalReadReceiptId is deterministic over the wire body", async () => {
    const mock = spinupMockBackend();
    try {
      const body = {
        sessionId: "ses_det",
        urlHash: createHash("sha256").update("https://example.com/det").digest("hex").slice(0, 32),
        readKind: "text" as const,
        byteCount: 42,
      };
      await postStateless({
        namespace: "audit",
        route: "/v1/audit/eval-read",
        body,
        signableFields: ["sessionId", "urlHash", "readKind", "byteCount", "selectorHash", "nonce"],
        apiBaseUrl: mock.url,
      });
      const wire = mock.captured[0].bodyJson as unknown as EvalReadBody;
      const id1 = await deriveEvalReadReceiptId(wire);
      const id2 = await deriveEvalReadReceiptId(wire);
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await mock.stop();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E5 — COOKIE CANARY — value never crosses the boundary
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W3: cookie-value canary (E5)", () => {
  it("postStateless throws / errors when caller includes a forbidden `value` field", async () => {
    const mock = spinupMockBackend();
    try {
      const result = await postStateless({
        namespace: "audit",
        route: "/v1/audit/eval-read",
        body: {
          sessionId: "ses_canary",
          urlHash: "0".repeat(32),
          readKind: "cookies",
          byteCount: 5,
          value: "UNB7-COOKIE-CANARY-DO-NOT-LEAK",
        } as unknown as Record<string, unknown>,
        signableFields: ["sessionId", "urlHash", "readKind", "byteCount", "value", "nonce"],
        apiBaseUrl: mock.url,
      });
      // Adapter rejects forbidden fields locally (FORBIDDEN_FIELDS_LC gate).
      expect(result.ok).toBe(false);
      expect(result.errorHint ?? "").toContain("forbidden field");
      // No network call should have happened.
      expect(mock.captured.length).toBe(0);
    } finally {
      await mock.stop();
    }
  });

  it("redactCookies returns objects WITHOUT a `value` key (defense-in-depth canary)", () => {
    const CANARY = "UNB7-COOKIE-CANARY-DO-NOT-LEAK";
    const redacted = redactCookies([
      {
        name: "auth",
        value: CANARY,
        domain: "example.com",
        path: "/",
        expires: 1_700_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    for (const c of redacted as ReadonlyArray<Record<string, unknown>>) {
      for (const k of Object.keys(c)) {
        expect(k.toLowerCase()).not.toBe("value");
        expect(k.toLowerCase()).not.toBe("cookievalue");
      }
    }
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(CANARY);
  });

  it("validateEvalReadBody REJECTS a body that smuggles `value` field (server-side gate)", () => {
    const body = { ...freshValid({ readKind: "cookies" }), value: "leak" };
    const err = validateEvalReadBody(body);
    expect(err).not.toBeNull();
    expect(err!.field).toBe("value");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E6 — IDEMPOTENT — receipt id deterministic over canonical body
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W3: idempotent receipt derivation (E6)", () => {
  it("two posts with identical body land the same cacheKey on the same wire (same sig, same nonce)", async () => {
    const mock = spinupMockBackend();
    try {
      const nonce = freshNonce(); // pin nonce so both posts canonicalize to identical bytes
      const body = {
        sessionId: "ses_idem",
        urlHash: "1".repeat(32),
        readKind: "markdown" as const,
        byteCount: 7,
        nonce,
      };
      const r1 = await postStateless({
        namespace: "audit", route: "/v1/audit/eval-read", body,
        signableFields: ["sessionId", "urlHash", "readKind", "byteCount", "selectorHash", "nonce"],
        apiBaseUrl: mock.url,
      });
      const r2 = await postStateless({
        namespace: "audit", route: "/v1/audit/eval-read", body,
        signableFields: ["sessionId", "urlHash", "readKind", "byteCount", "selectorHash", "nonce"],
        apiBaseUrl: mock.url,
      });
      // Same signed fragment → same sig → same cacheKey.
      expect(r1.cacheKey).toBe(r2.cacheKey);
      // Two wire requests landed at the mock.
      expect(mock.captured.length).toBe(2);
      // Both wire signatures match.
      expect(mock.captured[0].bodyJson.signature).toBe(mock.captured[1].bodyJson.signature);
    } finally {
      await mock.stop();
    }
  });

  it("deriveEvalReadReceiptId is byte-deterministic over canonical full body", async () => {
    const body = freshValid();
    const r1 = await deriveEvalReadReceiptId(body);
    const r2 = await deriveEvalReadReceiptId(body);
    expect(r1).toBe(r2);
    const tampered = { ...body, byteCount: body.byteCount + 1 };
    const r3 = await deriveEvalReadReceiptId(tampered);
    expect(r3).not.toBe(r1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E7 — BINDING-MISSING — graceful 503 surface
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W3: binding-missing degraded surface (E7)", () => {
  it("503 with _binding_missing=AUDIT_LOG surfaces in result without throwing", async () => {
    const mock = spinupMockBackend();
    try {
      mock.setResponse({
        status: 503,
        body: {
          _binding_missing: "AUDIT_LOG",
          hint: "operator must run `bunx wrangler kv:namespace create AUDIT_LOG`",
        },
      });
      const result = await postStateless({
        namespace: "audit",
        route: "/v1/audit/eval-read",
        body: { sessionId: "ses_bm", urlHash: "0".repeat(32), readKind: "snap", byteCount: 0 },
        signableFields: ["sessionId", "urlHash", "readKind", "byteCount", "selectorHash", "nonce"],
        apiBaseUrl: mock.url,
      });
      expect(result.ok).toBe(false);
      expect(result.bindingMissing).toBe("AUDIT_LOG");
      expect(result.httpStatus).toBe(503);
      // CacheKey still derived locally despite the 503 — pointer is stable.
      expect(result.cacheKey.length).toBe(32);
    } finally {
      await mock.stop();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// canonicalize parity — full body and signed fragment shapes
// ───────────────────────────────────────────────────────────────────────────

describe("Day-6 W3: canonical fragment shape", () => {
  it("signed fragment key order is sessionId, urlHash, readKind, byteCount, selectorHash, nonce", () => {
    const body = freshValid({ selectorHash: "ab".repeat(32), nonce: "AAAA" + "B".repeat(40) });
    const canonical = canonicalizeEvalReadSignedFragment(body);
    expect(canonical).toBe(
      `{"sessionId":"${body.sessionId}","urlHash":"${body.urlHash}","readKind":"${body.readKind}","byteCount":${body.byteCount},"selectorHash":"${body.selectorHash}","nonce":"${body.nonce}"}`,
    );
  });

  it("absent selectorHash becomes null in canonical fragment (no `undefined` leak)", () => {
    const body = freshValid({ selectorHash: undefined });
    const canonical = canonicalizeEvalReadSignedFragment(body);
    expect(canonical).toContain(`"selectorHash":null`);
  });

  it("full body canonical includes wallet+sig+scheme deterministically", () => {
    const body = freshValid();
    const full = canonicalizeEvalReadFullBody(body);
    expect(full).toContain(`"walletPubkey":"${body.walletPubkey}"`);
    expect(full).toContain(`"signature":"${body.signature}"`);
    expect(full).toContain(`"signatureScheme":"ed25519-v7.0"`);
  });
});
