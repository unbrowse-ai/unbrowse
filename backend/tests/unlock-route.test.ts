/**
 * unlock-route.test — the /v1/unlock reseller's contract, before any payment is presented.
 * Witnesses the two cheap-to-check branches deterministically (no upstream call, no Flex settle):
 *   1. bad/missing url            → 400
 *   2. no X-PAYMENT, wallet set    → 402 carrying the fair-compensation-priced sponsor envelope
 *   3. no X-PAYMENT, no wallet     → 503 (operator misconfigured)
 * The paid path (Flex verify → Base upstream) is covered by base-x402-pay.test + fair-compensation.test.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { unlockRoutes } from "../src/routes/unlock.js";
import type { Env } from "../src/types.js";

function app() {
  const a = new Hono();
  a.route("/v1", unlockRoutes);
  return a;
}
function post(body: unknown, env: Partial<Env>, headers: Record<string, string> = {}) {
  return app().fetch(
    new Request("http://local.test/v1/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env as Env,
  );
}

describe("/v1/unlock", () => {
  it("rejects a missing/invalid url with 400", async () => {
    const r = await post({}, { PAYMENT_RECIPIENT: "Wallet111" });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: { code: string } };
    expect(j.error.code).toBe("bad_request");
  });

  it("returns 503 when no operator wallet is configured", async () => {
    const r = await post({ url: "https://example.com" }, {});
    expect(r.status).toBe(503);
    const j = (await r.json()) as { error: { code: string } };
    expect(j.error.code).toBe("operator_wallet_missing");
  });

  it("returns a 402 priced at upstream cost + the fair-compensation markup", async () => {
    const r = await post(
      { url: "https://example.com" },
      { PAYMENT_RECIPIENT: "Wallet111", UNLOCK_UPSTREAM_COST_USD: "0.01", FAIR_COMPENSATION_BPS: "2000" },
    );
    expect(r.status).toBe(402);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const j = (await r.json()) as {
      error: string;
      accepts: unknown[];
      extra: { fair_compensation_bps: number; passthrough_usd: string; charge_usd: string };
    };
    expect(j.error).toBe("payment_required");
    expect(Array.isArray(j.accepts)).toBe(true);
    // 0.01 upstream + 20% = 0.012 charged to the agent.
    expect(j.extra.passthrough_usd).toBe("0.010000");
    expect(j.extra.charge_usd).toBe("0.012000");
    expect(j.extra.fair_compensation_bps).toBe(2000);
  });
});
