/**
 * Failing-first test for a UNIFIED x402 payment-admission boundary.
 *
 * Today the admission decision is SPLIT across disjoint branches in
 * `src/routes/skills.ts` (priceResult.price_usd > 0 block):
 *
 *   - wallet-signed x402  → `flexPaymentHeader` (X-PAYMENT) → handleFlexPaymentAuthorized
 *                           (skills.ts ~L473) — on-chain settlement, never unified.
 *   - api-key → wallet    → `getKeyFunding` returns `{kind:"wallet"}` which, at the
 *                           admission site (skills.ts ~L417-429), is explicitly NOT
 *                           settled ("Wallet-bound keys are NOT settled here -- they
 *                           continue down the Flex facilitator path"). The bound wallet
 *                           is only resolved later, at PAYOUT time, in
 *                           `services/splits.ts::resolveContributorWallets` (L30-31).
 *                           Only `{kind:"credit"}` keys auto-admit here.
 *   - sponsor             → `maybeSponsor` (middleware/sponsor.ts) — a third branch.
 *
 * VERDICT: there is NO single function admitting "wallet-signed OR api-key→wallet".
 * `getKeyFunding(env, keyId): Promise<KeyFunding | null>` returns the binding but does
 * NOT admit; `subscriptionAdmits` (stripe.ts:259) admits only the Stripe lane;
 * `maybeSponsor` admits only the sponsor lane. They are three disjoint branches and
 * the api-key→wallet payer is never used as a payer at admission — only at payout.
 *
 * This test targets a NOT-YET-EXISTING unified boundary:
 *   `admitPayment(c) => Promise<{
 *      admitted: boolean;
 *      payerWallet: string | null;
 *      lane: "wallet" | "api-key" | "sponsor" | "none";
 *   }>`
 * imported from `../src/middleware/payment-admission`.
 *
 * It MUST fail now (module not found) — do NOT create payment-admission.ts to make
 * it green; that is the next (build) step.
 */

import { describe, expect, test } from "bun:test";

// Intentionally importing a module that does not exist yet (red-first).
// @ts-expect-error — payment-admission.ts is not yet created; this import fails at runtime.
import { admitPayment } from "../src/middleware/payment-admission";

import type { KeyFunding } from "../src/services/keys.js";

// ── Minimal fake Hono Context: just the surfaces admitPayment is expected to read.
// headers + env are enough to drive lane selection.
type FakeCtx = {
  req: { header: (k: string) => string | undefined; url: string };
  env: Record<string, unknown>;
  get: (k: string) => unknown;
  set: (k: string, v: unknown) => void;
};

const WALLET_SIGNED = "WALLeT5ignedPayerwa11et1111111111111111111";
const KEY_BOUND_WALLET = "KEYb0undWa11etPayer2222222222222222222222222";

function makeCtx(opts: {
  headers?: Record<string, string>;
  /** When set, the api-key resolves (via getKeyFunding) to this binding. */
  keyFunding?: KeyFunding | null;
  /** vars pre-seeded on the context (e.g. user_id/agent_id resolved upstream). */
  vars?: Record<string, unknown>;
}): FakeCtx {
  const headers = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const vars = new Map<string, unknown>(Object.entries(opts.vars ?? {}));
  return {
    req: {
      header: (k: string) => headers.get(k.toLowerCase()),
      url: "https://api.unbrowse.ai/v1/skills/demo-skill/execute",
    },
    // The env is where the test seeds the key→funding resolution; the unified
    // admitPayment is expected to resolve the bound wallet through getKeyFunding.
    env: {
      __TEST_KEY_FUNDING__: opts.keyFunding ?? null,
    },
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => {
      vars.set(k, v);
    },
  };
}

