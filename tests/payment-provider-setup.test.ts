/**
 * Wave 1 unit tests for the payment-provider prompt + config helper.
 *
 * Per CLAUDE.md "Never mock in tests" — these hit the real config helper,
 * the real prompt module, and the real filesystem (UNBROWSE_CONFIG_PATH
 * pointed at a tmp dir). The reader / log are injected as test seams
 * (the same pattern cli-setup.ts uses for promptContributionMode).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptPaymentProvider } from "../src/cli-payment-setup";
import { _clearPaymentProviderCacheForTests, getPaymentProviderConfig } from "../src/config/payment-provider";

let tmpDir: string;
const originalPath = process.env.UNBROWSE_CONFIG_PATH;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "unbrowse-payment-test-"));
  process.env.UNBROWSE_CONFIG_PATH = join(tmpDir, "config.json");
  _clearPaymentProviderCacheForTests();
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.UNBROWSE_CONFIG_PATH;
  else process.env.UNBROWSE_CONFIG_PATH = originalPath;
  rmSync(tmpDir, { recursive: true, force: true });
  _clearPaymentProviderCacheForTests();
});

describe("promptPaymentProvider (Wave 1)", () => {
  it("persists pay.sh on choice 1", async () => {
    const logs: string[] = [];
    const result = await promptPaymentProvider({
      readChoice: async () => 1,
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({ choice: 1, provider: "pay_sh" });
    expect(getPaymentProviderConfig().payment.provider).toBe("pay_sh");
    expect(logs.some((l) => l.includes("pay.sh"))).toBe(true);
  });

  it("persists lobster_cash on choice 2", async () => {
    const result = await promptPaymentProvider({
      readChoice: async () => 2,
      log: () => {},
    });
    expect(result?.provider).toBe("lobster_cash");
    expect(getPaymentProviderConfig().payment.provider).toBe("lobster_cash");
  });

  it("persists external_solana on choice 3", async () => {
    const result = await promptPaymentProvider({
      readChoice: async () => 3,
      log: () => {},
    });
    expect(result?.provider).toBe("external_solana");
  });

  it("persists privy_embedded on choice 4", async () => {
    const result = await promptPaymentProvider({
      readChoice: async () => 4,
      log: () => {},
    });
    expect(result?.provider).toBe("privy_embedded");
  });

  it("persists skip on choice 5", async () => {
    const result = await promptPaymentProvider({
      readChoice: async () => 5,
      log: () => {},
    });
    expect(result?.provider).toBe("skip");
  });

  it("returns null on second invocation without force (no re-prompt)", async () => {
    await promptPaymentProvider({ readChoice: async () => 1, log: () => {} });
    const second = await promptPaymentProvider({ readChoice: async () => 2, log: () => {} });
    expect(second).toBeNull();
    expect(getPaymentProviderConfig().payment.provider).toBe("pay_sh");
  });

  it("re-prompts with force=true and overwrites the previous choice", async () => {
    await promptPaymentProvider({ readChoice: async () => 1, log: () => {} });
    const second = await promptPaymentProvider({ readChoice: async () => 4, log: () => {}, force: true });
    expect(second?.provider).toBe("privy_embedded");
    expect(getPaymentProviderConfig().payment.provider).toBe("privy_embedded");
  });

  it("records set_via=setup-prompt by default", async () => {
    await promptPaymentProvider({ readChoice: async () => 1, log: () => {} });
    expect(getPaymentProviderConfig().payment.set_via).toBe("setup-prompt");
  });

  it("records set_via=payment-command when force=true", async () => {
    await promptPaymentProvider({ readChoice: async () => 1, log: () => {}, force: true });
    expect(getPaymentProviderConfig().payment.set_via).toBe("payment-command");
  });
});
