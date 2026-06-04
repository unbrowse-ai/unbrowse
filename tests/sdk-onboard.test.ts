/**
 * Witness: identity onboarding resolves account-first, else the local wallet, and reports
 * the right next step. All inputs injected — hermetic, no real env/fs/network.
 */
import { test, expect } from "bun:test";
import { ensureIdentity, onboardingStatus } from "../src/sdk/onboard.js";

test("ensureIdentity prefers a bound account (api key) when present", async () => {
  const id = await ensureIdentity({
    resolveApiKey: () => "ub_live_ABCDEFGH",
    peekWallet: () => "WALLETADDR",
  });
  expect(id.kind).toBe("account");
  expect(id.id).toBe("ub_l…EFGH"); // masked
  expect(id.synced).toBe(true);
});

test("ensureIdentity falls back to the local self-custody wallet", async () => {
  const id = await ensureIdentity({
    resolveApiKey: () => undefined,
    peekWallet: () => "So1anaWa11etAddress",
  });
  expect(id.kind).toBe("wallet");
  expect(id.id).toBe("So1anaWa11etAddress");
  expect(id.synced).toBe(false);
});

test("ensureIdentity syncs the wallet onto an account when a sync is provided", async () => {
  let synced: string | null = null;
  const id = await ensureIdentity({
    resolveApiKey: () => undefined,
    peekWallet: () => "WADDR",
    sync: async (i) => {
      synced = i.id;
    },
  });
  expect(synced).toBe("WADDR");
  expect(id.synced).toBe(true);
});

test("ensureIdentity throws with setup guidance when there is no identity at all", async () => {
  await expect(
    ensureIdentity({ resolveApiKey: () => undefined, peekWallet: () => undefined }),
  ).rejects.toThrow(/unbrowse setup|UNBROWSE_API_KEY/);
});

test("onboardingStatus surfaces the right next step at each stage", () => {
  const account = onboardingStatus({ resolveApiKey: () => "ub_k", peekWallet: () => undefined });
  expect(account.hasAccount).toBe(true);
  expect(account.nextStep).toMatch(/bound account/i);

  const wallet = onboardingStatus({ resolveApiKey: () => undefined, peekWallet: () => "W" });
  expect(wallet.hasWallet).toBe(true);
  expect(wallet.identity?.kind).toBe("wallet");
  expect(wallet.nextStep).toMatch(/register/);

  const none = onboardingStatus({ resolveApiKey: () => undefined, peekWallet: () => undefined });
  expect(none.identity).toBeNull();
  expect(none.nextStep).toMatch(/unbrowse setup/);
});
