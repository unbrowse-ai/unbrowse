// Layer-1 witness — server-side route ledger (§8 "value off-chain, root
// on-chain"; §13 Merkle-root checkpoint). Drives the REAL Hono app + REAL
// publishSkill against an in-memory EmergentDB store (same harness as
// marketplace-domain-verify-default.test.ts), then audits the ledger through the
// real route-ledger module reading the same store via skillsKV.
//
// Pins:
//   1) a publish lands a content-addressed, signed leaf in the ledger
//   2) verifyLedger() confirms the log is consistent and yields a Merkle root
//   3) a second, distinct publish APPENDS and MOVES the root (append-only,
//      tamper-evident — order is derived from content, no write-time chain race)
//   4) tampering a stored leaf in place breaks verifyLedger() (root integrity)
//   5) re-publishing identical bytes is idempotent (content-addressed key)

import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";
import { clearKVCacheForTests, skillsKV } from "../src/services/kv.js";
import { verifyLedger, ledgerRoot, readLeaves, appendRouteAttestation, type RouteLeaf } from "../src/services/route-ledger.js";

/**
 * Simulate an attacker corrupting stored ledger bytes. This KV inlines values in
 * its `_idx:main` sub-index, and listWithValues serves the inline copy — so a
 * faithful tamper must corrupt the inline index entry (what verifyLedger reads),
 * exactly the row an attacker with store access would edit.
 */
function tamperInlineLeaf(store: Map<string, string>, mutate: (leaf: RouteLeaf) => void): boolean {
  for (const [k, v] of store.entries()) {
    if (!k.endsWith(":_idx:main") && !k.endsWith(":_idx")) continue;
    let arr: Array<{ k: string; v: string }>;
    try { arr = JSON.parse(v); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    let changed = false;
    for (const entry of arr) {
      if (entry.k?.startsWith("routeledger:leaf:") && entry.v) {
        const leaf = JSON.parse(entry.v) as RouteLeaf;
        mutate(leaf);
        entry.v = JSON.stringify(leaf);
        changed = true;
      }
    }
    if (changed) { store.set(k, JSON.stringify(arr)); return true; }
  }
  return false;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_KEY: "admin",
    EMERGENTDB_API_KEY: "test",
    NEBIUS_API_KEY: "nebius",
    STATS_KV: { put: async () => {}, get: async () => null } as unknown as KVNamespace,
    ENVIRONMENT: "staging",
    RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
    ...overrides,
  };
}

function signedReleaseHeaders(env: Env) {
  const manifest = JSON.stringify({
    schema_version: 1,
    release_version: "2.11.0",
    git_sha: "git-ledger",
    code_hash: "code-ledger",
    trace_version: "trace-ledger",
    issued_at: "2026-04-04T00:00:00.000Z",
  });
  const signature = createHmac("sha256", env.RELEASE_MANIFEST_SIGNING_SECRET!)
    .update(manifest)
    .digest("base64url");
  return {
    "X-Unbrowse-Trace-Version": "trace-ledger",
    "X-Unbrowse-Code-Hash": "code-ledger",
    "X-Unbrowse-Git-Sha": "git-ledger",
    "X-Unbrowse-Release-Manifest": Buffer.from(manifest, "utf8").toString("base64url"),
    "X-Unbrowse-Release-Signature": signature,
  };
}

