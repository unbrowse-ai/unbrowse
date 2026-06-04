/**
 * Payment-provider choice prompt for `unbrowse setup` and the standalone
 * `unbrowse payment-provider` command.
 *
 * Wave 1 of (internal)
 *
 * Five options:
 *   [1] pay.sh             pay-cli + TouchID + USDC stablecoin (x402 MPP)
 *   [2] lobster.cash       @crossmint/lobster-cli + virtual card + Solana
 *   [3] External Solana    bring your own signer (existing `unbrowse wallet`)
 *   [4] Privy embedded     wallet auto-created on https://unbrowse.ai/account
 *   [5] Skip               free tier (sponsor middleware $1/day/agent)
 *
 * Same shape as promptContributionMode in cli-setup.ts: re-prompt only on
 * force, skip in non-TTY, test seam via `readChoice` injection. The choice
 * is INFORMATIONAL — unbrowse doesn't move funds; each provider's own
 * tool (pay-cli, lobstercash, `unbrowse wallet`, /account) handles key
 * custody. This prompt records the user's stated preference so
 * src/payments/index.ts dispatches to the right path AND so the frontend
 * /account page can mirror the choice on the web side.
 */
import { createInterface } from "node:readline";
import {
  getPaymentProviderConfig,
  setPaymentProviderConfig,
  type PaymentProvider,
} from "./config/payment-provider.js";

export type PaymentProviderChoice = 1 | 2 | 3 | 4 | 5;
export type PaymentChoiceReader = (allowed: PaymentProviderChoice[], dflt: PaymentProviderChoice) => Promise<PaymentProviderChoice>;

const PROVIDER_BY_CHOICE: Record<PaymentProviderChoice, PaymentProvider> = {
  1: "pay_sh",
  2: "lobster_cash",
  3: "external_solana",
  4: "privy_embedded",
  5: "skip",
};

const NEXT_STEP_BY_CHOICE: Record<PaymentProviderChoice, string> = {
  1: "Install pay.sh: https://pay.sh — `npx @pay-sh/cli setup`. Pay.sh prompts TouchID on each paid call; fund the local account with USDC.",
  2: "Install lobster.cash: `npm install -g @crossmint/lobster-cli`, then `lobstercash setup`. Subscription billing tops up a Solana wallet; virtual cards purchase across the web.",
  3: "Add your Solana wallet via `unbrowse wallet`. Top up off-platform; x402 sponsor middleware settles from this address.",
  4: "Sign in at https://unbrowse.ai/account — a Privy embedded Solana wallet is created on first login. The wallet address is bound to your agent automatically (see /v1/auth/privy/start).",
  5: "No setup needed. The sponsor middleware ($1/day/agent + $50/day platform-wide) covers your first paid calls; attach a wallet later via `unbrowse payment-provider`.",
};

async function defaultReadChoice(
  allowed: PaymentProviderChoice[],
  dflt: PaymentProviderChoice,
): Promise<PaymentProviderChoice> {
  const isInteractive = !!process.stdin.isTTY && !!process.stdout.isTTY && process.env.UNBROWSE_NON_INTERACTIVE !== "1";
  if (!isInteractive) return dflt;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Choice [${dflt}]: `, resolve);
      });
      const trimmed = answer.trim();
      if (!trimmed) return dflt;
      const n = parseInt(trimmed, 10);
      if (allowed.includes(n as PaymentProviderChoice)) return n as PaymentProviderChoice;
      console.log(`Please enter ${allowed.join(", ")} (or press Enter for ${dflt}).`);
    }
  } finally {
    rl.close();
  }
}

export interface PromptPaymentProviderOptions {
  /** Re-prompt even if a previous choice was recorded. */
  force?: boolean;
  /** Test seam — inject deterministic choice. */
  readChoice?: PaymentChoiceReader;
  /** Test seam — inject log sink (defaults to console.log). */
  log?: (msg: string) => void;
}

function shouldSkipInteractivePrompt(opts: PromptPaymentProviderOptions): boolean {
  if (opts.readChoice) return false;
  return process.env.UNBROWSE_NON_INTERACTIVE === "1" || !process.stdin.isTTY || !process.stdout.isTTY;
}

/**
 * Returns the chosen option (1-5) and the persisted provider name, or
 * `null` when skipped because the user already picked one and
 * `force=false`. Same skip-on-non-tty pattern as promptContributionMode.
 */
export async function promptPaymentProvider(
  opts: PromptPaymentProviderOptions = {},
): Promise<{ choice: PaymentProviderChoice; provider: PaymentProvider } | null> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const cfg = getPaymentProviderConfig();
  if (!opts.force && cfg.payment.set_via && cfg.payment.set_via !== "default") {
    return null;
  }
  if (shouldSkipInteractivePrompt(opts)) {
    return null;
  }

  log("");
  log("How do you want to pay for premium browsing?");
  log("");
  log("  [1] pay.sh         TouchID + USDC stablecoin (x402 MPP)");
  log("  [2] lobster.cash   Credit card + virtual card + Solana wallet");
  log("  [3] External       Bring your own Solana signer");
  log("  [4] Privy          Embedded wallet (web sign-in)");
  log("  [5] Skip           Free tier (sponsor covers first $1/day/agent)");
  log("");

  const reader = opts.readChoice ?? defaultReadChoice;
  const choice = await reader([1, 2, 3, 4, 5], 5);
  const provider = PROVIDER_BY_CHOICE[choice];
  const set_via = opts.force ? "payment-command" : "setup-prompt";

  setPaymentProviderConfig({ payment: { provider, set_via } });
  log(NEXT_STEP_BY_CHOICE[choice]);

  // Wave 2: best-effort sync to backend so `agent.wallet_provider`
  // reflects the rail the user just picked. Anonymous keys (no account
  // bound yet) silently skip; offline / 5xx surface a single info()
  // line but never fail the prompt. Same envelope as
  // syncContributionPreferenceToServer in cli.ts.
  try {
    const { pushPaymentProvider } = await import("./client/index.js");
    await pushPaymentProvider(provider);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("account_required") || msg.includes("HTTP 403") || msg.includes("HTTP 404")) {
      // Anonymous keys + unmounted route: silent. The local config is
      // still authoritative; backend syncs the next time the user is
      // account-bound (magic-link or Privy sign-in).
    } else {
      log(`Local choice saved, but server sync failed: ${msg}`);
    }
  }

  return { choice, provider };
}
