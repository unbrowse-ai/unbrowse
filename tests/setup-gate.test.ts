// tests/setup-gate.test.ts
// evidence-build unbrowse-payment-gate — setup-registers-or-wallet (AC7),
// setup-lobster-path (AC8). NO MOCKS. Hardened: the prior tests false-greened
// on setup's ALWAYS-present static wallet prose. These tie the terminal state
// to the REAL gate observable (the same structured next_step AC1/AC3 demand),
// so they are RED today for the genuine reason and GREEN only when setup
// truly ends satisfiable. Real runSetup runs (proves no crash); the assertion
// is on the gate, not on static report prose.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../src/runtime/setup.js";
import { checkPaymentRequirement } from "../src/payments/index.js";
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
  process.env.UNBROWSE_SKIP_WALLET_SETUP = "1"; // do not shell out to npx in a test
}

afterEach(() => {
  process.env = { ...origEnv };
});

// AC7 setup-registers-or-wallet — sources: code:src/cli.ts#L1863,
// code:src/runtime/setup.ts#L259, podman:setup-no-gate, podman:install.
describe("setup-registers-or-wallet", () => {
  test("after fresh-machine setup the gate is satisfied OR still enforced+actionable", async () => {
    freshMachine();
    await runSetup({ installBrowser: false }); // real run; proves no crash/hang
    const satisfied = getApiKey() !== "" || checkWalletConfigured().configured;
    // If setup did not produce a satisfiable credential, the gate MUST still
    // refuse a paid route with the structured actionable next_step (real
    // commands) — never silently leave usage open. Today: not satisfied AND
    // next_step is bare prose without commands -> RED.
    if (!satisfied) {
      const r = await checkPaymentRequirement("marketplace:any", "ep-1", {
        price_usd: "0.001",
        wallet_configured: false,
      });
      const blob = JSON.stringify(r);
      expect(r.status).not.toBe("free");
      expect(blob).toMatch(/unbrowse account --register|npx @crossmint\/lobster-cli setup/);
    } else {
      expect(satisfied).toBe(true);
    }
  });
});

// AC8 setup-lobster-path — sources: code:src/runtime/setup.ts#L210,
// code:src/payments/wallet.ts#L95, podman:lobster-reachable.
describe("setup-lobster-path", () => {
  test("the Lobster Cash path is surfaced in the structured gate next_step", async () => {
    freshMachine();
    await runSetup({ installBrowser: false });
    // The lobster provisioning path must be an ACTIONABLE next step in the
    // gate (the structured next_step AC3 demands), not only buried in
    // setup's free-form wallet.message prose (which is always present and
    // thus a false-green). Today next_step is a bare sentence -> RED.
    const r = await checkPaymentRequirement("marketplace:any", "ep-1", {
      price_usd: "0.001",
      wallet_configured: false,
    });
    const ns = (r as { next_step?: unknown }).next_step;
    const text = typeof ns === "string" ? ns : JSON.stringify(ns);
    expect(text).toContain("@crossmint/lobster-cli");
  });
});
