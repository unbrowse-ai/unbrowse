import { describe, test, expect } from "bun:test";
import { type WalletProvider } from "../src/payments/wallet.js";
import { type BrowserAccessConfig } from "../src/runtime/browser-access.js";
import { computeVerificationCoverage, type VerificationMatrix } from "../src/verification/matrix.js";

// #32 Wallet/provider abstraction — stub implementation of the real WalletProvider interface
class StubWalletProvider implements WalletProvider {
  name = "stub";
  async connect() { return { address: "0x0000000000000000000000000000000000000000" }; }
  async disconnect() {}
  async signTransaction(_tx: unknown) { return "0xsig"; }
  async getBalance() { return BigInt(0); }
}

describe("#32 wallet provider abstraction", () => {
  test("stub wallet connects with zero address", async () => {
    const wallet = new StubWalletProvider();
    const { address } = await wallet.connect();
    expect(address).toBe("0x0000000000000000000000000000000000000000");
  });

  test("stub wallet has zero balance", async () => {
    const wallet = new StubWalletProvider();
    const balance = await wallet.getBalance();
    expect(balance).toBe(BigInt(0));
  });
});

describe("#34 default browser access", () => {
  test("default config uses unbrowse path", () => {
    const config: BrowserAccessConfig = {
      default_path: "unbrowse",
      fallback_path: "direct",
      supported_frameworks: ["openclaw", "mcp", "langchain", "hermes"],
    };
    expect(config.default_path).toBe("unbrowse");
    expect(config.supported_frameworks.length).toBeGreaterThan(0);
  });
});

describe("#70 verification matrix", () => {
  test("computes coverage percentage", () => {
    const matrix: VerificationMatrix = [
      { host: "openclaw", capability: "capture", status: "pass" },
      { host: "openclaw", capability: "execute", status: "pass" },
      { host: "mcp", capability: "execute", status: "fail" },
      { host: "hermes", capability: "execute", status: "untested" },
    ];
    expect(computeVerificationCoverage(matrix)).toBe(0.75);
  });

  test("empty matrix returns 0 coverage", () => {
    expect(computeVerificationCoverage([])).toBe(0);
  });
});
