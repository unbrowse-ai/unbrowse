import { createHmac } from "crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import app from "../src/index.js";
import { buildOptOutKey } from "../src/services/domain-claim.js";
import { statsKV } from "../src/services/kv.js";
import type { Env } from "../src/types.js";

// Witness for the takedown-gate key-mismatch fix. The claim flow writes the opt-out
// marker via buildOptOutKey (`domain-optout:<domain>`), but the publish gate USED to
// read a literal `domain-takedown:<domain>` — same store (statsKV/EdbKV), different
// key — so every takedown was silently ignored and any agent could keep publishing to
// a domain its verified owner had taken down. We write the marker exactly as the claim
// flow does (statsKV().put(buildOptOutKey(...))) through the mocked EmergentDB, then
// attempt an admin publish and assert it is refused. RED on the old literal key; GREEN
// once the gate reads buildOptOutKey from the same store.

function emergentDbMock(store: Map<string, string>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    if (url.hostname === "api.tokenfactory.nebius.com") {
      return Response.json({ choices: [{ message: { content: '{"leaks":[]}' } }] });
    }
    if (url.hostname !== "api.emergentdb.com") throw new Error(`Unexpected fetch: ${url}`);
    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/qdkv/mget") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { keys?: string[] };
      const values: Record<string, string | null> = {};
      for (const k of body.keys ?? []) values[k] = store.get(k) ?? null;
      return Response.json({ values });
    }
    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null ? { found: false, value: null } : { found: true, value });
    }
    if (url.pathname.startsWith("/qdkv/del/")) {
      store.delete(decodeURIComponent(url.pathname.replace("/qdkv/del/", "")));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/graph/batch_insert" || url.pathname === "/graph/delete") return Response.json({ ok: true });
    if (url.pathname === "/graph/edges" || url.pathname === "/graph/search") return Response.json({ ok: true, results: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function makeEnv(): Env {
  return {
    API_KEY: "admin", EMERGENTDB_API_KEY: "test", NEBIUS_API_KEY: "nebius",
    ENVIRONMENT: "staging", RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
    STATS_KV: { put: async () => {}, get: async () => null } as unknown as KVNamespace,
  } as unknown as Env;
}

function signedHeaders(e: Env) {
  const manifest = JSON.stringify({ schema_version: 1, release_version: "2.11.0", git_sha: "g", code_hash: "c", trace_version: "t", issued_at: "2026-04-04T00:00:00.000Z" });
  const signature = createHmac("sha256", e.RELEASE_MANIFEST_SIGNING_SECRET!).update(manifest).digest("base64url");
  return { "X-Unbrowse-Release-Manifest": Buffer.from(manifest, "utf8").toString("base64url"), "X-Unbrowse-Release-Signature": signature };
}

function payload(domain: string) {
  return {
    skill_id: `skill-${domain}`, version: "1.0.0", schema_version: "1", name: domain, intent_signature: domain,
    domain, description: "fixture", owner_type: "marketplace", execution_type: "http", lifecycle: "active",
    created_at: "2026-04-04T00:00:00.000Z", updated_at: "2026-04-04T00:00:00.000Z",
    endpoints: [{ endpoint_id: "ep-1", method: "GET", url_template: `https://${domain}/api/x`, description: "fixture", idempotency: "safe", verification_status: "unverified", reliability_score: 0.55 }],
  };
}

const originalFetch = globalThis.fetch;
let store: Map<string, string>;
beforeEach(() => { store = new Map(); globalThis.fetch = emergentDbMock(store); });
afterEach(() => { globalThis.fetch = originalFetch; });

test("a taken-down domain (opt-out key written by the claim flow) refuses publish — even for admin", async () => {
  const e = makeEnv();
  const domain = "taken-down.example.com";
  // Write the marker EXACTLY as the claim flow does — through statsKV so it lands in
  // the same namespaced EdbKV the gate reads.
  await statsKV(e).put(buildOptOutKey(domain), "1");

  const res = await app.fetch(new Request("http://local.test/v1/skills", {
    method: "POST",
    headers: { Authorization: "Bearer admin", "Content-Type": "application/json", ...signedHeaders(e) },
    body: JSON.stringify(payload(domain)),
  }), e);

  expect(res.status).toBe(403);
  expect((await res.json() as { error: string }).error).toBe("publish_forbidden_taken_down");
});
