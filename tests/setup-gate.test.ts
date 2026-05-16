// tests/setup-gate.test.ts
// evidence-build unbrowse-payment-gate — lanes: setup-registers-or-wallet
// (AC7), setup-lobster-path (AC8). NO MOCKS. Real src/runtime/setup runSetup
// in a temp HOME. Failing-first: encodes the criteria.md pass_when and FAILS
// on v6.17.0-preview.6 where setup ends silent signed_in:no wallet:none.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../src/runtime/setup.js";
import { checkWalletConfigured } from "../src/payments/wallet.js";
import { getApiKey } from "../src/client/index.js";

const origEnv = { ...process.env };

function freshMachine(): void {
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "ubpg-setup-home-"));
  process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "ubpg-setup-cfg-"));
  delete process.env.UNBROWSE_API_KEY;
  delete process.env.LOBSTER_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_ADDRESS;
  process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";
  // Do not let setup shell out to `npx @crossmint/lobster-cli` in a test;
  // we are asserting the GATE/terminal-state behavior, not lobster itself.
  process.env.UNBROWSE_SKIP_WALLET_SETUP = "1";
}

afterEach(() => {
  process.env = { ...origEnv };
});

// AC7 setup-registers-or-wallet — sources: code:src/cli.ts#L1863,
// code:src/runtime/setup.ts#L259, podman:setup-no-gate, podman:install.
describe("setup-registers-or-wallet", () => {
  test("fresh-machine setup does not finish silently unsatisfiable", async () => {
    freshMachine();
    const report = await runSetup({ installBrowser: false });
    const accountPresent = getApiKey() !== "";
    const walletPresent = checkWalletConfigured().configured;
    // pass_when: setup ends at a satisfiable gate (account OR wallet) OR it
    // surfaces the unmet gate with an actionable next step. It must NOT be a
    // silent clean no-op while resolve/execute remain open anonymously.
    const blob = JSON.stringify(report);
    const surfacesGate =
      /account --register|@crossmint\/lobster-cli|payment|wallet required|register/i.test(blob);
    expect(accountPresent || walletPresent || surfacesGate).toBe(true);
  });
});

// AC8 setup-lobster-path — sources: code:src/runtime/setup.ts#L210,
// code:src/payments/wallet.ts#L95, podman:lobster-reachable.
describe("setup-lobster-path", () => {
  test("setup surfaces the Lobster Cash wallet-provisioning path", async () => {
    freshMachine();
    const report = await runSetup({ installBrowser: false });
    const blob = JSON.stringify(report);
    // The product's own declared wallet-provisioning command (src/cli.ts:1900)
    // must be surfaced as the wallet onboarding next step.
    expect(blob).toContain("@crossmint/lobster-cli");
  });
});