function publishPayload(domain: string, ts: string) {
  return {
    skill_id: `skill-${domain}`,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: domain,
    domain,
    description: "ledger fixture",
    owner_type: "marketplace" as const,
    execution_type: "http" as const,
    lifecycle: "active" as const,
    created_at: ts,
    updated_at: ts,
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

async function publish(env: Env, domain: string, ts: string): Promise<number> {
  const res = await app.fetch(new Request("http://local.test/v1/skills", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.API_KEY}`, // admin → bypasses domain-verify gate
      "Content-Type": "application/json",
      ...signedReleaseHeaders(env),
    },
    body: JSON.stringify(publishPayload(domain, ts)),
  }), env);
  return res.status;
}

describe("route-ledger — server-side tamper-evident publish ledger", () => {
  const originalFetch = globalThis.fetch;
  let store: Map<string, string>;
  let env: Env;

  beforeEach(() => {
    store = new Map();
    globalThis.fetch = emergentDbMock(store);
    clearKVCacheForTests();
    env = makeEnv();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearKVCacheForTests();
  });

  it("a publish lands a signed, content-addressed leaf; verifyLedger confirms consistency", async () => {
    const status = await publish(env, "ledger-a.example.com", "2026-04-04T00:00:00.000Z");
    expect(status).toBe(201);

    clearKVCacheForTests();
    const kv = skillsKV(env);
    const leaves = await readLeaves(kv);
    expect(leaves.length).toBe(1);
    expect(leaves[0].domain).toBe("ledger-a.example.com");
    expect(leaves[0].skill_id).toBe("skill-ledger-a.example.com");
    expect(leaves[0].value_hash).toMatch(/^[0-9a-f]{64}$/);

    const audit = await verifyLedger(kv);
    expect(audit.ok).toBe(true);
    expect(audit.count).toBe(1);
    expect(audit.bad.length).toBe(0);
    expect(audit.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a second distinct publish appends and MOVES the Merkle root", async () => {
    expect(await publish(env, "ledger-b1.example.com", "2026-04-04T00:00:00.000Z")).toBe(201);
    clearKVCacheForTests();
    const kv = skillsKV(env);
    const root1 = (await ledgerRoot(kv)).root;

    expect(await publish(env, "ledger-b2.example.com", "2026-04-04T00:01:00.000Z")).toBe(201);
    clearKVCacheForTests();
    const after = await ledgerRoot(skillsKV(env));
    expect(after.count).toBe(2);
    expect(after.root).not.toBe(root1); // append changes the commitment
    const audit = await verifyLedger(skillsKV(env));
    expect(audit.ok).toBe(true);
  });

  it("tampering a stored leaf in place breaks verifyLedger (content no longer hashes to its address)", async () => {
    expect(await publish(env, "ledger-c.example.com", "2026-04-04T00:00:00.000Z")).toBe(201);
    clearKVCacheForTests();

    // Corrupt the leaf bytes the ledger actually reads (the inline index value),
    // forging a different committed value_hash than the one the address binds.
    const tampered = tamperInlineLeaf(store, (leaf) => { leaf.value_hash = "deadbeef".repeat(8); });
    expect(tampered).toBe(true);
    clearKVCacheForTests();

    const audit = await verifyLedger(skillsKV(env));
    expect(audit.ok).toBe(false); // tamper detected — leaf no longer hashes to its key
    expect(audit.bad.length).toBe(1);
  });

  it("the content-addressed leaf key is idempotent under retry (identical bytes → one row)", async () => {
    // The true idempotency guarantee is at the content-address level: a duplicate
    // delivery of the SAME signed leaf (e.g. a publish-call network retry) writes
    // the same key and yields no new row. (A real re-publish stamps a fresh
    // updated_at → a distinct leaf → an append, which is correct append-only
    // provenance, asserted by the append-MOVES-root test above.)
    const kv = skillsKV(env);
    const leaf: RouteLeaf = {
      domain: "retry.example.com",
      skill_id: "skill-retry.example.com",
      value_hash: "ab".repeat(32),
      signer: "platform",
      ts: 1_700_000_000_000,
      sig: "",
    };
    const first = await appendRouteAttestation(kv, leaf);
    clearKVCacheForTests();
    const c1 = (await ledgerRoot(skillsKV(env))).count;

    const second = await appendRouteAttestation(skillsKV(env), { ...leaf });
    expect(second.leaf_hash).toBe(first.leaf_hash); // same content → same address
    clearKVCacheForTests();
    const c2 = (await ledgerRoot(skillsKV(env))).count;
    expect(c2).toBe(c1); // retry of identical bytes adds no new row
  });
});
