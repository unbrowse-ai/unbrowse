// Contract 73026078 — domain-verification gate is ON BY DEFAULT.
//
// Before this commit, REQUIRE_DOMAIN_VERIFICATION had to be set to "1" or
// "true" to enforce the gate; the default was OFF and any non-admin agent
// could publish a skill against any unverified domain. That is the Granola
// May 20 issue: publisher must prove control of the domain they are
// indexing.
//
// This test hits the real Hono app + real publishSkill + a fake EmergentDB
// KV (the same harness skills-publish-proofs.test.ts uses) — no mocked
// gate, no stubbed publishSkill (contract 4305eae2). It pins:
//   1) default ON  — unset REQUIRE_DOMAIN_VERIFICATION ⇒ non-admin publish
//      against an unverified domain is refused with 403
//      publish_forbidden_domain_unverified.
//   2) admin still bypasses — `Bearer admin` (matches env.API_KEY) ⇒ the
//      same payload publishes 201 (admin override is the marketplace seed
//      path).
//   3) explicit opt-out — `REQUIRE_DOMAIN_VERIFICATION=0` re-opens the
//      gate so staging back-compat still works.

import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_KEY: "admin",
    EMERGENTDB_API_KEY: "test",
    NEBIUS_API_KEY: "nebius",
    STATS_KV: {
      put: async () => {},
      get: async () => null,
    } as unknown as KVNamespace,
    ENVIRONMENT: "staging",
    RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
    ...overrides,
  };
}

function signedReleaseHeaders(env: Env) {
  const traceVersion = "trace-verify-default";
  const codeHash = "code-verify-default";
  const gitSha = "git-verify-default";
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

function publishPayload(domain: string) {
  return {
    skill_id: `skill-${domain}`,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: domain,
    domain,
    description: "fixture",
    owner_type: "marketplace" as const,
    execution_type: "http" as const,
    lifecycle: "active" as const,
    created_at: "2026-04-04T00:00:00.000Z",
    updated_at: "2026-04-04T00:00:00.000Z",
    endpoints: [{
      endpoint_id: "ep-1",
      method: "GET" as const,
      url_template: `https://${domain}/api/search`,
      description: "fixture endpoint",
      idempotency: "safe" as const,
      verification_status: "unverified" as const,
      reliability_score: 0.55,
    }],
  };
}

function emergentDbMock(store: Map<string, string>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
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
}

describe("marketplace publishSkill — domain verification default ON", () => {
  const originalFetch = globalThis.fetch;
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    globalThis.fetch = emergentDbMock(store);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("REGRESSION: with REQUIRE_DOMAIN_VERIFICATION UNSET, non-admin publish against an unverified domain is refused 403", async () => {
    const env = makeEnv(); // no REQUIRE_DOMAIN_VERIFICATION
    const domain = "default-on-unverified.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456", // non-admin, non-registered → submitter_agent_id stays undefined
        "Content-Type": "application/json",
        ...signedReleaseHeaders(env),
      },
      body: JSON.stringify(publishPayload(domain)),
    }), env);

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; domain?: string; next_step?: string };
    expect(body.error).toBe("publish_forbidden_domain_unverified");
    expect(body.domain).toBe(domain);
    expect(body.next_step).toBeDefined();
    // KV must NOT contain the skill — gate fires before persistence.
    const persisted = [...store.keys()].some((k) => k.includes(`skill:skill-${domain}`));
    expect(persisted).toBe(false);
  });

  it("admin publish bypasses the gate even with default ON", async () => {
    const env = makeEnv(); // no REQUIRE_DOMAIN_VERIFICATION
    const domain = "default-on-admin-bypass.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.API_KEY}`, // matches API_KEY → __admin__
        "Content-Type": "application/json",
        ...signedReleaseHeaders(env),
      },
      body: JSON.stringify(publishPayload(domain)),
    }), env);

    expect(res.status).toBe(201);
    const skill = await res.json() as SkillManifest;
    expect(skill.domain).toBe(domain);
  });

  it("explicit REQUIRE_DOMAIN_VERIFICATION=0 opens the gate (staging back-compat)", async () => {
    const env = makeEnv({ REQUIRE_DOMAIN_VERIFICATION: "0" });
    const domain = "explicit-optout.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456", // non-admin
        "Content-Type": "application/json",
        ...signedReleaseHeaders(env),
      },
      body: JSON.stringify(publishPayload(domain)),
    }), env);

    expect(res.status).toBe(201);
    const skill = await res.json() as SkillManifest;
    expect(skill.domain).toBe(domain);
  });

  it("explicit REQUIRE_DOMAIN_VERIFICATION=false also opens the gate", async () => {
    const env = makeEnv({ REQUIRE_DOMAIN_VERIFICATION: "false" });
    const domain = "explicit-optout-false.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(env),
      },
      body: JSON.stringify(publishPayload(domain)),
    }), env);

    expect(res.status).toBe(201);
  });
});
