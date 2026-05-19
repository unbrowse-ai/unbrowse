// WAVE 1 (SAFETY-CRITICAL): server-enforce publish sanitization.
//
// Bug: the publish route trusted the client to have run sanitizeForPublish.
// A tampered/stale client that skips it leaks the user's OWN secrets (bearer
// tokens, Cookie headers, api keys, high-entropy blobs) into the PUBLIC
// marketplace = incident.
//
// This test FAILS before the route wires server-authoritative re-sanitization
// (the stored skill still contains the raw bearer/cookie/api-key via
// semantic.example_request / query), and PASSES after. It hits the real Hono
// app + real publishSkill + a fake EmergentDB KV (the same harness
// skills-publish-proofs.test.ts uses) — no mocked redactor, no stubbed route.

import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {
    put: async () => {},
    get: async () => null,
  } as unknown as KVNamespace,
  ENVIRONMENT: "staging",
  RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
};

function signedReleaseHeaders() {
  const traceVersion = "trace-sani";
  const codeHash = "code-sani";
  const gitSha = "git-sani";
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

// A publish payload whose endpoints embed the user's OWN secrets verbatim —
// exactly what a stale/tampered client that skipped client-side sanitization
// would POST. Secrets are planted in headers, query, AND semantic so the test
// proves the gate covers every redaction path, not just headers (the
// pre-existing validator only drops credential-NAMED headers).
function unsanitizedPayload(domain: string) {
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
      url_template: `https://${domain}/api/me`,
      description: "fixture endpoint",
      idempotency: "safe",
      verification_status: "unverified",
      reliability_score: 0.55,
      headers_template: {
        authorization: "Bearer sk-live-AbCdEf0123456789AbCdEf0123456789",
        cookie: "session_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.QWxpY2VTZWNyZXQ",
        "x-api-key": "REMOVED_GITHUB_TOKEN",
        accept: "application/json",
      },
      query: {
        api_key: "AKIAIOSFODNN7EXAMPLE",
        q: "my private search query",
      },
      semantic: {
        action_kind: "read",
        resource_kind: "account",
        example_request: { token: "Bearer sk-live-AbCdEf0123456789AbCdEf0123456789" },
        example_response_compact: { email: "alice@private.example", balance: 1234.56 },
        requires: [{ key: "token", source: "header", example_value: "Bearer sk-live-secret" }],
      },
    }],
  };
}

function findStoredSkill(store: Map<string, string>, domain: string): SkillManifest | undefined {
  const key = [...store.keys()].find((k) => {
    if (!k.includes(":skill:")) return false;
    try {
      const parsed = JSON.parse(store.get(k) ?? "") as SkillManifest;
      return parsed.domain === domain;
    } catch {
      return false;
    }
  });
  return key ? (JSON.parse(store.get(key) ?? "{}") as SkillManifest) : undefined;
}

describe("skills publish — server-authoritative secret sanitization", () => {
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

  it("scrubs secrets a stale client failed to redact (headers, query, semantic)", async () => {
    const domain = "stale-client.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(unsanitizedPayload(domain)),
    }), env);

    expect(res.status).toBe(201);

    const stored = findStoredSkill(store, domain);
    expect(stored).toBeDefined();
    const serialized = JSON.stringify(stored);

    // None of the user's raw secrets may appear ANYWHERE in the stored skill.
    expect(serialized).not.toContain("sk-live-AbCdEf0123456789");
    expect(serialized).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIi");
    expect(serialized).not.toContain("alice@private.example");
    expect(serialized).not.toContain("my private search query");

    // The pre-existing validator drops credential-NAMED headers entirely
    // (authorization, cookie, x-api-key); non-credential headers survive with
    // values blanked by server sanitizeForPublish. Either way no raw secret
    // value persists — that is the security guarantee this test pins.
    const ep = stored!.endpoints[0] as Record<string, unknown>;
    const headers = ep.headers_template as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.accept).toBe("");

    // Query values genericized, key preserved.
    const query = ep.query as Record<string, unknown>;
    expect(query.q).toBe("example");
    expect(String(query.api_key)).not.toContain("AKIA");

    // requires[].example_value (a secret carrier) stripped by sanitizeForPublish.
    const sem = ep.semantic as Record<string, unknown>;
    const requires = sem.requires as Array<Record<string, unknown>>;
    expect(requires[0].example_value).toBeUndefined();
  });

  it("stamps server_sanitized:true so consumers know the server is the authority", async () => {
    const domain = "flag.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(unsanitizedPayload(domain)),
    }), env);

    expect(res.status).toBe(201);
    const stored = findStoredSkill(store, domain);
    expect((stored as unknown as Record<string, unknown>)?.server_sanitized).toBe(true);
  });

  it("hard-rejects 422 on structural secret leakage that survives scrubbing", async () => {
    const domain = "structural-leak.example.com";
    // A standalone secret-shaped field value placed where the redactor's
    // structural pass does not reach (a custom top-level endpoint field).
    // After scrubbing it still looksLikeSecret -> structural leakage -> 422.
    const payload = unsanitizedPayload(domain);
    (payload.endpoints[0] as Record<string, unknown>).leaked_token =
      "Bearer sk-live-ZZZZZZZZ9999999999ZZZZZZZZ9999999999";

    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(payload),
    }), env);

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; details?: unknown };
    expect(body.error).toContain("secret");
    // Nothing should have been persisted.
    expect(findStoredSkill(store, domain)).toBeUndefined();
  });
});
