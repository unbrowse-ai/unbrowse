import { createHmac } from "crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";

// Witness for the forged-attribution fix: a non-admin publish that claims an indexer_id
// different from the authenticated agent must be REJECTED — otherwise an attacker
// attributes a contribution (and, via the wallet resolver, a PAYOUT) to a victim. Admin
// seeding may attribute on behalf of others.

function emergentDbMock(store: Map<string, string>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    if (url.hostname === "api.tokenfactory.nebius.com") return Response.json({ choices: [{ message: { content: '{"leaks":[]}' } }] });
    if (url.hostname !== "api.emergentdb.com") throw new Error(`Unexpected fetch: ${url}`);
    if (url.pathname === "/qdkv/set") { const b = JSON.parse(String(init?.body ?? "{}")); store.set(b.key, b.value); return Response.json({ ok: true }); }
    if (url.pathname === "/qdkv/mget") { const b = JSON.parse(String(init?.body ?? "{}")); const v: Record<string, string | null> = {}; for (const k of b.keys ?? []) v[k] = store.get(k) ?? null; return Response.json({ values: v }); }
    if (url.pathname.startsWith("/qdkv/get/")) { const k = decodeURIComponent(url.pathname.replace("/qdkv/get/", "")); const v = store.get(k); return Response.json(v == null ? { found: false, value: null } : { found: true, value: v }); }
    if (url.pathname.startsWith("/qdkv/del/")) { store.delete(decodeURIComponent(url.pathname.replace("/qdkv/del/", ""))); return Response.json({ ok: true }); }
    if (url.pathname.startsWith("/graph/")) return Response.json({ ok: true, results: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}
function makeEnv(): Env {
  return { API_KEY: "admin", EMERGENTDB_API_KEY: "test", NEBIUS_API_KEY: "nebius", ENVIRONMENT: "staging", RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
    STATS_KV: { put: async () => {}, get: async () => null } as unknown as KVNamespace } as unknown as Env;
}
function signedHeaders(e: Env) {
  const m = JSON.stringify({ schema_version: 1, release_version: "2.11.0", git_sha: "g", code_hash: "c", trace_version: "t", issued_at: "2026-04-04T00:00:00.000Z" });
  const sig = createHmac("sha256", e.RELEASE_MANIFEST_SIGNING_SECRET!).update(m).digest("base64url");
  return { "X-Unbrowse-Release-Manifest": Buffer.from(m, "utf8").toString("base64url"), "X-Unbrowse-Release-Signature": sig };
}
function payload(domain: string, indexer_id?: string) {
  return { skill_id: `skill-${domain}`, version: "1.0.0", schema_version: "1", name: domain, intent_signature: domain, domain, description: "fixture",
    owner_type: "marketplace", execution_type: "http", lifecycle: "active", created_at: "2026-04-04T00:00:00.000Z", updated_at: "2026-04-04T00:00:00.000Z",
    ...(indexer_id ? { indexer_id } : {}),
    endpoints: [{ endpoint_id: "ep-1", method: "GET", url_template: `https://${domain}/api/x`, description: "fixture", idempotency: "safe", verification_status: "unverified", reliability_score: 0.55 }] };
}
const realFetch = globalThis.fetch;
let store: Map<string, string>;
beforeEach(() => { store = new Map(); globalThis.fetch = emergentDbMock(store); });
afterEach(() => { globalThis.fetch = realFetch; });

test("non-admin publish claiming a DIFFERENT indexer_id (victim) is rejected 403", async () => {
  const e = makeEnv();
  const res = await app.fetch(new Request("http://local.test/v1/skills", {
    method: "POST",
    headers: { Authorization: "Bearer attacker-key-123456", "Content-Type": "application/json", ...signedHeaders(e) },
    body: JSON.stringify(payload("attack.example", "victim-agent-keyid")),
  }), e);
  expect(res.status).toBe(403);
  expect((await res.json() as { error: string }).error).toBe("indexer_id_mismatch");
});

test("admin publish MAY attribute on behalf of others (not 403'd by the mismatch gate)", async () => {
  const e = makeEnv();
  const res = await app.fetch(new Request("http://local.test/v1/skills", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "Content-Type": "application/json", ...signedHeaders(e) },
    body: JSON.stringify(payload("admin-seed.example", "some-other-agent")),
  }), e);
  // Admin is exempt from the indexer_id mismatch gate — whatever else happens, it's NOT this 403.
  if (res.status === 403) expect((await res.json() as { error: string }).error).not.toBe("indexer_id_mismatch");
});
