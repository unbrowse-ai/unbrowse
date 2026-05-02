import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

// Concurrency test for the magic-link signup flow. Real Hono app, real
// services/accounts.ts + services/keys.ts. Only the network boundary is
// stubbed: Resend is recorded, EmergentDB qdkv is served from an in-memory
// Map (mirrors backend/tests/auth-routes-magic-flow.test.ts and
// backend/tests/auth-recovery.test.ts).

interface ResendCall { url: string; body: any }

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
};

// statsKV namespace under ENVIRONMENT=staging — see services/kv.ts:statsKV.
const NS = "staging-stats";

let originalFetch: typeof fetch;
let resendCalls: ResendCall[];
let kvStore: Map<string, string>;

function makeFetch(store: Map<string, string>, calls: ResendCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.resend.com") {
      calls.push({ url: urlStr, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "resend-stub" }), { status: 200 });
    }

    if (url.hostname === "api.emergentdb.com") {
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
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

async function postJson(path: string, body: unknown, env: Env = baseEnv): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function getReq(path: string, env: Env = baseEnv): Promise<Response> {
  return app.fetch(new Request(`http://local.test${path}`), env);
}

async function startWith(email: string): Promise<{ status: number; token: string }> {
  const res = await postJson("/v1/auth/email/start", { email });
  const body = await res.json() as { token?: string };
  return { status: res.status, token: body.token ?? "" };
}

async function verify(token: string): Promise<{ status: number; html: string }> {
  const res = await getReq(`/v1/auth/email/verify?token=${token}`);
  const html = await res.text();
  return { status: res.status, html };
}

interface PollBody { status: string; api_key?: string; user_id?: string; email?: string }
async function poll(token: string): Promise<{ status: number; body: PollBody }> {
  const res = await getReq(`/v1/auth/email/poll?token=${token}`);
  const body = await res.json() as PollBody;
  return { status: res.status, body };
}

function readUserKeys(userId: string): string[] {
  const raw = kvStore.get(`${NS}:userkeys:${userId}`);
  if (!raw) return [];
  return (JSON.parse(raw) as { keyIds: string[] }).keyIds;
}

function readAcctRowsForEmail(email: string): number {
  return kvStore.has(`${NS}:acct:${email}`) ? 1 : 0;
}

function readAcct(email: string): { user_id: string } | null {
  const raw = kvStore.get(`${NS}:acct:${email}`);
  return raw ? (JSON.parse(raw) as { user_id: string }) : null;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  kvStore = new Map();
  resendCalls = [];
  globalThis.fetch = makeFetch(kvStore, resendCalls);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("/v1/auth/email/* concurrency", () => {
  it("1. two concurrent starts for same email yield two distinct tokens, both valid", async () => {
    const email = "race1@example.com";
    const [a, b] = await Promise.all([startWith(email), startWith(email)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.token).toMatch(/^[0-9a-f]{32}$/);
    expect(b.token).toMatch(/^[0-9a-f]{32}$/);
    expect(a.token).not.toBe(b.token);

    const va = await verify(a.token);
    const vb = await verify(b.token);
    expect(va.status).toBe(200);
    expect(vb.status).toBe(200);

    const pa = await poll(a.token);
    const pb = await poll(b.token);
    expect(pa.status).toBe(200);
    expect(pb.status).toBe(200);
    expect(pa.body.status).toBe("verified");
    expect(pb.body.status).toBe("verified");
    expect(pa.body.api_key).toMatch(/^ubr_[0-9a-f]{48}$/);
    expect(pb.body.api_key).toMatch(/^ubr_[0-9a-f]{48}$/);
    // createLocalKey always mints a new key per verify
    expect(pa.body.api_key).not.toBe(pb.body.api_key);
  });

  it("2. two concurrent verifies for same token are idempotent (1-2 keys, never 0/>2)", async () => {
    const email = "race2@example.com";
    const { token } = await startWith(email);
    const [r1, r2] = await Promise.all([verify(token), verify(token)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.html.toLowerCase()).toContain("signed in");
    expect(r2.html.toLowerCase()).toContain("signed in");

    expect(readAcctRowsForEmail(email)).toBe(1);
    const acct = readAcct(email)!;
    expect(acct).not.toBeNull();
    const keyIds = readUserKeys(acct.user_id);

    // Both verifies see status !== "verified" before either writes the
    // updated record back, so each one mints a key. Allowed: 1 or 2.
    // Never 0, never >2 (would mean either no bind or duplicate-bind).
    expect(keyIds.length).toBeGreaterThanOrEqual(1);
    expect(keyIds.length).toBeLessThanOrEqual(2);
  });

  it("3. two concurrent polls for same verified token: at most one api_key issued", async () => {
    const email = "race3@example.com";
    const { token } = await startWith(email);
    const v = await verify(token);
    expect(v.status).toBe(200);

    const [p1, p2] = await Promise.all([poll(token), poll(token)]);

    // Both reads can happen before either delete, so both may observe
    // status="verified" returning the same api_key. That's not a one-shot
    // violation per se — same key, same user. What WOULD be a violation is
    // returning two different api_keys (poll never mints; only verify does).
    const verifiedResults = [p1, p2].filter(
      (r) => r.status === 200 && r.body.status === "verified",
    );
    const expiredResults = [p1, p2].filter(
      (r) => r.status === 410 && r.body.status === "expired",
    );
    expect(verifiedResults.length + expiredResults.length).toBe(2);
    expect(verifiedResults.length).toBeGreaterThanOrEqual(1);

    if (verifiedResults.length === 2) {
      // FOLLOW-UP (out of slice scope): poll has no in-process lock, so two
      // concurrent polls can both return the same api_key before delete
      // lands. Same key, so safe — but not strictly one-shot. Would need a
      // single-writer or atomic getAndDelete on the magic record.
      expect(verifiedResults[0]!.body.api_key).toBe(verifiedResults[1]!.body.api_key);
    }

    const after = await poll(token);
    expect(after.status).toBe(410);
    expect(after.body.status).toBe("expired");
  });

  it("4. concurrent verifies for DIFFERENT tokens of same email yield distinct api_keys", async () => {
    // FOLLOW-UP (out of slice scope): under concurrent verify of two
    // different tokens for the same email, upsertUser races — both see
    // existing==null and both mint a new user_id. Last-write-wins on
    // `acct:{email}`, so the poll responses can carry mismatched user_ids
    // that don't agree with what's in storage. Real concern; needs a CAS
    // or single-writer fix in upsertUser. Not in this slice.
    const email = "race4@example.com";
    const a = await startWith(email);
    const b = await startWith(email);
    expect(a.token).not.toBe(b.token);

    await Promise.all([verify(a.token), verify(b.token)]);

    const pa = await poll(a.token);
    const pb = await poll(b.token);
    expect(pa.body.status).toBe("verified");
    expect(pb.body.status).toBe("verified");
    expect(pa.body.api_key).toBeTruthy();
    expect(pb.body.api_key).toBeTruthy();
    expect(pa.body.api_key).not.toBe(pb.body.api_key);
    expect(pa.body.user_id).toBeTruthy();
    expect(pb.body.user_id).toBeTruthy();
    // We do NOT assert pa.user_id === pb.user_id — see follow-up note.
    expect(readAcctRowsForEmail(email)).toBe(1);
  });

  it("5. concurrent starts for different emails do not cross-contaminate", async () => {
    const emails = ["a-cross@example.com", "b-cross@example.com", "c-cross@example.com"];
    const starts = await Promise.all(emails.map((e) => startWith(e)));
    for (const s of starts) {
      expect(s.status).toBe(200);
      expect(s.token).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(new Set(starts.map((s) => s.token)).size).toBe(3);

    await Promise.all(starts.map((s) => verify(s.token)));
    const polls = await Promise.all(starts.map((s) => poll(s.token)));

    polls.forEach((p, i) => {
      expect(p.status).toBe(200);
      expect(p.body.status).toBe("verified");
      expect(p.body.email).toBe(emails[i]!);
    });

    const userIds = polls.map((p) => p.body.user_id!);
    const apiKeys = polls.map((p) => p.body.api_key!);
    expect(new Set(userIds).size).toBe(3);
    expect(new Set(apiKeys).size).toBe(3);
  });

  it("6. sequential burst of 50 starts for same email all succeed; verify+poll the 50th", async () => {
    const email = "burst@example.com";
    const tokens: string[] = [];
    for (let i = 0; i < 50; i++) {
      const s = await startWith(email);
      expect(s.status).toBe(200);
      tokens.push(s.token);
    }
    expect(new Set(tokens).size).toBe(50);

    const last = tokens[49]!;
    const v = await verify(last);
    expect(v.status).toBe(200);
    const p = await poll(last);
    expect(p.status).toBe(200);
    expect(p.body.status).toBe("verified");
    expect(p.body.api_key).toMatch(/^ubr_[0-9a-f]{48}$/);
    expect(p.body.email).toBe(email);

    // Single user row across all 50 starts (no user is created until verify;
    // only the verified token created one).
    expect(readAcctRowsForEmail(email)).toBe(1);
  });

  it("7. verify-then-second-start re-uses the user but mints a new key", async () => {
    const email = "reuse@example.com";
    const a = await startWith(email);
    await verify(a.token);
    const pa = await poll(a.token);
    expect(pa.body.status).toBe("verified");
    const firstKey = pa.body.api_key!;
    const firstUid = pa.body.user_id!;

    const b = await startWith(email);
    await verify(b.token);
    const pb = await poll(b.token);
    expect(pb.body.status).toBe("verified");
    expect(pb.body.api_key).toBeTruthy();
    expect(pb.body.api_key).not.toBe(firstKey);
    expect(pb.body.user_id).toBe(firstUid);
    expect(readAcctRowsForEmail(email)).toBe(1);
  });
});
