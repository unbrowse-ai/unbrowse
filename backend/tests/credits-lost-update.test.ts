/**
 * Witness for the credits ledger unification (extends LEDGER-UNIFICATION-PLAN.md
 * to credits.ts — the same RMW lost-update bug class as attribution/fees).
 *
 * The credit balance must CONSERVE earnings and consumption under concurrency.
 * The old read-modify-write accumulator on a CAS-free KV silently loses
 * concurrent updates — for debits that means a charge is LOST (the agent spent
 * but wasn't billed: money loss). The append-only event-log + projection model
 * conserves all of them (distinct keys, order-independent fold).
 *
 * RED on the RMW accumulator, GREEN on the event-log + projection.
 *   bun test backend/tests/credits-lost-update.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  initSubsidyPool,
  grantCredits,
  debitCredits,
  creditEarnings,
  getBalance,
} from "../src/services/credits.js";
import type { Env } from "../src/types.js";

const env = { ENVIRONMENT: "local-dev" } as unknown as Env;
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

describe("credits conservation under concurrency (lost-update witness)", () => {
  it("creditEarnings: N concurrent earns conserve ALL", async () => {
    const agent = uniq("earn");
    const N = 25, amt = 13;
    await Promise.all(Array.from({ length: N }, () => creditEarnings(env, agent, amt)));
    const b = await getBalance(env, agent);
    expect(b).not.toBeNull();
    expect(b!.earned_uc).toBe(N * amt);
    expect(b!.balance_uc).toBe(N * amt);
  });

  it("debitCredits: N concurrent debits never lose a charge (no silent money loss)", async () => {
    const agent = uniq("debit");
    const N = 20, amt = 5;
    await creditEarnings(env, agent, N * amt); // fund exactly N*amt
    await Promise.all(Array.from({ length: N }, () => debitCredits(env, agent, amt)));
    const b = await getBalance(env, agent);
    expect(b!.consumed_uc).toBe(N * amt);
    expect(b!.balance_uc).toBe(0);
  });

  it("grantCredits: idempotent — one grant per agent (preserved)", async () => {
    await initSubsidyPool(env, 1_000_000, 1000);
    const agent = uniq("grant");
    await grantCredits(env, agent);
    await grantCredits(env, agent);
    const b = await getBalance(env, agent);
    expect(b!.granted_uc).toBe(1000);
  });
});
