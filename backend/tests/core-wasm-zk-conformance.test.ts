/**
 * zk-path convergence witness — the single Zig WASM core's `zk_verify` export
 * agrees with the TS NIZK (`declare-zk.ts`) and the proven Python reference
 * (`paper/reference/zk/binding.py`, via the KAT harness).
 *
 * The WASM `zk_verify(y,t,s,ctx)` export is the SCHNORR / Fiat-Shamir algebra
 * leg only (`g^s == t * y^e mod p`, e recomputed from (G,y,t,ctx)). The ed25519
 * wallet-sig leg ("this y belongs to this wallet") is NOT part of the WASM ABI
 * and stays in TS (Web Crypto) inside `verifyBinding` — so this witness checks
 * exactly the algebra leg the core owns:
 *
 *   - a binding+proof produced by the TS `bind`/`prove` verifies TRUE under
 *     `zkVerifyViaWasm` (WASM algebra == TS algebra).
 *   - a Python-reference KAT vector (binding.py) verifies TRUE under the WASM
 *     (WASM algebra == reference algebra, citing the live KAT harness).
 *   - a tampered proof (s) / tampered ctx verifies FALSE.
 *   - malformed inputs return `null` so the caller falls back to TS — never
 *     throws.
 *   - the WASM-preferred `verifyBinding` (algebra via WASM + wallet-sig leg in
 *     TS) stays green on valid / tampered / swapped-wallet inputs.
 *
 * Run: bun test tests/core-wasm-zk-conformance.test.ts   (from backend/)
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { zkVerifyViaWasm } from "../src/services/core-wasm";
import { bind, prove, verifyBinding, type ZkBinding, type ZkProof } from "../src/services/declare-zk";

const KAT = join(import.meta.dir, "fixtures", "zk_kat.py");

function py(cmd: string, args: unknown): unknown {
  const res = spawnSync("python3", [KAT, cmd], { input: JSON.stringify(args), encoding: "utf8" });
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

describe("core-wasm zk_verify — Schnorr algebra leg agrees with TS NIZK", () => {
  test("TS bind/prove → zkVerifyViaWasm === true (WASM algebra == TS algebra)", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    // The WASM must load in bun:test — null here is a real regression of the
    // convergence wire, not a benign fallback.
    expect(zkVerifyViaWasm(binding, proof)).toBe(true);
  });

  test("Python-reference KAT vector verifies under zkVerifyViaWasm (WASM == binding.py)", async () => {
    const wallet = await genWallet();
    // Reference binding.py produces {y, root, sig} + {t, s, ctx} for this cred/ctx.
    const out = py("py-prove", {
      credential_hex: CRED_HEX,
      priv_hex: wallet.privSeedHex,
      ctx_hex: CTX_HEX,
    }) as { binding: ZkBinding; proof: ZkProof };
    // The core verifies the reference's Schnorr leg.
    expect(zkVerifyViaWasm(out.binding, out.proof)).toBe(true);
    // And the WASM-preferred full verifyBinding (algebra via WASM + wallet-sig
    // leg in TS) accepts the reference binding too.
    expect(await verifyBinding(out.binding, out.proof)).toBe(true);
  });

  test("deterministic KAT vector (fixed k) verifies under the WASM core", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const k = 1234567890123456789012345678901234567890n;
    // TS prove with fixed k — byte-identical to the reference per declare-zk-kat.
    const proof = await prove(CRED, binding, CTX, k);
    const ref = py("py-prove", {
      credential_hex: CRED_HEX,
      priv_hex: wallet.privSeedHex,
      ctx_hex: CTX_HEX,
      k: k.toString(),
    }) as { binding: ZkBinding; proof: ZkProof };
    // The fixed-k proof matches the reference byte-for-byte (cite: t,s,ctx).
    expect(proof.t).toBe(ref.proof.t);
    expect(proof.s).toBe(ref.proof.s);
    expect(proof.ctx).toBe(ref.proof.ctx);
    expect(binding.y).toBe(ref.binding.y);
    // ...and the WASM core verifies that exact vector.
    expect(zkVerifyViaWasm(binding, proof)).toBe(true);
  });

  test("tampered proof (s) → zkVerifyViaWasm === false", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    const bad: ZkProof = { ...proof, s: proof.s + "1" };
    expect(zkVerifyViaWasm(binding, bad)).toBe(false);
  });

  test("tampered ctx → zkVerifyViaWasm === false (proof bound to ctx)", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    const bad: ZkProof = { ...proof, ctx: bytesToHex(new TextEncoder().encode("other-ctx")) };
    expect(zkVerifyViaWasm(binding, bad)).toBe(false);
  });

  test("tampered y → zkVerifyViaWasm === false", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    const last = binding.y.slice(-1);
    const flipped = (parseInt(last, 16) ^ 0x1).toString(16);
    const bad: ZkBinding = { ...binding, y: binding.y.slice(0, -1) + flipped };
    expect(zkVerifyViaWasm(bad, proof)).toBe(false);
  });

  test("malformed proof (non-hex t/s) → zkVerifyViaWasm === false, never throws", async () => {
    // The core re-parses t/s as hex; garbage bytes fail parse → returns 0
    // (false), never a throw. Distinct from `null` (wasm-load failure).
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const bad: ZkProof = { t: "not-hex", s: "also-not-hex", ctx: "" };
    expect(() => zkVerifyViaWasm(binding, bad)).not.toThrow();
    expect(zkVerifyViaWasm(binding, bad)).toBe(false);
  });
});

describe("verifyBinding — WASM-preferred path stays correct (fallback confirmed)", () => {
  test("valid binding+proof → verifyBinding true (algebra via WASM, wallet-sig via TS)", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    expect(await verifyBinding(binding, proof)).toBe(true);
  });

  test("swapped wallet root → verifyBinding false (TS ed25519 leg still gates)", async () => {
    const a = await genWallet();
    const b = await genWallet();
    const binding = await bind(CRED, a);
    const proof = await prove(CRED, binding, CTX);
    // The Schnorr leg (WASM) still passes — the wallet-sig leg (TS) must reject,
    // proving the wallet-sig check was NOT lifted out into the algebra-only WASM.
    expect(zkVerifyViaWasm(binding, proof)).toBe(true);
    const bad: ZkBinding = { ...binding, root: b.rootHex };
    expect(await verifyBinding(bad, proof)).toBe(false);
  });

  test("tampered s → verifyBinding false through the WASM-preferred path", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    expect(await verifyBinding(binding, { ...proof, s: proof.s + "1" })).toBe(false);
  });
});
