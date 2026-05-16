// tests/payment-gate.test.ts
// evidence-build unbrowse-payment-gate — gate-anon-refused (AC1),
// gate-x402-bypasses-login (AC2), gate-actionable-nextstep (AC3).
// NO MOCKS. Real src/payments + real config fixture. True falsifiers:
// RED on v6.17.0-preview.6 for the genuine reason, GREEN only when the
// account-or-x402 gate is genuinely built. Mirrors tests/payment-wiring.test.ts.
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
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "ubpg-gate-home-"));
  process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "ubpg-gate-cfg-"));
  delete process.env.UNBROWSE_API_KEY;
  delete process.env.LOBSTER_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_ADDRESS;
  delete process.env.UNBROWSE_FREE_TIER;
  delete process.env.UNBROWSE_SKIP_PAYMENT;
  process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";
}

function writeAccountKey(): void {
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

// AC1 gate-anon-refused (TRUE_FALSIFIER, kept). sources:
// code:src/client/index.ts#L561, code:backend/src/middleware/auth.ts#L130,
// podman:resolve-anonymous, podman:setup-no-gate.
describe("gate-anon-refused", () => {
  test("no api key AND no wallet on a paid route is refused with both real paths", async () => {
    freshMachine();
    expect(getApiKey()).toBe("");
    expect(checkWalletConfigured().configured).toBe(false);
    const r = await checkPaymentRequirement("marketplace:any", "ep-1", {
      ...PAID,
      wallet_configured: false,
    });
    expect(r.status).not.toBe("free");
    const blob = JSON.stringify(r);
    expect(blob).toContain("account --register"); // declared src/cli.ts:2545
    expect(blob).toContain("@crossmint/lobster-cli"); // declared src/cli.ts:1900
  });
});

// AC2 gate-x402-bypasses-login (was FALSE_GREEN_HOLE; hardened to a positive
// behavioral falsifier). A registered account key is itself a satisfying
// use-credential: a keyed caller must NOT get the anonymous
// "wallet_not_configured" refusal. sources: code:src/client/index.ts#L642,
// code:backend/src/services/flex.ts#L34, podman:mcp-x402.
describe("gate-x402-bypasses-login", () => {
  test("a registered account key changes the gate decision vs anonymous", async () => {
    freshMachine();
    const anon = await checkPaymentRequirement("marketplace:any", "ep-1", {
      ...PAID,
      wallet_configured: false,
    });
    freshMachine();
    writeAccountKey();
    expect(getApiKey()).not.toBe("");
    const keyed = await checkPaymentRequirement("marketplace:any", "ep-1", {
      ...PAID,
      wallet_configured: false,
    });
    // The gate must OBSERVE the account credential: a keyed caller cannot be
    // handed the same "no wallet configured, set up a wallet" refusal an
    // anonymous caller gets. Today checkPaymentRequirement ignores the key
    // entirely so keyed === anon === wallet_not_configured -> RED.
    expect(keyed.status).not.toBe("wallet_not_configured");
    expect(JSON.stringify(keyed)).not.toBe(JSON.stringify(anon));
  });
});

// AC3 gate-actionable-nextstep (TRUE_FALSIFIER, kept). sources:
// code:src/cli.ts#L1863, podman:setup-no-gate, podman:resolve-anonymous.
describe("gate-actionable-nextstep", () => {
  test("refusal next_step carries a runnable command, not bare prose", async () => {
    freshMachine();
    const r = await checkPaymentRequirement("marketplace:any", "ep-1", {
      ...PAID,
      wallet_configured: false,
    });
    const ns = (r as { next_step?: unknown }).next_step;
    const text = typeof ns === "string" ? ns : JSON.stringify(ns);
    expect(text).toContain("unbrowse");
    expect(text).toMatch(/account --register|@crossmint\/lobster-cli/);
  });
});
