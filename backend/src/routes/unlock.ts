/**
 * POST /v1/unlock — the x402 web-unblocker RESELLER. The agent pays unbrowse (Solana USDC via
 * Flex) at the upstream cost + the fair-compensation markup; unbrowse fronts a paid web-unblocker
 * (Base x402) and returns the cleared HTML, keeping the margin. The agent never holds a Base
 * wallet, never registers with the vendor, never sees the vendor's quirky payment header.
 *
 * The "private, fair-compensated route engine for the agentic web", applied to unblocking:
 *   - charge side  : Flex x402 (services/flex-route-helpers — same as routes/llm.ts)
 *   - price        : services/fair-compensation (cost + 20% by default)
 *   - pay side     : services/base-x402-pay (Worker viem EIP-3009; holds ONE vendor apiKey)
 *
 * Mirrors routes/llm.ts (the xgate LLM proxy reseller) exactly; only the upstream + pricing differ.
 */
import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { sponsorAcceptsForPriceUsd, handleFlexPaymentAuthorized } from "../services/flex-route-helpers.js";
import { compensateTxCost } from "../services/fair-compensation.js";
import { payUpstreamViaBaseX402 } from "../services/base-x402-pay.js";

type UnlockRouteEnv = { Bindings: Env; Variables: { agent_id?: string; user_id?: string } };
export const unlockRoutes = new Hono<UnlockRouteEnv>();

// Default upstream: 200ok web-unlocker (Base USDC, apiKey+paid — operator holds ONE account).
// Override per deployment with UNLOCK_UPSTREAM_URL / _COST_USD / _APIKEY.
const DEFAULT_UPSTREAM_URL = "https://web-unlocker.200ok.xyz/unlock";
const DEFAULT_UPSTREAM_COST_USD = 0.01;

interface UnlockBody { url?: string; type?: string; js_render?: boolean; [k: string]: unknown }
type UnlockEnv = Env & {
  UNLOCK_UPSTREAM_URL?: string; UNLOCK_UPSTREAM_COST_USD?: string; UNLOCK_UPSTREAM_APIKEY?: string;
  PAYAI_FEEPAYER_PUBKEY?: string;
};

unlockRoutes.post("/unlock", async (c: Context<UnlockRouteEnv>) => {
  const body = (await c.req.json().catch(() => ({}))) as UnlockBody;
  if (!body.url || !/^https?:\/\//i.test(body.url)) {
    return c.json({ error: { code: "bad_request", message: "body.url (http/https) is required" } }, 400);
  }
  const env = c.env as UnlockEnv;
  const upstreamUrl = env.UNLOCK_UPSTREAM_URL?.trim() || DEFAULT_UPSTREAM_URL;
  const passthroughUsd = Number(env.UNLOCK_UPSTREAM_COST_USD) || DEFAULT_UPSTREAM_COST_USD;
  // Fair-compensation engine: agent pays upstream cost + the platform's take.
  const comp = compensateTxCost(passthroughUsd, env);
  const chargeUsd = comp.totalUsd;

  // No payment yet → 402 with the Flex sponsor-accepts envelope (single payee, platform wallet).
  const payment = c.req.header("X-PAYMENT") ?? c.req.header("x-payment");
  if (!payment) {
    const operatorWallet = env.PAYMENT_RECIPIENT ?? "";
    if (!operatorWallet) {
      return c.json({ error: { code: "operator_wallet_missing", message: "PAYMENT_RECIPIENT not configured on this Worker" } }, 503);
    }
    const feePayer = env.PAYAI_FEEPAYER_PUBKEY?.trim();
    const accepts = sponsorAcceptsForPriceUsd(chargeUsd, operatorWallet, feePayer || undefined);
    const required = {
      x402Version: 2,
      error: "payment_required",
      resource: { url: c.req.url, description: `web unlock: ${body.url}`, mimeType: "application/json" },
      accepts,
      facilitator: "faremeter-flex-solana",
      extra: {
        upstream: "web-unlocker",
        fair_compensation_bps: comp.bps,
        passthrough_usd: passthroughUsd.toFixed(6),
        charge_usd: chargeUsd.toFixed(6),
      },
    };
    return c.json(required, 402, { "PAYMENT-REQUIRED": btoa(JSON.stringify(required)) });
  }

  // Payment present → verify+settle via Flex, then front the upstream unblocker and return its HTML.
  return handleFlexPaymentAuthorized(c, payment, {
    executeFn: async () => {
      const upstream = await payUpstreamViaBaseX402(
        upstreamUrl,
        { url: body.url, type: body.type ?? "html", js_render: body.js_render ?? true },
        env,
        { apiKey: env.UNLOCK_UPSTREAM_APIKEY, timeoutMs: 90_000 },
      );
      if (upstream.reason === "no_signer") {
        return c.json({ error: { code: "broker_unconfigured", message: "BASE_X402_SIGNER_KEY not set on this Worker" } }, 503);
      }
      if (!upstream.ok) {
        return c.json({ error: { code: "upstream_unavailable", message: `web-unlocker returned ${upstream.status}` } }, 502);
      }
      const resp = c.json(upstream.json as Record<string, unknown>, 200);
      resp.headers.set("x-unbrowse-charge-usd", chargeUsd.toFixed(6));
      resp.headers.set("x-unbrowse-passthrough-usd", upstream.paidUsd.toFixed(6));
      resp.headers.set("x-unbrowse-compensation-bps", String(comp.bps));
      return resp;
    },
  });
});
