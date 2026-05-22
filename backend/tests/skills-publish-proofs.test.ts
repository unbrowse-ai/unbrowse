import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, SkillManifest, ZkProof } from "../src/types.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {
    put: async () => {},
    get: async () => null,
  } as unknown as KVNamespace,
  ENVIRONMENT: "staging",
  REQUIRE_DOMAIN_VERIFICATION: "0",
  RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
};

function makeProof(commitmentDomain: string, hashOverride?: string, generatedAtOverride?: string): ZkProof {
  const captured = "2026-05-02T12:00:00Z";
  return {
    proof_type: "commitment_only",
    proof_data: Buffer.from(JSON.stringify({ note: "fixture" })).toString("base64"),
    commitment: {
      response_body_hash: hashOverride ?? "sha256:" + "a".repeat(64),
      domain: commitmentDomain,
      url_template: `https://${commitmentDomain}/api/search`,
      method: "GET",
      response_status: 200,
      captured_at: captured,
    },
    notary_id: "local",
    generated_at: generatedAtOverride ?? captured,
    verified: false,
  };
}

function publishPayload(
  domain: string,
  zk_proof?: ZkProof,
  endpointOverrides?: Partial<SkillManifest["endpoints"][number]>,
) {
  return {
    skill_id: `skill-${domain}`,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: domain,
    domain,
    description: "fixture",
    owner_type: "marketplace",
    execution_type: "http",
    lifecycle: "active",
    created_at: "2026-04-04T00:00:00.000Z",
    updated_at: "2026-04-04T00:00:00.000Z",
    endpoints: [{
      endpoint_id: "ep-1",
      method: "GET",
      url_template: `https://${domain}/api/search`,
      description: "fixture endpoint",
      idempotency: "safe",
      verification_status: "unverified",
      reliability_score: 0.55,
      ...(zk_proof ? { zk_proof } : {}),
      ...endpointOverrides,
    }],
  };
}

function signedReleaseHeaders() {
  const traceVersion = "trace-zk";
  const codeHash = "code-zk";
  const gitSha = "git-zk";
  const releaseVersion = "2.11.0";
  const manifest = JSON.stringify({
    schema_version: 1,
    release_version: releaseVersion,
    git_sha: gitSha,
    code_hash: codeHash,
    trace_version: traceVersion,
    issued_at: "2026-04-04T00:00:00.000Z",
  });
  const signature = createHmac("sha256", env.RELEASE_MANIFEST_SIGNING_SECRET!)
    .update(manifest)
    .digest("base64url");
  return {
    "X-Unbrowse-Trace-Version": traceVersion,
    "X-Unbrowse-Code-Hash": codeHash,
    "X-Unbrowse-Git-Sha": gitSha,
    "X-Unbrowse-Release-Manifest": Buffer.from(manifest, "utf8").toString("base64url"),
    "X-Unbrowse-Release-Signature": signature,
  };
}

describe("skills publish — zk proof round-trip", () => {
  const originalFetch = globalThis.fetch;
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname !== "api.emergentdb.com") {
        throw new Error(`Unexpected fetch: ${url.toString()}`);
      }
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        store.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = store.get(key);
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/graph/batch_insert" || url.pathname === "/graph/delete") {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/graph/edges" || url.pathname === "/graph/search") {
        return Response.json({ ok: true, results: [] });
      }
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps domain-matching commitment_only proof unverified and persists to KV", async () => {
    const domain = "proof-ok.example.com";
    const proof = makeProof(domain);
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(domain, proof)),
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as SkillManifest;
    const ep = body.endpoints[0];
    expect(ep.zk_proof).toBeDefined();
    expect(ep.zk_proof?.verified).toBe(false);
    expect(ep.zk_proof?.verified_at).toBeDefined();
    expect(ep.zk_proof?.verification_failure).toContain("not independently verified");

    // Confirm the proof actually persisted to KV (not just on the response object).
    // Real key shape: "<env>-skills-v3:skill:<skill_id>".
    const skillKey = [...store.keys()].find((k) => {
      if (!k.includes(":skill:")) return false;
      try {
        const parsed = JSON.parse(store.get(k) ?? "") as SkillManifest;
        return parsed.domain === domain;
      } catch {
        return false;
      }
    });
    expect(skillKey).toBeDefined();
    const stored = JSON.parse(store.get(skillKey!) ?? "{}") as SkillManifest;
    expect(stored.endpoints[0]?.zk_proof?.verified).toBe(false);
  });

  it("returns 422 with kind=malformed_hash when proof has bad hash", async () => {
    const domain = "proof-bad-hash.example.com";
    const proof = makeProof(domain, "definitely-not-a-sha256");
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(domain, proof)),
    }), env);

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; details: Array<{ kind: string; endpoint_id?: string }> };
    expect(body.error).toBe("Malformed ZK proof");
    expect(body.details).toHaveLength(1);
    expect(body.details[0].kind).toBe("malformed_hash");
    expect(body.details[0].endpoint_id).toBe("ep-1");
    // Nothing should have been persisted.
    expect(store.has(`skill:skill-${domain}`)).toBe(false);
  });

  it("returns 422 with kind=future_timestamp when generated_at is far in the future", async () => {
    const domain = "proof-future.example.com";
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const proof = makeProof(domain, undefined, farFuture);
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(domain, proof)),
    }), env);

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; details: Array<{ kind: string }> };
    expect(body.details[0].kind).toBe("future_timestamp");
  });

  it("soft-rejects domain mismatch — stores proof with verified=false", async () => {
    const skillDomain = "real.example.com";
    const proof = makeProof("evil.example.com");
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(skillDomain, proof)),
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as SkillManifest;
    const ep = body.endpoints[0];
    expect(ep.zk_proof?.verified).toBe(false);
    expect(ep.zk_proof?.verification_failure).toContain("domain mismatch");
  });

  it("publishes normally when no proofs are attached", async () => {
    const domain = "no-proof.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(domain)),
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as SkillManifest;
    expect(body.endpoints[0].zk_proof).toBeUndefined();
  });

  it("returns proof_summary on publish response", async () => {
    const domain = "proof-summary.example.com";
    const proof = makeProof(domain);
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(domain, proof)),
    }), env);

    const body = await res.json() as SkillManifest & { proof_summary?: { total_endpoints: number; verified_proofs: number } };
    expect(body.proof_summary).toBeDefined();
    expect(body.proof_summary?.total_endpoints).toBe(1);
    expect(body.proof_summary?.verified_proofs).toBe(0);
  });

  it("overwrites forged verified=true on commitment_only proofs", async () => {
    const domain = "proof-forged.example.com";
    const proof = { ...makeProof(domain), verified: true };
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(domain, proof)),
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as SkillManifest;
    expect(body.endpoints[0]?.zk_proof?.verified).toBe(false);
    expect(body.endpoints[0]?.zk_proof?.verification_failure).toContain("not independently verified");
  });

  it("returns 422 for malformed empty proof objects", async () => {
    const domain = "proof-empty.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(domain, {} as ZkProof)),
    }), env);

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; details: Array<{ kind: string }> };
    expect(body.error).toBe("Malformed ZK proof");
    expect(body.details[0].kind).toBe("malformed_proof");
  });
});
