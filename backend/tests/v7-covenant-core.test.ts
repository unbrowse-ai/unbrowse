/**
 * v7-covenant-core — proves the ONE shared substrate module (W25-shared)
 * byte-matches the existing audit.ts reference primitives, so Wave B can rip
 * the 5 redeclarations without breaking byte-compat (receipt-id idempotency).
 *
 * No mocks. Real Web Crypto (sha256, Ed25519 generateKey/sign/verify). The
 * byte-compat tests import BOTH covenant-core AND the live audit.ts and assert
 * equality on real outputs (CLAUDE.md: never mock; hit real functions).
 *
 * Eph 4:4 — one body: these tests are the two-witness seal (Deut 19:15) that
 * the consolidated limb produces the SAME bytes as the reference limb.
 */

import { describe, expect, test } from "bun:test";
import {
  hexToBytes,
  bytesToHex,
  base64ToBytes,
  bytesToBase64,
  canonicalize,
  deriveReceiptId,
  deriveCovenantReceiptPtr,
  deriveCacheKey,
  verifyEd25519,
  assertNoCleartext,
  DEFAULT_FORBIDDEN_FIELDS,
  bindingMissingEnvelope,
  isBindingMissingError,
  walletKey,
} from "../src/services/covenant-core.js";
import {
  canonicalizeFullBody,
  deriveReceiptId as auditDeriveReceiptId,
  type AuditFillBody,
} from "../src/services/audit.js";

// ─── Local test helpers (do NOT import the SUT for these — independent) ─────

function refBytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function genKeypair(): Promise<{ pubHex: string; privKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: refBytesToHex(pubRaw), privKey: kp.privateKey };
}

async function refSha256Hex(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return refBytesToHex(new Uint8Array(hash));
}

function refBytesToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

async function sampleAuditBody(pubHex: string): Promise<AuditFillBody> {
  const nonce = refBytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  return {
    pointer: "op://Vault/Login/password",
    nonce,
    contextHash: await refSha256Hex("https://example.com:input#login:1716000000"),
    commitment: await refSha256Hex(`secret-value-bytes:${nonce}`),
    walletPubkey: pubHex,
    signatureScheme: "ed25519-v7.0",
    signature: "ab".repeat(64), // 128 hex chars; receipt-id is over the full body incl. sig
    variant: "fill",
    selectorHash: await refSha256Hex("input#password"),
  };
}

// ─── 1. hex round-trip byte-identity ────────────────────────────────────────

describe("hex helpers", () => {
  test("hexToBytes ∘ bytesToHex is the identity (random bytes)", () => {
    for (let trial = 0; trial < 32; trial++) {
      const len = 1 + Math.floor(Math.random() * 80);
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      const hex = bytesToHex(bytes);
      expect(hex.length).toBe(len * 2);
      expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
    }
  });

  test("hexToBytes strips 0x prefix and is lowercase-output", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex(bytes)).toBe("deadbeef");
    expect(Array.from(hexToBytes("0xDEADBEEF"))).toEqual(Array.from(bytes));
    expect(Array.from(hexToBytes("deadbeef"))).toEqual(Array.from(bytes));
  });

  test("hexToBytes rejects odd-length and non-hex", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });

  test("base64 round-trip byte-identity", () => {
    for (let trial = 0; trial < 16; trial++) {
      const bytes = crypto.getRandomValues(new Uint8Array(1 + Math.floor(Math.random() * 100)));
      const b64 = bytesToBase64(bytes);
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
  });
});

// ─── 2. canonicalize: stable order + byte-match vs audit.canonicalizeFullBody ─

describe("canonicalize", () => {
  test("insertion-order stringify — NOT sorted-key", () => {
    const obj = { z: 1, a: 2, m: 3 };
    expect(canonicalize(obj)).toBe('{"z":1,"a":2,"m":3}');
  });

  test("fieldOrder projection coerces absent fields to null", () => {
    const obj = { b: "x", a: "y" };
    expect(canonicalize(obj, ["a", "b", "c"])).toBe('{"a":"y","b":"x","c":null}');
  });

  test("byte-matches audit.ts canonicalizeFullBody field-order", async () => {
    const { pubHex } = await genKeypair();
    const body = await sampleAuditBody(pubHex);
    // Reconstruct audit.ts's exact field order via canonicalize(obj, order).
    const order = [
      "pointer",
      "nonce",
      "contextHash",
      "commitment",
      "walletPubkey",
      "signatureScheme",
      "signature",
      "variant",
      "urlHash",
      "selectorHash",
      "headerNameHash",
      "payloadPath",
      "actType",
    ];
    const viaCore = canonicalize(
      {
        ...body,
        signatureScheme: body.signatureScheme ?? "ed25519-v7.0",
      },
      order,
    );
    const viaAudit = canonicalizeFullBody(body);
    expect(viaCore).toBe(viaAudit);
  });
});

// ─── 3. deriveReceiptId byte-match against audit.ts deriveReceiptId ─────────

