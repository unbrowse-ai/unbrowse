/**
 * delegation-ledger — the rolling cap ledger for the non-custodial delegated
 * funding lane (design §5). Witnesses:
 *   - draws accumulate into the spent projection;
 *   - IDEMPOTENT on authorization_id (a settle replay does NOT double-count);
 *   - remaining = cap - spent;
 *   - over-cap is detectable (remaining hits 0; the cumulative sum past cap is
 *     refusable).
 *
 * Uses the repo's local-dev KV lane (statsKV → in-process LocalKV), same pattern
 * as keys-service.test.ts.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import {
  recordDelegationDraw,
  delegationSpent,
  delegationRemaining,
  readDelegationDraws,
} from "../src/services/delegation-ledger.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { Env } from "../src/types.js";

const ENV = {
  ENVIRONMENT: "local-dev",
  EMERGENTDB_API_KEY: "x",
} as unknown as Env;

beforeEach(() => {
  clearKVCacheForTests();
  (new LocalKV("stats") as unknown as { store: Map<string, string> }).store.clear();
});

describe("recordDelegationDraw + delegationSpent (accumulation)", () => {
  it("sums many draws into the spent projection", async () => {
    const keyId = "deleg-key-1";
    await recordDelegationDraw(ENV, keyId, { authorization_id: "auth-1", amount_uc: 300 });
    await recordDelegationDraw(ENV, keyId, { authorization_id: "auth-2", amount_uc: 250 });
    await recordDelegationDraw(ENV, keyId, { authorization_id: "auth-3", amount_uc: 100 });
    expect(await delegationSpent(ENV, keyId)).toBe(650);
    expect((await readDelegationDraws(ENV, keyId)).length).toBe(3);
  });

  it("isolates draws per key (one key's draws don't leak into another's projection)", async () => {
    await recordDelegationDraw(ENV, "key-a", { authorization_id: "auth-1", amount_uc: 500 });
    await recordDelegationDraw(ENV, "key-b", { authorization_id: "auth-1", amount_uc: 999 });
    expect(await delegationSpent(ENV, "key-a")).toBe(500);
    expect(await delegationSpent(ENV, "key-b")).toBe(999);
  });

  it("rejects non-positive / non-finite amounts (a draw must move a positive amount)", async () => {
    const r0 = await recordDelegationDraw(ENV, "k", { authorization_id: "a", amount_uc: 0 });
    expect(r0.ok).toBe(false);
    const rNeg = await recordDelegationDraw(ENV, "k", { authorization_id: "a", amount_uc: -5 });
    expect(rNeg.ok).toBe(false);
    const rNaN = await recordDelegationDraw(ENV, "k", { authorization_id: "a", amount_uc: NaN });
    expect(rNaN.ok).toBe(false);
    const rBlank = await recordDelegationDraw(ENV, "k", { authorization_id: "  ", amount_uc: 10 });
    expect(rBlank.ok).toBe(false);
    expect(await delegationSpent(ENV, "k")).toBe(0);
  });
});

describe("idempotency on authorization_id (replay protection)", () => {
  it("recording the SAME authorization_id twice does NOT double-count", async () => {
    const keyId = "deleg-key-replay";
    const first = await recordDelegationDraw(ENV, keyId, { authorization_id: "auth-X", amount_uc: 400 });
    expect(first.ok).toBe(true);
    // Replay the exact same settle — the cap ledger must treat it as a no-op.
    const replay = await recordDelegationDraw(ENV, keyId, { authorization_id: "auth-X", amount_uc: 400 });
    expect(replay.ok).toBe(true);

    expect(await delegationSpent(ENV, keyId)).toBe(400); // NOT 800
    expect((await readDelegationDraws(ENV, keyId)).length).toBe(1);
  });

  it("a replay with a tampered amount still observes the originally-recorded amount", async () => {
    const keyId = "deleg-key-tamper";
    await recordDelegationDraw(ENV, keyId, { authorization_id: "auth-Y", amount_uc: 100 });
    // Same authorization id, larger claimed amount: the original wins, sum unchanged.
    const replay = await recordDelegationDraw(ENV, keyId, { authorization_id: "auth-Y", amount_uc: 999999 });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.draw.amount_uc).toBe(100);
    expect(await delegationSpent(ENV, keyId)).toBe(100);
  });
});

describe("delegationRemaining (cap - spent) + over-cap detection", () => {
  it("remaining = cap - spent, and clamps at 0 (never negative)", async () => {
    const keyId = "deleg-key-cap";
    const cap = 1000;
    expect(await delegationRemaining(ENV, keyId, cap)).toBe(1000);

    await recordDelegationDraw(ENV, keyId, { authorization_id: "a1", amount_uc: 600 });
    expect(await delegationRemaining(ENV, keyId, cap)).toBe(400);

    await recordDelegationDraw(ENV, keyId, { authorization_id: "a2", amount_uc: 400 });
    expect(await delegationRemaining(ENV, keyId, cap)).toBe(0);

    // An over-draw projection clamps remaining at 0, not negative.
    await recordDelegationDraw(ENV, keyId, { authorization_id: "a3", amount_uc: 50 });
    expect(await delegationSpent(ENV, keyId)).toBe(1050);
    expect(await delegationRemaining(ENV, keyId, cap)).toBe(0);
  });

  it("the SUM of many small bounded draws past cap is detectable (over-cap refusable)", async () => {
    // The exact invariant: each draw is small (independently within an on-chain
    // maxAmount), but their SUM exceeds the delegated cap. The off-chain ledger
    // makes that detectable so admission can refuse the draw that would cross.
    const keyId = "deleg-key-sum";
    const cap = 500;
    let drawn = 0;
    let refusedAt = -1;
    for (let i = 0; i < 10; i++) {
      const amount = 100;
      const remaining = await delegationRemaining(ENV, keyId, cap);
      if (remaining < amount) {
        refusedAt = i; // admission would refuse here (over-cap), fall through to per-call 402
        break;
      }
      await recordDelegationDraw(ENV, keyId, { authorization_id: `s-${i}`, amount_uc: amount });
      drawn += amount;
    }
    expect(refusedAt).toBe(5); // draws 0..4 fit (500), draw 5 would cross
    expect(drawn).toBe(500);
    expect(await delegationSpent(ENV, keyId)).toBe(500);
    expect(await delegationSpent(ENV, keyId)).toBeLessThanOrEqual(cap);
  });
});