describe("unified x402 payment admission (admitPayment)", () => {
  test("1. valid wallet-signed x402 proof → admitted via the wallet lane", async () => {
    const c = makeCtx({
      // A request carrying a valid wallet-signed x402 payment proof. The unified
      // boundary verifies it and reports the signer wallet as the payer-of-record.
      headers: {
        "X-PAYMENT": JSON.stringify({
          scheme: "exact",
          payer: WALLET_SIGNED,
          signature: "0xvalid-signed-proof",
        }),
      },
    });

    const result = await admitPayment(c as never);

    expect(result.admitted).toBe(true);
    expect(result.lane).toBe("wallet");
    expect(result.payerWallet).toBe(WALLET_SIGNED);
  });

  test("2. api-key whose getKeyFunding is {kind:'wallet'} → admitted via the api-key lane, bound wallet pays", async () => {
    const c = makeCtx({
      headers: { Authorization: "Bearer ub_live_keythatwrapsawallet" },
      // The key wraps a wallet: getKeyFunding resolves to a wallet binding. The
      // unified boundary must admit and surface the BOUND wallet as the payer —
      // "the api_key wraps a wallet". (Today this binding is only used at PAYOUT
      // time in splits.ts, never at admission.)
      keyFunding: {
        kind: "wallet",
        wallet: KEY_BOUND_WALLET,
        bound_at: "2026-06-20T00:00:00.000Z",
      },
      vars: { agent_id: "key_123" },
    });

    const result = await admitPayment(c as never);

    expect(result.admitted).toBe(true);
    expect(result.lane).toBe("api-key");
    expect(result.payerWallet).toBe(KEY_BOUND_WALLET);
  });

  test("3. neither a wallet-signed proof nor an api-key → not admitted, lane 'none'", async () => {
    const c = makeCtx({ headers: {} });

    const result = await admitPayment(c as never);

    expect(result.admitted).toBe(false);
    expect(result.lane).toBe("none");
    expect(result.payerWallet).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Adversarial-input hardening. admitPayment is ADMISSION-ONLY — it reads +
// classifies, it never signs/sends/debits — so the only thing to harden is that
// attacker-controlled bytes never get promoted to an admitted payer-of-record.
// ───────────────────────────────────────────────────────────────────────────
describe("admitPayment — adversarial input hardening", () => {
  test("A1a. non-JSON garbage X-PAYMENT header → NOT admitted as wallet (falls through)", async () => {
    const c = makeCtx({ headers: { "X-PAYMENT": "garbage!!! not json {{{" } });

    const result = await admitPayment(c as never);

    expect(result.lane).not.toBe("wallet");
    expect(result.lane).toBe("none");
    expect(result.admitted).toBe(false);
    expect(result.payerWallet).toBeNull();
  });

  test("A1b. JSON-shaped X-PAYMENT with a bogus payer but NO proof material → NOT admitted as a wallet", async () => {
    // The dangerous case: a syntactically-valid JSON header that claims a wallet
    // address but carries no signature/payload/proof. This is just unsigned,
    // attacker-controlled bytes. It MUST NOT be admitted as lane:"wallet" with
    // that bogus address as the payer-of-record.
    const c = makeCtx({
      headers: {
        "X-PAYMENT": JSON.stringify({ scheme: "exact", payer: "ATTACKERc0ntr0lledFakeWa11et9999999999999999" }),
      },
    });

    const result = await admitPayment(c as never);

    expect(result.lane).not.toBe("wallet");
    expect(result.payerWallet).not.toBe("ATTACKERc0ntr0lledFakeWa11et9999999999999999");
    expect(result.lane).toBe("none");
    expect(result.admitted).toBe(false);
    expect(result.payerWallet).toBeNull();
  });

  test("A1c. X-PAYMENT with proof material but blank/whitespace payer → NOT admitted as wallet", async () => {
    const c = makeCtx({
      headers: {
        "X-PAYMENT": JSON.stringify({ scheme: "exact", payer: "   ", signature: "0xdeadbeef" }),
      },
    });

    const result = await admitPayment(c as never);

    expect(result.lane).not.toBe("wallet");
    expect(result.lane).toBe("none");
    expect(result.admitted).toBe(false);
    expect(result.payerWallet).toBeNull();
  });

  test("A1d. X-PAYMENT that is a JSON array (not an object) → NOT admitted as wallet", async () => {
    const c = makeCtx({ headers: { "X-PAYMENT": JSON.stringify(["payer", "x"]) } });

    const result = await admitPayment(c as never);

    expect(result.lane).not.toBe("wallet");
    expect(result.lane).toBe("none");
    expect(result.admitted).toBe(false);
    expect(result.payerWallet).toBeNull();
  });

  test("A2. api-key present but getKeyFunding resolves null (no binding) → lane 'none', not admitted", async () => {
    // A bearer key with no funding binding and no sponsor-eligible agent is not
    // a payer. It must NOT be admitted; lane is "none".
    const c = makeCtx({
      headers: { Authorization: "Bearer ub_live_keywithnobinding" },
      keyFunding: null,
    });

    const result = await admitPayment(c as never);

    expect(result.admitted).toBe(false);
    expect(result.lane).toBe("none");
    expect(result.payerWallet).toBeNull();
  });

  test("A3. api-key kind:'wallet' with an EMPTY wallet string → NOT admitted as a valid payer", async () => {
    const c = makeCtx({
      headers: { Authorization: "Bearer ub_live_corruptwalletbinding" },
      keyFunding: { kind: "wallet", wallet: "", bound_at: "2026-06-20T00:00:00.000Z" },
      // No sponsor-eligible agent_id, so falling through lands on "none" — never
      // returns an admitted blank payerWallet.
    });

    const result = await admitPayment(c as never);

    expect(result.admitted).toBe(false);
    expect(result.payerWallet).not.toBe("");
    expect(result.payerWallet).toBeNull();
    expect(result.lane).toBe("none");
  });

  test("A3b. api-key kind:'wallet' with a WHITESPACE-only wallet string → NOT admitted as a valid payer", async () => {
    const c = makeCtx({
      headers: { Authorization: "Bearer ub_live_corruptwalletbinding2" },
      keyFunding: { kind: "wallet", wallet: "   \t  ", bound_at: "2026-06-20T00:00:00.000Z" },
    });

    const result = await admitPayment(c as never);

    expect(result.admitted).toBe(false);
    expect(result.payerWallet).toBeNull();
    expect(result.lane).toBe("none");
  });

  test("A4. BOTH a valid wallet proof AND an api-key present → deterministic precedence: wallet proof WINS", async () => {
    // Documented precedence (mirrors routes/skills.ts): the wallet-signed
    // X-PAYMENT proof is checked first, so it wins over the api-key binding.
    // Single verdict — the api-key wallet is never surfaced when a proof exists.
    const c = makeCtx({
      headers: {
        "X-PAYMENT": JSON.stringify({
          scheme: "exact",
          payer: WALLET_SIGNED,
          signature: "0xvalid-signed-proof",
        }),
        Authorization: "Bearer ub_live_keythatwrapsawallet",
      },
      keyFunding: { kind: "wallet", wallet: KEY_BOUND_WALLET, bound_at: "2026-06-20T00:00:00.000Z" },
      vars: { agent_id: "key_123" },
    });

    const result = await admitPayment(c as never);

    expect(result.admitted).toBe(true);
    expect(result.lane).toBe("wallet");
    expect(result.payerWallet).toBe(WALLET_SIGNED);
    expect(result.payerWallet).not.toBe(KEY_BOUND_WALLET);
  });
});
