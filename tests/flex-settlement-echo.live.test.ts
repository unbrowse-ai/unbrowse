// tests/flex-settlement-echo.live.test.ts
// no-mock-echo-falsifier lane. Live round-trip against the x402.payai.network
// instant-refund echo. Guarded FLEX_SETTLEMENT_LIVE=1 (default describe.skip),
// mirroring backend/tests/analytics-api.live.test.ts. NO MOCKS: a real 402
// from prod -> settleViaFlex -> facilitator echo -> settled+retried success.
import { describe, expect, test } from "bun:test";
import { settleViaFlex } from "../src/payments/flex-pay.js";

const LIVE = process.env.FLEX_SETTLEMENT_LIVE === "1";
const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe("flex settlement — live x402.payai.network echo (no mock)", () => {
  test("a real 402 settles + retries to success via the echo", async () => {
    // Drive a real paid execute against prod with no payment header to get a
    // genuine Flex 402, then settleViaFlex through the configured facilitator
    // pointed at the x402.payai.network instant-refund echo
    // (UNBROWSE_X402_FACILITATOR=https://x402.payai.network for this run).
    const api = process.env.UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai";
    const res = await fetch(`${api}/v1/skills/marketplace:any/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint_id: "x", params: {} }),
    });
    expect(res.status).toBe(402);
    const terms = res.headers.get("PAYMENT-REQUIRED");
    expect(terms).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(terms as string, "base64").toString());
    const settled = await settleViaFlex(`${api}/v1/skills/marketplace:any/execute`, decoded, { body: { endpoint_id: "x", params: {} } });
    expect(settled).not.toBeNull();
    expect((settled as { settled?: true })?.settled).toBe(true);
  });
});
