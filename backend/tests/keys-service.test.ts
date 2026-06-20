/**
 * API-key service direct units — TEST-SPECS §2 gaps (AC-KEY-1/2/3/4).
 *
 * Covers: create stores only hashes (plaintext never persisted), verify
 * across valid/unknown/malformed/revoked, revoke idempotency + funding
 * cleanup, credit-budget debit lanes, and the ALL_KEYS_REVOKED kill switch
 * rejecting every bearer before any KV lookup.
 *
 * Uses the repo's local-dev KV lane (statsKV → in-process LocalKV), same
 * pattern as sponsor-middleware.test.ts.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  createLocalKey,
  verifyLocalKey,
  revokeLocalKey,
  getKeyMeta,
  setKeyFunding,
  getKeyFunding,
  debitKeyFunding,
  creditKeyWalletBalance,
} from "../src/services/keys.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import { bearerAuth } from "../src/middleware/auth.js";
import type { Env } from "../src/types.js";

const ENV = {
  ENVIRONMENT: "local-dev",
  EMERGENTDB_API_KEY: "x",
} as unknown as Env;

function allStoredEntries(): Array<[string, string]> {
  const kv = new LocalKV("stats") as unknown as { store: Map<string, string> };
  return Array.from(kv.store.entries());
}

beforeEach(() => {
  clearKVCacheForTests();
  // LocalKV namespaces share module-level maps — start each test empty.
  (new LocalKV("stats") as unknown as { store: Map<string, string> }).store.clear();
});

describe("createLocalKey (AC-KEY-1)", () => {
  it("returns ubr_-prefixed 48-hex key with keyId = first 32 hex chars", async () => {
    const { key, keyId, meta } = await createLocalKey(ENV, "ci-key");
    expect(key).toMatch(/^ubr_[0-9a-f]{48}$/);
    expect(keyId).toBe(key.slice(4, 36));
    expect(meta.name).toBe("ci-key");
    expect(meta.revoked_at).toBeNull();
  });

  it("persists only hashes — the plaintext key appears nowhere in storage", async () => {
    const { key, keyId } = await createLocalKey(ENV, "leak-check");
    const entries = allStoredEntries();
    expect(entries.length).toBeGreaterThanOrEqual(2); // keyhash: + keyid:
    for (const [k, v] of entries) {
      expect(k).not.toContain(key);
      expect(v).not.toContain(key);
    }
    // and the reverse index is readable by keyId
    const metaBack = await getKeyMeta(ENV, keyId);
    expect(metaBack?.name).toBe("leak-check");
  });
});

describe("verifyLocalKey (AC-KEY-2)", () => {
  it("accepts a freshly created key and returns its keyId", async () => {
    const { key, keyId } = await createLocalKey(ENV, "verify-me");
    const res = await verifyLocalKey(ENV, key);
    expect(res).toEqual({ valid: true, keyId });
  });

  it("rejects unknown, malformed, and empty keys", async () => {
    expect(await verifyLocalKey(ENV, `ubr_${"a".repeat(48)}`)).toEqual({ valid: false });
    expect(await verifyLocalKey(ENV, "sk_not_an_unbrowse_key")).toEqual({ valid: false });
    expect(await verifyLocalKey(ENV, "")).toEqual({ valid: false });
  });
});

describe("revokeLocalKey (AC-KEY-3)", () => {
  it("revoked key fails verification; revoke is idempotent; unknown keyId is false", async () => {
    const { key, keyId } = await createLocalKey(ENV, "revoke-me");
    expect((await verifyLocalKey(ENV, key)).valid).toBe(true);

    expect(await revokeLocalKey(ENV, keyId)).toBe(true);
    expect((await verifyLocalKey(ENV, key)).valid).toBe(false);
    expect((await getKeyMeta(ENV, keyId))?.revoked_at).not.toBeNull();

    expect(await revokeLocalKey(ENV, keyId)).toBe(true); // idempotent
    expect(await revokeLocalKey(ENV, "0".repeat(32))).toBe(false); // unknown → 404 lane
  });

  it("clears the key's funding binding on revoke", async () => {
    const { keyId } = await createLocalKey(ENV, "funded");
    await setKeyFunding(ENV, keyId, { kind: "credit", budget_uc: 5000 });
    expect((await getKeyFunding(ENV, keyId))?.kind).toBe("credit");
    await revokeLocalKey(ENV, keyId);
    expect(await getKeyFunding(ENV, keyId)).toBeNull();
  });
});

describe("debitKeyFunding (AC-FUND-2 credit lane)", () => {
  it("debits within budget, refuses on insufficient, and never goes negative", async () => {
    const { keyId } = await createLocalKey(ENV, "budget");
    await setKeyFunding(ENV, keyId, { kind: "credit", budget_uc: 1000 });

    const first = await debitKeyFunding(ENV, keyId, 600);
    expect(first).toEqual({ ok: true, remaining_uc: 400 });

    const second = await debitKeyFunding(ENV, keyId, 600);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("insufficient");
      expect(second.remaining_uc).toBe(400); // untouched
    }
  });

  it("refuses keys with no binding at all (unfunded key falls through to per-call 402)", async () => {
    const { keyId } = await createLocalKey(ENV, "unfunded");
    const res = await debitKeyFunding(ENV, keyId, 100);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_balance_binding");
  });

  it("a wallet-bound key with ZERO deposited balance is insufficient (never the platform pays) -> 402", async () => {
    const { keyId } = await createLocalKey(ENV, "wallet-bound-empty");
    await setKeyFunding(ENV, keyId, { kind: "wallet", wallet: "So1Wallet111" });
    const res = await debitKeyFunding(ENV, keyId, 100);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("insufficient");
      expect(res.remaining_uc).toBe(0);
    }
  });

  it("a wallet-bound key SPENDS its DEPOSITED balance (always-on, no flag, no platform pays)", async () => {
    const { keyId } = await createLocalKey(ENV, "wallet-bound-funded");
    await setKeyFunding(ENV, keyId, { kind: "wallet", wallet: "So1Wallet222" });
    // (a) a deposit credits balance_uc...
    const dep = await creditKeyWalletBalance(ENV, keyId, 1000);
    expect(dep.ok).toBe(true);
    if (dep.ok) {
      expect(dep.balance_uc).toBe(1000);
      expect(dep.wallet).toBe("So1Wallet222");
    }
    // (b) ...and a wallet-key with balance settles a call by debiting it.
    const first = await debitKeyFunding(ENV, keyId, 600);
    expect(first).toEqual({ ok: true, remaining_uc: 400 });
    // ...and over-spend is refused, balance untouched.
    const second = await debitKeyFunding(ENV, keyId, 600);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("insufficient");
      expect(second.remaining_uc).toBe(400);
    }
  });

  it("creditKeyWalletBalance refuses a key with no wallet binding (deposit must target a bound wallet key)", async () => {
    const { keyId } = await createLocalKey(ENV, "credit-key");
    await setKeyFunding(ENV, keyId, { kind: "credit", budget_uc: 500 });
    const res = await creditKeyWalletBalance(ENV, keyId, 100);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_wallet_binding");
  });
});

describe("ALL_KEYS_REVOKED kill switch (AC-KEY-4)", () => {
  function appWith(env: Record<string, unknown>) {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", bearerAuth as never);
    app.get("/probe", (c) => c.json({ ok: true }));
    return { app, env };
  }

  it("rejects every bearer — even a freshly minted valid key — with 401 + rotation pointer", async () => {
    const { key } = await createLocalKey(ENV, "doomed");
    const { app, env } = appWith({ ...ENV, ALL_KEYS_REVOKED: "1" });
    const res = await app.request(
      "/probe",
      { headers: { Authorization: `Bearer ${key}` } },
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; rotation_url?: string };
    expect(body.error).toBe("all_keys_rotated");
    expect(body.rotation_url).toContain("unbrowse.ai");
  });

  it("also rejects the legacy admin env key while the switch is on", async () => {
    const { app, env } = appWith({ ...ENV, API_KEY: "admin-secret", ALL_KEYS_REVOKED: "true" });
    const res = await app.request(
      "/probe",
      { headers: { Authorization: `Bearer admin-secret` } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("missing Authorization header is 401 regardless of the switch", async () => {
    const { app, env } = appWith({ ...ENV });
    const res = await app.request("/probe", {}, env);
    expect(res.status).toBe(401);
  });
});
