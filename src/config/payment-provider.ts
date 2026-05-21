/**
 * Payment-provider config (5-option prompt: pay.sh / lobster.cash /
 * external Solana / Privy embedded / skip).
 *
 * Wave 1 of .claude/add-a-payment-provider-choice-prompt-to-unbrowse.
 *
 * Sits alongside src/config/contribution.ts (which handles share-pointers
 * + rev-share opt-in). Contribution-mode controls the SUPPLY side
 * (do we publish captured routes back to the marketplace?). Payment-
 * provider controls the DEMAND side (which payment rail settles when
 * an agent calls a paid endpoint?). They are orthogonal: a user can
 * be in Private contribution mode AND have a Privy embedded wallet
 * for paying premium APIs, or in Share+earn AND have lobster.cash as
 * their settlement rail.
 *
 * The choice is informational + routing: unbrowse itself never holds
 * funds. pay.sh / lobster.cash / external-wallet / Privy each manage
 * their own keys; this file just records the user's stated preference
 * so src/payments/index.ts dispatches to the right path AND so the
 * frontend /account page can mirror the same choice on the web side.
 *
 * Lives at ~/.unbrowse/config.json under a `payment` key (separate
 * from contribution.* so the two can be re-prompted independently).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function configPath(): string {
  return process.env.UNBROWSE_CONFIG_PATH || path.join(os.homedir(), ".unbrowse", "config.json");
}

export type PaymentProvider =
  | "pay_sh"
  | "lobster_cash"
  | "external_solana"
  | "privy_embedded"
  | "skip";

export interface PaymentProviderConfig {
  payment: {
    provider: PaymentProvider;
    set_at?: string;
    set_via?: "setup-prompt" | "payment-command" | "default";
  };
}

const DEFAULT: PaymentProviderConfig = {
  payment: {
    provider: "skip",
    set_via: "default",
  },
};

let cached: PaymentProviderConfig | null = null;

function readConfigFile(): Record<string, unknown> {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfigFile(merged: Record<string, unknown>): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
}

export function getPaymentProviderConfig(): PaymentProviderConfig {
  if (cached) return cached;
  const raw = readConfigFile();
  const payment = (raw.payment as PaymentProviderConfig["payment"] | undefined) ?? DEFAULT.payment;
  cached = { payment };
  return cached;
}

export function setPaymentProviderConfig(next: Partial<PaymentProviderConfig>): void {
  const raw = readConfigFile();
  const current = getPaymentProviderConfig();
  const merged: Record<string, unknown> = {
    ...raw,
    payment: {
      ...current.payment,
      ...(next.payment ?? {}),
      set_at: new Date().toISOString(),
    },
  };
  writeConfigFile(merged);
  cached = { payment: merged.payment as PaymentProviderConfig["payment"] };
}

export function _clearPaymentProviderCacheForTests(): void {
  cached = null;
}
