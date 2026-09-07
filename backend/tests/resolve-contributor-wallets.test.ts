import { expect, test, mock, afterAll } from "bun:test";
// Capture the real keys module before mocking — mock.module is global and
// mock.restore() does not undo it. Spreading _REAL_KEYS keeps verifyLocalKey/
// getKeyMeta/etc. real (every auth'd route imports them); afterAll re-installs all.
import * as _realKeys from "../src/services/keys.js";
const _REAL_KEYS = { ..._realKeys };

// Witness for the L1->L2 payout fix: resolveContributorWallets must fill a missing
// wallet_address from the agent's key-funding binding, so an agent who attached a wallet
// AFTER publishing earns. Never override a set wallet; only resolve kind:"wallet".

// Mock getKeyFunding: agent "a-funded" has a wallet binding; "a-credit" has credit;
// "a-none" has nothing.
mock.module("../src/services/keys.js", () => ({
  ..._REAL_KEYS,
  getKeyFunding: async (_env: unknown, keyId: string) => {
    if (keyId === "a-funded") return { kind: "wallet", wallet: "WALLET_FUNDED", bound_at: "x" };
    if (keyId === "a-credit") return { kind: "credit", budget_uc: 1000, bound_at: "x" };
    return null;
  },
}));
afterAll(() => { mock.module("../src/services/keys.js", () => _REAL_KEYS); mock.restore(); });

const { resolveContributorWallets } = await import("../src/services/splits.js");
const env = {} as never;
const contrib = (agent_id: string, wallet_address?: string) =>
  ({ agent_id, wallet_address, endpoints_contributed: 1, cumulative_delta: 0, share: 0, first_contributed_at: "x", last_contributed_at: "x" });

test("walletless contributor with a key-funding WALLET binding gets the wallet", async () => {
  const out = await resolveContributorWallets(env, [contrib("a-funded")]);
  expect(out[0].wallet_address).toBe("WALLET_FUNDED");
});

test("an ALREADY-set wallet is never overridden (publish-time wallet wins)", async () => {
  const out = await resolveContributorWallets(env, [contrib("a-funded", "ORIGINAL_WALLET")]);
  expect(out[0].wallet_address).toBe("ORIGINAL_WALLET");
});

test("a credit binding does NOT yield a payout wallet (only kind:wallet)", async () => {
  const out = await resolveContributorWallets(env, [contrib("a-credit")]);
  expect(out[0].wallet_address).toBeUndefined();
});

test("no binding leaves the contributor walletless (unpayable, honestly)", async () => {
  const out = await resolveContributorWallets(env, [contrib("a-none")]);
  expect(out[0].wallet_address).toBeUndefined();
});

// Acceptance #2: resolve + the REAL split math together — a walletless-but-funded
// contributor becomes a PAYABLE recipient (was filtered out at flex.ts:150 → platform).
import { computeFlexSplits } from "../src/services/flex.js";

test("integration: a funded-after-publish contributor earns a real split (not orphaned)", async () => {
  const contributors = [contrib("a-funded")]; // no wallet_address stored
  // WITHOUT resolve: computeFlexSplits filters it out (no wallet) → no contributor split.
  const before = computeFlexSplits({ contributors, owner_compensation_opt_in: false, markup_bps: 0 } as never, "PLATFORM_ATA");
  expect(before.some((s) => s.recipient === "WALLET_FUNDED")).toBe(false);

  // WITH resolve (the fix): the wallet is filled → the contributor is payable to it.
  const resolved = await resolveContributorWallets(env, contributors);
  const after = computeFlexSplits({ contributors: resolved, owner_compensation_opt_in: false, markup_bps: 0 } as never, "PLATFORM_ATA");
  expect(after.some((s) => s.recipient === "WALLET_FUNDED")).toBe(true);
});
