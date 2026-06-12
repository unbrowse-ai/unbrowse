/**
 * pay-sh-e2e — Witness B probe (live sandbox handshake).
 *
 * Drives unbrowse's REAL x402Fetch through the pay.sh adapter against a running
 * `pay --sandbox server demo` gateway. The gateway lifecycle (boot/teardown) is
 * owned by scripts/pay-sh-gate.sh; this probe only asserts the paid result.
 *
 * Exit 0 iff: the indexed pay path returns a paid 200 with sub_state pay_signed.
 * No real funds move — sandbox uses an ephemeral localnet wallet.
 *
 * Env:
 *   PAY_DEMO_URL        metered endpoint to pay (default the demo usage report)
 *   UNBROWSE_PAY_SANDBOX must be 1 (set by the gate)
 */
import { x402Fetch } from "../src/payments/x402-fetch.js";

const url = process.env.PAY_DEMO_URL ?? "http://127.0.0.1:1402/api/v1/reports/usage";

async function main(): Promise<number> {
  // Sanity: the same URL with no payment MUST be 402, else the gateway isn't
  // actually gating and a "pass" would be meaningless.
  const unpaid = await fetch(url).catch((e) => {
    console.error(`E2E: gateway unreachable at ${url}: ${e}`);
    return null;
  });
  if (!unpaid) return 1;
  if (unpaid.status !== 402) {
    console.error(`E2E: expected unpaid 402 from ${url}, got ${unpaid.status}`);
    return 1;
  }

  const { response, trace } = await x402Fetch(url, {}, { adapter: "pay" });
  const body = await response.text();
  const out = {
    status: response.status,
    sub_state: trace.sub_state,
    adapter: trace.adapter,
    body: body.slice(0, 120),
  };
  console.log(JSON.stringify(out));

  if (response.status === 200 && trace.sub_state === "pay_signed" && trace.adapter === "pay") {
    return 0;
  }
  console.error("E2E: pay adapter did NOT produce a paid 200 (pay_signed).");
  return 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`E2E: unexpected error: ${e}`);
  process.exit(1);
});
