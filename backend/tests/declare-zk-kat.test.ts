/**
 * KNOWN-ANSWER GATE for the zero-knowledge credential-binding NIZK port.
 *
 * Proves the TS port (`backend/src/services/declare-zk.ts`) AGREES with the
 * PROVEN Python reference (`paper/reference/zk/binding.py`) — byte-for-byte,
 * BOTH directions:
 *
 *   - TS prove  ↔ Python verify   (TS-produced {y,sig,t,s,ctx} → py verify_binding true)
 *   - Python prove ↔ TS verify    (py-produced binding+proof → TS verifyBinding true)
 *
 * The SAME ed25519 private key signs in both languages (raw 32-byte seed shipped
 * via the JWK `d` field), so the wallet-sig leg crosses too. The scalar leg
 * (credential_scalar + y = g^x) is checked directly against Python to catch any
 * modpow / hash / byte-layout drift.
 *
 * If TS and Python DISAGREE, this gate fails — we do NOT wire a divergent zk.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  bind,
  credentialScalar,
  prove,
  verifyBinding,
  type ZkBinding,
  type ZkProof,
} from "../src/services/declare-zk";

const KAT = join(import.meta.dir, "fixtures", "zk_kat.py");

function py(cmd: string, args: unknown): unknown {
  const res = spawnSync("python3", [KAT, cmd], {
    input: JSON.stringify(args),
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`python3 ${cmd} failed (status ${res.status}): ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generate an ed25519 keypair; return the raw 32-byte seed (for Python) and a
 *  TS signer over arbitrary bytes that returns the signature hex. */
async function genWallet(): Promise<{
  rootHex: string;
  privSeedHex: string;
  signY: (yBytes: Uint8Array) => Promise<string>;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  // raw ed25519 seed lives in jwk.d (base64url, 32 bytes)
  const seed = b64urlToBytes(jwk.d as string);
  return {
    rootHex: bytesToHex(pubRaw),
    privSeedHex: bytesToHex(seed),
    signY: async (yBytes: Uint8Array) => {
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, yBytes);
      return bytesToHex(new Uint8Array(sig));
    },
  };
}

const CRED = new TextEncoder().encode("secret-cookie-value-123");
const CRED_HEX = bytesToHex(CRED);
const CTX = new TextEncoder().encode("declare-canonical-body-bytes");
const CTX_HEX = bytesToHex(CTX);

describe("declare-zk KAT — TS port AGREES with the Python reference", () => {
  test("scalar leg: credential_scalar + y=g^x match Python exactly", async () => {
    const x = await credentialScalar(CRED);
    const y = (
      await bind(CRED, {
        rootHex: "00".repeat(32),
        signY: async () => "00".repeat(64),
      })
    ).y;
    const ref = py("scalar", { credential_hex: CRED_HEX }) as { x: string; y: string };
    expect(x.toString()).toBe(ref.x); // decimal scalar identical
    expect(y).toBe(ref.y); // y hex identical (proves modpow port)
  });

  test("TS prove ↔ Python verify (TS-produced proof verifies under the reference)", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    // Hand the TS-produced binding+proof to the Python reference verifier.
    const res = py("py-verify", { binding, proof }) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  test("Python prove ↔ TS verify (reference-produced proof verifies under the TS port)", async () => {
    const wallet = await genWallet();
    // Python binds + proves with the SAME ed25519 seed → TS verifies.
    const out = py("py-prove", {
      credential_hex: CRED_HEX,
      priv_hex: wallet.privSeedHex,
      ctx_hex: CTX_HEX,
    }) as { binding: ZkBinding; proof: ZkProof };
    expect(await verifyBinding(out.binding, out.proof)).toBe(true);
    // sanity: the root Python derived from the seed equals the TS-exported pubkey
    expect(out.binding.root).toBe(wallet.rootHex);
  });

  test("deterministic vector: fixed k → TS prove == Python prove byte-for-byte", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const k = 1234567890123456789012345678901234567890n;
    const tsProof = await prove(CRED, binding, CTX, k);
    const ref = py("py-prove", {
      credential_hex: CRED_HEX,
      priv_hex: wallet.privSeedHex,
      ctx_hex: CTX_HEX,
      k: k.toString(),
    }) as { binding: ZkBinding; proof: ZkProof };
    // t and s are pure functions of (credential, y, t, ctx, k) — must be identical.
    expect(tsProof.t).toBe(ref.proof.t);
    expect(tsProof.s).toBe(ref.proof.s);
    expect(tsProof.ctx).toBe(ref.proof.ctx);
    // And the reference binding y matches the TS binding y.
    expect(binding.y).toBe(ref.binding.y);
  });

  test("cross-tamper: TS verify rejects a Python proof whose ctx was changed", async () => {
    const wallet = await genWallet();
    const out = py("py-prove", {
      credential_hex: CRED_HEX,
      priv_hex: wallet.privSeedHex,
      ctx_hex: CTX_HEX,
    }) as { binding: ZkBinding; proof: ZkProof };
    const tampered: ZkProof = { ...out.proof, ctx: bytesToHex(new TextEncoder().encode("different-ctx")) };
    expect(await verifyBinding(out.binding, tampered)).toBe(false);
  });
});
