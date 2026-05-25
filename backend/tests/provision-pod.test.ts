/**
 * Provision-pod route — scaffold tests. Exercises the shape (body
 * validation, signature gate, scaffold-only-503 path) without making
 * any live Runpod API call. Live integration tests gate on Lewis
 * approving the cost ceiling + provisioning RUNPOD_API_KEY.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { provisionPodRoutes } from "../src/routes/provision-pod";
import {
  canonicalizeDeclareBody,
  type CanonicalDeclareBody,
} from "../src/services/declare-signature";

function mountApp() {
  const app = new Hono();
  app.route("/v1", provisionPodRoutes);
  return app;
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

function bytesToHex(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  return Array.from(u8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function genKeypair(): Promise<{ pubHex: string; privKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { pubHex: bytesToHex(pubRaw), privKey: kp.privateKey };
}

async function signCanonical(body: CanonicalDeclareBody, privKey: CryptoKey): Promise<string> {
  const canon = canonicalizeDeclareBody(body);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privKey, new TextEncoder().encode(canon));
  return bytesToHex(sig);
}

describe("/v1/contract/provision-pod — scaffold", () => {
  test("requires contract_id", async () => {
    const app = mountApp();
    const { status, json } = await postJson(app, "/v1/contract/provision-pod", {});
    expect(status).toBe(400);
    expect((json as { message: string }).message).toContain("contract_id");
  });

  test("requires caller_pubkey + caller_signature + ts", async () => {
    const app = mountApp();
    const { status, json } = await postJson(app, "/v1/contract/provision-pod", {
      contract_id: "abc12345",
    });
    expect(status).toBe(400);
    expect((json as { message: string }).message).toContain("caller_pubkey");
  });

  test("rejects invalid signature 401", async () => {
    const app = mountApp();
    const { pubHex } = await genKeypair();
    const { status, json } = await postJson(app, "/v1/contract/provision-pod", {
      contract_id: "abc12345",
      caller_pubkey: pubHex,
      caller_signature: "00".repeat(64),
      ts: "2026-05-25T20:00:00Z",
    });
    expect(status).toBe(401);
    expect((json as { message: string }).message).toContain("invalid");
  });

  test("valid signature → scaffold-only 503 with explicit gating message", async () => {
    const app = mountApp();
    const { pubHex, privKey } = await genKeypair();
    const ts = "2026-05-25T20:00:00Z";
    const body: CanonicalDeclareBody = {
      plan: `provision-pod for abc12345`,
      action: "provision-pod",
      parent_id: null,
      agent: null,
      wallet_identity: pubHex,
      ts,
    };
    const sig = await signCanonical(body, privKey);
    const { status, json } = await postJson(app, "/v1/contract/provision-pod", {
      contract_id: "abc12345",
      caller_pubkey: pubHex,
      caller_signature: sig,
      ts,
    });
    // Scaffold-only path returns 503 + clear message naming the gating
    // condition (Lewis approval of RUNPOD_API_KEY + spend ceiling).
    expect(status).toBe(503);
    const j = json as { status: string; message: string };
    expect(j.status).toBe("scaffold-only");
    expect(j.message).toMatch(/RUNPOD_API_KEY|scaffold-only|Lewis/);
  });
});
