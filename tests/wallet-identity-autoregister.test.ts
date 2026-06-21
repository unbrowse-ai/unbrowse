/**
 * Witness (Matt 7:24-25) for wallet-first auto-registration — the pure decision
 * kernel that fixes `authenticated:false despite having a walletPubkey`.
 *
 * Root cause: `walletPubkey` + `agent_id` are pure-local crypto identity (always
 * present), but `ensureUsableKey` only auto-provisioned on a prior CONFIG identity
 * (agent_id / agent_name) — a wallet-holding agent with no config identity got the
 * manual `build register` onboarding hint, and `eval stats` showed authenticated:false.
 *
 * Fix: a present local self-custody wallet IS an established identity (wallet-first,
 * identity model PR #849) — `~/.unbrowse/wallet.json` is minted on first use, so it
 * only exists on a machine unbrowse already provisioned, never a pristine human's
 * first run. So a wallet-holding agent auto-provisions (mint + wallet-bind) instead
 * of dead-ending on onboarding.
 *
 * Pure, deterministic, no network, non-destructive — the firstMintDecision sibling.
 */
import { test, expect } from "bun:test";
import { hasEstablishedIdentity, walletBackfillDecision } from "../src/client/index.ts";

test("hasEstablishedIdentity: a present local wallet is an established identity", () => {
  // The bug case: no config identity, but a wallet exists → must auto-provision.
  expect(hasEstablishedIdentity({ agentId: null, agentName: null, walletAddress: "98768d24…" })).toBe(true);
  // Config identity alone is still an identity (the prior refresh path).
  expect(hasEstablishedIdentity({ agentId: "abc", agentName: null, walletAddress: null })).toBe(true);
  expect(hasEstablishedIdentity({ agentId: null, agentName: "agent@x.com", walletAddress: null })).toBe(true);
  // Truly pristine machine — no wallet, no config: defer to onboarding (no silent ToS).
  expect(hasEstablishedIdentity({ agentId: null, agentName: null, walletAddress: null })).toBe(false);
  expect(hasEstablishedIdentity({})).toBe(false);
  // Empty strings are not identities.
  expect(hasEstablishedIdentity({ agentId: "", agentName: "", walletAddress: "" })).toBe(false);
});

test("walletBackfillDecision: a keyed install with an unbound wallet backfills; bound/keyless/walletless skip", () => {
  // The named gap: already keyed, wallet present, but never bound → backfill it.
  expect(walletBackfillDecision({ localWallet: "98768d24…", hasKey: true, boundWallet: null })).toBe("check-and-bind");
  expect(walletBackfillDecision({ localWallet: "98768d24…", hasKey: true, boundWallet: "other…" })).toBe("check-and-bind");
  // Already bound to THIS wallet → idempotent, no network.
  expect(walletBackfillDecision({ localWallet: "98768d24…", hasKey: true, boundWallet: "98768d24…" })).toBe("skip-already-bound");
  // No key yet → the mint path binds; don't double-handle here.
  expect(walletBackfillDecision({ localWallet: "98768d24…", hasKey: false, boundWallet: null })).toBe("skip-no-key");
  // No local wallet → nothing to bind.
  expect(walletBackfillDecision({ localWallet: null, hasKey: true, boundWallet: null })).toBe("skip-no-wallet");
});
