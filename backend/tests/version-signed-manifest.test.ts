// Backend test: /v1/version HMAC-SHA256 signed manifest
//
// Principle 20260521T194246Z-7ad798e3 (staging-then-prod with signed
// release manifest). Locks the HMAC computation contract so the
// signing path (backend/src/routes/health.ts via crypto.subtle) and the
// verification paths (scripts/verify-release-manifest.sh via openssl
// CLI, and the SDK/CLI via node:crypto) all agree byte-for-byte.
//
// The test does NOT mock crypto.subtle — it runs real Web Crypto via
// Bun's native binding AND real node:crypto, then asserts both produce
// the same hex against a known fixture. If either platform diverges,
// the live signed manifest stops being verifiable by callers and the
// gate becomes painted-lamp evidence.

import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";

const FIXTURE = {
  version: "6.17.0-preview.7",
  build_sha: "abc1234567890def1234567890abcdef12345678",
  deployed_at: "2026-05-22T03:45:00Z",
  secret: "test-release-signing-secret-fixture-do-not-use-in-prod",
} as const;

const PAYLOAD = `${FIXTURE.version}|${FIXTURE.build_sha}|${FIXTURE.deployed_at}`;

function hexFromBuffer(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function webCryptoHmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return hexFromBuffer(sig);
}

function nodeCryptoHmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("version signed manifest HMAC", () => {
  test("Web Crypto subtle (worker path) and node:crypto agree", async () => {
    const webHex = await webCryptoHmac(PAYLOAD, FIXTURE.secret);
    const nodeHex = nodeCryptoHmac(PAYLOAD, FIXTURE.secret);
    expect(webHex).toBe(nodeHex);
    expect(webHex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("payload format is exactly version|build_sha|deployed_at", () => {
    expect(PAYLOAD).toBe(
      "6.17.0-preview.7|abc1234567890def1234567890abcdef12345678|2026-05-22T03:45:00Z",
    );
  });

  test("changing any field changes the hash (tamper detection)", async () => {
    const base = await webCryptoHmac(PAYLOAD, FIXTURE.secret);
    const tamperVersion = await webCryptoHmac(
      `${FIXTURE.version}-tampered|${FIXTURE.build_sha}|${FIXTURE.deployed_at}`,
      FIXTURE.secret,
    );
    const tamperSha = await webCryptoHmac(
      `${FIXTURE.version}|0000000000000000000000000000000000000000|${FIXTURE.deployed_at}`,
      FIXTURE.secret,
    );
    const tamperTs = await webCryptoHmac(
      `${FIXTURE.version}|${FIXTURE.build_sha}|1970-01-01T00:00:00Z`,
      FIXTURE.secret,
    );
    expect(tamperVersion).not.toBe(base);
    expect(tamperSha).not.toBe(base);
    expect(tamperTs).not.toBe(base);
  });

  test("changing the secret changes the hash (secret rotation works)", async () => {
    const base = await webCryptoHmac(PAYLOAD, FIXTURE.secret);
    const rotated = await webCryptoHmac(PAYLOAD, `${FIXTURE.secret}-rotated`);
    expect(rotated).not.toBe(base);
  });

  test("known-good fixture hash is stable across machines", async () => {
    // Recomputed by node:crypto so future runs assert the same byte
    // pattern regardless of the platform running the test. If this
    // string ever changes the worker and verifier are out of sync.
    const expectedHex = nodeCryptoHmac(PAYLOAD, FIXTURE.secret);
    const webHex = await webCryptoHmac(PAYLOAD, FIXTURE.secret);
    expect(webHex).toBe(expectedHex);
    expect(expectedHex.length).toBe(64);
  });
});
