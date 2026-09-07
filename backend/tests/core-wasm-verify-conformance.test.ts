/**
 * Verify-path convergence witness — the single Zig WASM core's `verify` export
 * accepts the SAME ed25519 signatures the existing Web Crypto path produces.
 *
 * The whole point of the Zig-core convergence: a declare signed by the EXISTING
 * Web Crypto signer must verify TRUE under the WASM core, and any tamper (wrong
 * pubkey, mutated body, flipped signature) must verify FALSE. Ed25519 is
 * RFC-8032, so canonicalize -> sign -> verify now runs through one core with
 * identical bytes — nothing re-verifies differently.
 *
 * Run: bun test tests/core-wasm-verify-conformance.test.ts   (from backend/)
 */
import { describe, expect, test } from "bun:test";
import { verifyViaWasm } from "../src/services/core-wasm";
import {
  canonicalizeDeclareBody,
  type CanonicalDeclareBody,
} from "../src/services/declare-signature";

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function genKeypair(): Promise<{ pubHex: string; privKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: bytesToHex(pubRaw), privKey: kp.privateKey };
}

/** Sign the canonical projection with the EXISTING Web Crypto path. */
async function signCanonical(body: CanonicalDeclareBody, privKey: CryptoKey): Promise<string> {
  const canon = canonicalizeDeclareBody(body);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privKey, new TextEncoder().encode(canon));
  return bytesToHex(sig);
}

describe("Web-Crypto-signed declares verify under the WASM core `verify`", () => {
  test("valid Web-Crypto signature -> verifyViaWasm === true", async () => {
    const { pubHex, privKey } = await genKeypair();
    const body: CanonicalDeclareBody = {
      plan: "real signed write",
      action: "neuron",
      parent_id: null,
      agent: "alice",
      wallet_identity: pubHex,
      ts: "2026-06-20T20:00:00Z",
    };
    const sigHex = await signCanonical(body, privKey);
    const canonical = canonicalizeDeclareBody(body);

    // The WASM must load in bun:test — null here is a real regression of the
    // convergence wire, not a benign fallback.
    expect(verifyViaWasm(canonical, sigHex, pubHex)).toBe(true);
  });

  test("tampered body (mutated ts) -> verifyViaWasm === false", async () => {
    const { pubHex, privKey } = await genKeypair();
    const body: CanonicalDeclareBody = {
      plan: "original plan",
      action: "neuron",
      parent_id: null,
      agent: "alice",
      wallet_identity: pubHex,
      ts: "2026-06-20T20:00:00Z",
    };
    const sigHex = await signCanonical(body, privKey);
    // Verify against a DIFFERENT canonical message than was signed.
    const tamperedCanonical = canonicalizeDeclareBody({ ...body, ts: "changed" });
    expect(verifyViaWasm(tamperedCanonical, sigHex, pubHex)).toBe(false);
  });

  test("wrong pubkey (signed by alice, claims bob) -> verifyViaWasm === false", async () => {
    const { privKey: aliceKey } = await genKeypair();
    const { pubHex: bobPub } = await genKeypair();
    const body: CanonicalDeclareBody = {
      plan: "plan",
      action: "neuron",
      parent_id: null,
      agent: "alice",
      wallet_identity: bobPub, // body carries bob's key, alice signs it
      ts: "2026-06-20T20:00:00Z",
    };
    const sigHex = await signCanonical(body, aliceKey);
    const canonical = canonicalizeDeclareBody(body);
    expect(verifyViaWasm(canonical, sigHex, bobPub)).toBe(false);
  });

  test("flipped-bit signature -> verifyViaWasm === false", async () => {
    const { pubHex, privKey } = await genKeypair();
    const body: CanonicalDeclareBody = {
      plan: "p",
      action: "neuron",
      parent_id: null,
      agent: "a",
      wallet_identity: pubHex,
      ts: "t",
    };
    const sigHex = await signCanonical(body, privKey);
    const canonical = canonicalizeDeclareBody(body);
    // Flip the last hex nibble of the signature.
    const last = sigHex.slice(-1);
    const flipped = sigHex.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(verifyViaWasm(canonical, flipped, pubHex)).toBe(false);
  });

  test("malformed inputs -> null (caller falls back), never throws", () => {
    // Bad hex / wrong lengths -> null, so verifyDeclareSignature uses Web Crypto.
    expect(verifyViaWasm("msg", "not-hex", "deadbeef")).toBeNull();
    expect(verifyViaWasm("msg", "deadbeef", "deadbeef")).toBeNull(); // sig not 64B
    expect(verifyViaWasm("msg", "00".repeat(64), "ff".repeat(31))).toBeNull(); // pk not 32B
  });
});
