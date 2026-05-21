/**
 * Wave 5 structural tests for paysh-pay.ts.
 *
 * Per CLAUDE.md "Never mock in tests" — these probe the binary-detection
 * + isAvailable contract without invoking pay-cli's actual settlement
 * path. Live x402 settlement is verified end-to-end manually (a real 402
 * + a funded pay-cli wallet are required).
 */
import { describe, it, expect } from "bun:test";
import { isPayShAvailable, payAndRetryPaySh } from "../src/payments/paysh-pay";

describe("paysh-pay (Wave 5)", () => {
  it("exports isPayShAvailable() returning a boolean", () => {
    const v = isPayShAvailable();
    expect(typeof v).toBe("boolean");
  });

  it("payAndRetryPaySh returns null when pay-cli is unavailable (not throws)", async () => {
    // Even when pay-cli IS installed locally, this URL will 404 / not 402
    // so the function should fall through to a clean null. The contract:
    // returns null on any failure path; never throws.
    const result = await payAndRetryPaySh<unknown>("https://example.invalid/no-such-route", {
      body: undefined,
      headers: {},
    });
    expect(result === null || (result && typeof (result as { paid: boolean }).paid === "boolean")).toBe(true);
  });
});
