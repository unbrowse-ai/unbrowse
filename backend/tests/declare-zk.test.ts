/**
 * TS-only round-trip + tamper witnesses for the zk credential-binding NIZK
 * (`backend/src/services/declare-zk.ts`). No Python dependency — these run in
 * the standard backend test suite. Cross-language agreement is the separate KAT
 * gate (`declare-zk-kat.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { contractRoutes } from "../src/routes/contract";
import { canonicalizeDeclareBody, type CanonicalDeclareBody } from "../src/services/declare-signature";
import { bind, prove, verifyBinding, type ZkBinding } from "../src/services/declare-zk";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function genWallet(): Promise<{
  rootHex: string;
  signY: (yBytes: Uint8Array) => Promise<string>;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    rootHex: bytesToHex(pubRaw),
    signY: async (yBytes: Uint8Array) => {
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, yBytes);
      return bytesToHex(new Uint8Array(sig));
    },
  };
}

const CRED = new TextEncoder().encode("super-secret-api-token");
const CTX = new TextEncoder().encode("ctx-the-declare-body");

describe("declare-zk — round-trip + tamper", () => {
  test("valid prove → verifyBinding true", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    expect(await verifyBinding(binding, proof)).toBe(true);
  });

  test("tampered y → verifyBinding false", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    // flip a hex nibble of y
    const last = binding.y.slice(-1);
    const flipped = (parseInt(last, 16) ^ 0x1).toString(16);
    const bad: ZkBinding = { ...binding, y: binding.y.slice(0, -1) + flipped };
    expect(await verifyBinding(bad, proof)).toBe(false);
  });

  test("tampered proof (s) → verifyBinding false", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    const bad = { ...proof, s: proof.s + "1" };
    expect(await verifyBinding(binding, bad)).toBe(false);
  });

  test("tampered ctx → verifyBinding false (proof bound to ctx)", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, CTX);
    const bad = { ...proof, ctx: bytesToHex(new TextEncoder().encode("other-ctx")) };
    expect(await verifyBinding(binding, bad)).toBe(false);
  });

  test("swapped wallet (y signed by a different wallet) → verifyBinding false", async () => {
    const a = await genWallet();
    const b = await genWallet();
    const binding = await bind(CRED, a);
    const proof = await prove(CRED, binding, CTX);
    // claim wallet B's root over A's signature → ed25519 leg fails
    const bad: ZkBinding = { ...binding, root: b.rootHex };
    expect(await verifyBinding(bad, proof)).toBe(false);
  });

  test("wrong credential cannot open the binding (prove throws)", async () => {
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    const wrong = new TextEncoder().encode("not-the-credential");
    await expect(prove(wrong, binding, CTX)).rejects.toThrow("does not open this binding");
  });
});

describe("/v1/contract/declare — optional zk_binding gate (additive)", () => {
  function mountApp() {
    const app = new Hono();
    app.route("/v1", contractRoutes);
    return app;
  }
  async function postJson(app: Hono, body: unknown) {
    const res = await app.fetch(
      new Request("http://test.local/v1/contract/declare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: await res.json() };
  }
  function ctxBytes(plan: string, action: string): Uint8Array {
    const canon: CanonicalDeclareBody = {
      plan,
      action,
      parent_id: null,
      agent: "anonymous", // anon path: server coerces agent="anonymous"
      wallet_identity: "",
      ts: "2026-06-20T00:00:00Z",
    };
    return new TextEncoder().encode(canonicalizeDeclareBody(canon));
  }

  test("declare with a VALID zk_binding → 200 accepted", async () => {
    const app = mountApp();
    const wallet = await genWallet();
    const plan = "zk-bound-write";
    const action = "neuron";
    const ctx = ctxBytes(plan, action);
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, ctx);
    const { status } = await postJson(app, {
      plan,
      action,
      ts: "2026-06-20T00:00:00Z",
      zk_binding: { y: binding.y, sig: binding.sig, root: binding.root, proof },
    });
    expect(status).toBe(200);
  });

  test("declare with an INVALID zk_binding (tampered s) → 400 invalid_zk_binding", async () => {
    const app = mountApp();
    const wallet = await genWallet();
    const plan = "zk-bad-write";
    const action = "neuron";
    const ctx = ctxBytes(plan, action);
    const binding = await bind(CRED, wallet);
    const proof = await prove(CRED, binding, ctx);
    const { status, json } = await postJson(app, {
      plan,
      action,
      ts: "2026-06-20T00:00:00Z",
      zk_binding: { y: binding.y, sig: binding.sig, root: binding.root, proof: { ...proof, s: proof.s + "1" } },
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_zk_binding");
  });

  test("declare with zk_binding whose ctx ≠ canonical body → 400 invalid_zk_binding", async () => {
    const app = mountApp();
    const wallet = await genWallet();
    const binding = await bind(CRED, wallet);
    // prove over the WRONG ctx
    const proof = await prove(CRED, binding, new TextEncoder().encode("unrelated-ctx"));
    const { status, json } = await postJson(app, {
      plan: "zk-wrong-ctx",
      action: "neuron",
      ts: "2026-06-20T00:00:00Z",
      zk_binding: { y: binding.y, sig: binding.sig, root: binding.root, proof },
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_zk_binding");
    expect((json as { detail: string }).detail).toContain("ctx");
  });

  test("declare WITHOUT zk_binding → unchanged (backward-compat, 200 anonymous)", async () => {
    const app = mountApp();
    const { status, json } = await postJson(app, {
      plan: "no-zk-write",
      action: "neuron",
      agent: "claim-someone",
    });
    expect(status).toBe(200);
    const row = (json as { row: { agent: string; visibility: string } }).row;
    expect(row.agent).toBe("anonymous");
    expect(row.visibility).toBe("public");
  });
});
