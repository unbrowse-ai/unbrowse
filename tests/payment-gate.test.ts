// tests/payment-gate.test.ts
// evidence-build unbrowse-payment-gate — lanes: gate-anon-refused (AC1),
// gate-x402-bypasses-login (AC2), gate-actionable-nextstep (AC3).
// NO MOCKS. Real src/payments + real config fixture. Failing-first: these
// encode the pass_when from .evidence-build/unbrowse-payment-gate/criteria.md
// and FAIL on v6.17.0-preview.6 because the use-gate does not yet exist.
// Mirrors the no-mock fixture pattern in tests/payment-wiring.test.ts.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPaymentRequirement } from "../src/payments/index.js";
import { checkWalletConfigured } from "../src/payments/wallet.js";
import { getApiKey } from "../src/client/index.js";

const PAID = { price_usd: "0.001" } as const;
const origEnv = { ...process.env };

function freshMachine(): void {
  // A fresh machine: no api key, no wallet, no config dir, no free tier.
  const home = mkdtempSync(path.join(os.tmpdir(), "ubpg-gate-home-"));
  const cfg = mkdtempSync(path.join(os.tmpdir(), "ubpg-gate-cfg-"));
  process.env.HOME = home;
  process.env.UNBROWSE_CONFIG_DIR = cfg;
  delete process.env.UNBROWSE_API_KEY;
  delete process.env.LOBSTER_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_ADDRESS;
  delete process.env.UNBROWSE_FREE_TIER;
  delete process.env.UNBROWSE_SKIP_PAYMENT;
  process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";
}

function writeAccountKey(): void {
  // A really-registered account: a real config.json the client reads.
  const cfg = process.env.UNBROWSE_CONFIG_DIR as string;
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    path.join(cfg, "config.json"),
    JSON.stringify({ api_key: "ubr_realKeyFixture", agent_id: "agent_fixture" }),
  );
}

afterEach(() => {
  process.env = { ...origEnv };
});

// AC1 gate-anon-refused — sources: code:src/client/index.ts#L561,
// code:backend/src/middleware/auth.ts#L130, podman:resolve-anonymous,
// podman:setup-no-gate.
describe("gate-anon-refused", () => {
  test("no api key AND no wallet on a paid route is refused, not served", async () => {
    freshMachine();
    expect(getApiKey()).toBe("");
    expect(checkWalletConfigured().configured).toBe(false);
    const r = await checkPaymentRequirement("marketplace:any", "ep-1", {
      ...PAID,
      wallet_configured: false,
    });
    // Anonymous + unpaid must NOT be a usable/free outcome.
    expect(r.status).not.toBe("free");
    // The refusal must be ACTIONABLE for an agent: it has to surface BOTH
    // satisfiable paths (register an account / fund a wallet) with the
    // product's OWN declared commands, not a single generic sentence.
    const blob = JSON.stringify(r);
    expect(blob).toContain("account --register"); // declared at src/cli.ts:2545
    expect(blob).toContain("@crossmint/lobster-cli"); // declared at src/cli.ts:1900
  });
});

// AC2 gate-x402-bypasses-login — a registered account key is itself a
// satisfying use-credential; the gate must not treat a keyed caller as the
// anonymous case. sources: code:src/client/index.ts#L642,
// code:backend/src/services/flex.ts#L34, podman:mcp-x402.
describe("gate-x402-bypasses-login", () => {
  test("a registered account key is recognized as a use-credential", async () => {
    freshMachine();
    writeAccountKey();
    expect(getApiKey()).not.toBe("");
    const r = await checkPaymentRequirement("marketplace:any", "ep-1", {
      ...PAID,
      wallet_configured: false,
    });
    // With an account credential present the use-gate must not demand
    // registration as a remaining step (they already have an account).
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("account --register");
  });
});

// AC3 gate-actionable-nextstep — sources: code:src/cli.ts#L1863,
// podman:setup-no-gate, podman:resolve-anonymous.
describe("gate-actionable-nextstep", () => {
  test("refusal next_step is structured with concrete suggested_commands", async () => {
    freshMachine();
    const r = await checkPaymentRequirement("marketplace:any", "ep-1", {
      ...PAID,
      wallet_configured: false,
    });
    // pass_when: a structured next_step naming BOTH paths with concrete
    // suggested_commands, not a bare prose sentence. Today next_step is the
    // string "Complete wallet setup before proceeding with this skill
    // execution." — assert it became structured + actionable.
    const ns = (r as { next_step?: unknown }).next_step;
    const text = typeof ns === "string" ? ns : JSON.stringify(ns);
    expect(text).toContain("unbrowse"); // a runnable command, not just prose
    expect(text).toMatch(/account --register|@crossmint\/lobster-cli/);
  });
});