describe("deriveReceiptId byte-compat (load-bearing — Wave B idempotency)", () => {
  test("covenant-core.deriveReceiptId(canonicalFullBody) === audit.deriveReceiptId(body)", async () => {
    const { pubHex } = await genKeypair();
    for (let trial = 0; trial < 5; trial++) {
      const body = await sampleAuditBody(pubHex);
      const fromCore = await deriveReceiptId(canonicalizeFullBody(body));
      const fromAudit = await auditDeriveReceiptId(body);
      expect(fromCore).toBe(fromAudit);
      expect(fromCore).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("deriveCovenantReceiptPtr = 'sha256:' + deriveReceiptId (binary blob-ptr form)", async () => {
    const canonical = '{"a":1,"b":"two"}';
    const bare = await deriveReceiptId(canonical);
    const ptr = await deriveCovenantReceiptPtr(canonical);
    expect(ptr).toBe(`sha256:${bare}`);
    // Independent recompute matches (proves we hash JSON.stringify bytes, not sorted-key).
    expect(bare).toBe(await refSha256Hex(canonical));
  });
});

// ─── 4. deriveCacheKey = sha256(sig)[:32] byte-match ───────────────────────

describe("deriveCacheKey", () => {
  test("= sha256(signature) truncated to 32 hex chars", async () => {
    const sig = crypto.getRandomValues(new Uint8Array(64));
    const cacheKey = await deriveCacheKey(sig);
    const full = refBytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", sig)));
    expect(cacheKey).toBe(full.slice(0, 32));
    expect(cacheKey.length).toBe(32);
  });
});

// ─── 5. verifyEd25519 round-trip ────────────────────────────────────────────

describe("verifyEd25519", () => {
  test("verifies a signature it produced; rejects a tampered message", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pubHex = refBytesToHex(await crypto.subtle.exportKey("raw", kp.publicKey));
    const message = new TextEncoder().encode('{"hello":"world"}');
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, message));
    const sigHex = refBytesToHex(sig);

    expect(await verifyEd25519(pubHex, sigHex, message)).toBe(true);
    // Tampered message → false.
    expect(await verifyEd25519(pubHex, sigHex, new TextEncoder().encode("tampered"))).toBe(false);
  });

  test("returns false (never throws) on malformed input", async () => {
    const m = new TextEncoder().encode("x");
    expect(await verifyEd25519("zz", "ab".repeat(64), m)).toBe(false); // bad pub hex
    expect(await verifyEd25519("ab".repeat(32), "short", m)).toBe(false); // bad sig
    expect(await verifyEd25519("ab".repeat(16), "ab".repeat(64), m)).toBe(false); // wrong pub len
  });
});

// ─── 6. assertNoCleartext rejects each forbidden field; accepts a clean body ─

describe("assertNoCleartext", () => {
  test("rejects every default forbidden field name", () => {
    for (const field of DEFAULT_FORBIDDEN_FIELDS) {
      const err = assertNoCleartext({ [field]: "leak" });
      expect(err).not.toBeNull();
      expect(err!.field).toBe(field);
    }
  });

  test("matches case-insensitively", () => {
    expect(assertNoCleartext({ CookieValue: "x" })).not.toBeNull();
    expect(assertNoCleartext({ SECRET: "x" })).not.toBeNull();
  });

  test("accepts a clean pointer/hash-only body", () => {
    const clean = {
      pointer: "op://Vault/Item/field",
      walletPubkey: "ab".repeat(32),
      signature: "cd".repeat(64),
      contextHash: "ef".repeat(32),
    };
    expect(assertNoCleartext(clean)).toBeNull();
  });

  test("respects a caller-supplied forbidden list", () => {
    expect(assertNoCleartext({ customSecret: "x" })).toBeNull(); // not in default
    expect(assertNoCleartext({ customSecret: "x" }, ["customSecret"])).not.toBeNull();
  });
});

// ─── 7. bindingMissingEnvelope shape + isBindingMissingError guard ──────────

describe("BindingMissingError envelope", () => {
  test("bindingMissingEnvelope carries the discriminant + actionable hint", () => {
    const env = bindingMissingEnvelope("SESSION_STATE");
    expect(env._binding_missing).toBe("SESSION_STATE");
    expect(env.hint).toContain("wrangler kv:namespace create SESSION_STATE");
    expect(isBindingMissingError(env)).toBe(true);
  });

  test("isBindingMissingError rejects non-envelopes", () => {
    expect(isBindingMissingError(null)).toBe(false);
    expect(isBindingMissingError({})).toBe(false);
    expect(isBindingMissingError({ _binding_missing: 42 })).toBe(false);
    expect(isBindingMissingError({ ok: true })).toBe(false);
  });
});

// ─── bonus: walletKey shape (replaces the 5 *PrimaryKey builders) ──────────

describe("walletKey", () => {
  test("builds prefix:wallet-lc-no-0x:suffix", () => {
    expect(walletKey("session", "0xABCDEF", "sess-1")).toBe("session:abcdef:sess-1");
    expect(walletKey("trace", "ABCDEF", "")).toBe("trace:abcdef:");
  });
});
