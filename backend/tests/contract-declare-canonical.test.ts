/**
 * Wave-2b: canonical KV-backed `/v1/contract/declare` + attestation gate.
 *
 * Per CLAUDE.md "Never mock in tests": runs the real Hono router via
 * `app.fetch(req, env)` with `ENVIRONMENT="local-dev"`, which makes
 * `statsKV(env)` return a `LocalKV` instance backed by an in-process
 * `Map`. Same code path the prod Worker hits — only the backing store
 * differs.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { contractRoutes, type DeclareResponse, type StatusResponse } from "../src/routes/contract.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import { LEWIS_DEPLOYER_PUBKEY_v1 } from "../src/lib/attestation.js";

function mountApp() {
  const app = new Hono();
  app.route("/v1", contractRoutes);
  return app;
}

const ENV = { ENVIRONMENT: "local-dev" } as const;

async function postJson(
  app: ReturnType<typeof mountApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ENV,
  );
  return { status: res.status, json: await res.json() };
}

async function getJson(
  app: ReturnType<typeof mountApp>,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const res = await app.fetch(new Request(`http://test.local${path}`), ENV);
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  // Reset the LocalKV store so each test starts from zero rows.
  clearKVCacheForTests("stats");
});

describe("/v1/contract/declare — canonical KV-backed substrate-server", () => {
  test("anonymous declare persists to KV and is readable via /status", async () => {
    const app = mountApp();
    const declare = await postJson(app, "/v1/contract/declare", {
      plan: "wave-2b canonical persistence probe",
      action: "agent-judges",
    });
    expect(declare.status).toBe(200);
    const body = declare.json as DeclareResponse;
    expect(body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.row.event).toBe("declared");
    expect(body.row.plan).toBe("wave-2b canonical persistence probe");

    // Wave-2b envelope shape: doctrine chains are honest empty arrays.
    expect(body.bible_chain).toEqual([]);
    expect(body.doctrine_chain).toEqual([]);
    expect(body.memory_chain).toEqual([]);
    expect(Array.isArray(body.child_rows)).toBe(true);

    // Read back via canonical /status — same KV-backed ledger.
    const status = await getJson(app, `/v1/contract/status?id=${body.id}`);
    expect(status.status).toBe(200);
    const sbody = status.json as StatusResponse;
    expect(sbody.id).toBe(body.id);
    expect(sbody.rows.length).toBeGreaterThan(0);
    expect(sbody.rows[0]?.plan).toBe("wave-2b canonical persistence probe");
  });

  test("anonymous declare surfaces legacy-anonymous admission evidence", async () => {
    const app = mountApp();
    const { json } = await postJson(app, "/v1/contract/declare", {
      plan: "legacy-window probe",
      action: "agent-judges",
    });
    const body = json as DeclareResponse;
    expect(body.admission_evidence).toContain("legacy-anonymous");
    expect(body.admission_evidence).toContain("window-ends=");
    expect(body.row.admission).toBe("legacy-anonymous");
  });

  test("declare with INVALID x-aiko-spawn-signature returns 401", async () => {
    const app = mountApp();
    // Manufacture a malformed lineage chain — root pubkey doesn't match
    // the hardcoded LEWIS_DEPLOYER_PUBKEY_v1 sentinel.
    const fakeLineage = JSON.stringify([
      {
        contract_id: "deadbeef",
        env_pubkey: "11".repeat(32),
        parent_id: null,
        parent_signature: "00".repeat(64),
      },
    ]);
    const { status, json } = await postJson(
      app,
      "/v1/contract/declare",
      {
        plan: "attestation-failure probe",
        action: "agent-judges",
      },
      {
        "x-aiko-lineage-chain": fakeLineage,
        "x-aiko-spawn-signature": "00".repeat(64),
      },
    );
    expect(status).toBe(401);
    const body = json as { error: string; detail: string };
    expect(body.error).toBe("attestation_failed");
    expect(body.detail).toBeString();
  });

  test("declare without attestation headers still succeeds (legacy window)", async () => {
    const app = mountApp();
    const { status, json } = await postJson(app, "/v1/contract/declare", {
      plan: "no-attestation probe",
      action: "agent-judges",
    });
    expect(status).toBe(200);
    const body = json as DeclareResponse;
    expect(body.admission_evidence).toContain("legacy-anonymous");
  });

  test("declare without UNBROWSE_LLM_API_KEY surfaces compile_evidence=skipped", async () => {
    // Env has no UNBROWSE_LLM_API_KEY → compile path should be skipped
    // and the evidence string surfaces the honest gap.
    const app = mountApp();
    const { json } = await postJson(app, "/v1/contract/declare", {
      plan: "no-llm-key probe",
      action: "agent-judges",
    });
    const body = json as DeclareResponse;
    expect(body.compile_evidence).toBe("compile_skipped_no_api_key");
    expect(body.child_rows).toEqual([]);
  });

  test("iterate after declare reads the persisted parent row from KV", async () => {
    const app = mountApp();
    const dec = await postJson(app, "/v1/contract/declare", {
      plan: "iterate-after-declare probe",
      action: "agent-judges",
    });
    expect(dec.status).toBe(200);
    const dbody = dec.json as DeclareResponse;
    const iter = await postJson(app, "/v1/contract/iterate", { id: dbody.id });
    expect(iter.status).toBe(200);
    const ibody = iter.json as { id: string; wave: number; action_result: string };
    expect(ibody.id).toBe(dbody.id);
    expect(ibody.wave).toBe(1);
    expect(ibody.action_result).toBeString();
  });

  test("iterate on unknown id still returns 400 contract-not-declared", async () => {
    const app = mountApp();
    const { status, json } = await postJson(app, "/v1/contract/iterate", { id: "00000000" });
    expect(status).toBe(400);
    const body = json as { error: string };
    expect(body.error).toContain("not declared");
  });

  test("declared row is back-indexed under wallet:anonymous for anonymous declares", async () => {
    // Anonymous declares coerce agent="anonymous"; the wallet back-index
    // then keys off that. Confirms the kvLedger.append back-index path
    // fires for at least one row per declare.
    const { LocalKV } = await import("../src/services/kv.js");
    const app = mountApp();
    const { status, json } = await postJson(app, "/v1/contract/declare", {
      plan: "back-index probe",
      action: "agent-judges",
    });
    expect(status).toBe(200);
    const body = json as DeclareResponse;

    const kv = new LocalKV("stats");
    const entries = await kv.listWithValues("wallet:anonymous:");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.value === body.id)).toBe(true);
  });
});

describe("attestation primitive — direct verification", () => {
  test("verifySpawnAttestation rejects empty lineage chain", async () => {
    const { verifySpawnAttestation } = await import("../src/lib/attestation.js");
    const result = await verifySpawnAttestation({
      lineageChainHeader: "[]",
      signatureHeader: "00".repeat(64),
      nonceHeader: null,
      bodyBytes: new TextEncoder().encode("{}"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lineage_chain_empty");
  });

  test("verifySpawnAttestation rejects when root pubkey doesn't match deployer", async () => {
    const { verifySpawnAttestation } = await import("../src/lib/attestation.js");
    const lineage = JSON.stringify([
      {
        contract_id: "00000000",
        env_pubkey: "aa".repeat(32), // not the deployer pubkey
        parent_id: null,
        parent_signature: "00".repeat(64),
      },
    ]);
    const result = await verifySpawnAttestation({
      lineageChainHeader: lineage,
      signatureHeader: "00".repeat(64),
      nonceHeader: null,
      bodyBytes: new TextEncoder().encode("{}"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("root_mismatch");
  });

  test("verifySpawnAttestation accepts a real ed25519 chain rooted at expectedRootPubkey", async () => {
    // Build a real one-link chain (root only). The leaf IS the root.
    // We need a real ed25519 keypair so the leaf's signature over the
    // body actually verifies.
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const pubRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const pubHex = Array.from(new Uint8Array(pubRaw))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const bodyBytes = new TextEncoder().encode('{"plan":"real-attestation","action":"agent-judges"}');
    // No nonce → leaf signs the body directly.
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, bodyBytes);
    const sigHex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const lineage = JSON.stringify([
      {
        contract_id: "deadbeef",
        env_pubkey: pubHex,
        parent_id: null,
        parent_signature: "00".repeat(64),
      },
    ]);

    const { verifySpawnAttestation } = await import("../src/lib/attestation.js");
    const result = await verifySpawnAttestation({
      lineageChainHeader: lineage,
      signatureHeader: sigHex,
      nonceHeader: null,
      bodyBytes,
      expectedRootPubkey: pubHex, // override the sentinel with the test pubkey
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.leafPubkey).toBe(pubHex.toLowerCase());
      expect(result.rootPubkey).toBe(pubHex.toLowerCase());
    }
  });

  test("LEWIS_DEPLOYER_PUBKEY_v1 sentinel is the zero pubkey until wave-2c", () => {
    // Documents the sentinel state — when Lewis pastes the real hex
    // in the cutover commit, this test will fail and is updated then.
    expect(LEWIS_DEPLOYER_PUBKEY_v1).toBe("0".repeat(64));
  });
});
