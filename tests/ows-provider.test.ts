/**
 * Witness: OWS is a usable wallet provider — it resolves a wallet from a real OWS vault
 * layout (~/.ows/wallets/<uuid>.json) and is PREFERRED over lobster.cash in the wallet
 * context. Hermetic: a temp OWS_HOME + injected env.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOwsWallets, resolveOwsWalletAddress, owsAvailable } from "../src/payments/ows.js";
import { getWalletContext } from "../src/payments/wallet.js";

let home: string;
const saved = {
  OWS_HOME: process.env.OWS_HOME,
  OWS_WALLET_ADDRESS: process.env.OWS_WALLET_ADDRESS,
  LOBSTER_WALLET_ADDRESS: process.env.LOBSTER_WALLET_ADDRESS,
  AGENT_WALLET_ADDRESS: process.env.AGENT_WALLET_ADDRESS,
  DISABLE: process.env.UNBROWSE_DISABLE_LOCAL_WALLET,
};

function writeOwsWallet(dir: string): void {
  mkdirSync(join(dir, "wallets"), { recursive: true });
  writeFileSync(
    join(dir, "wallets", "3198bc9c-0000-4000-8000-000000000000.json"),
    JSON.stringify({
      id: "3198bc9c-0000-4000-8000-000000000000",
      name: "agent-treasury",
      createdAt: "2026-03-22T00:00:00Z",
      chainType: "multi",
      accounts: [
        { accountId: "solana:5eykt:7Kz9", address: "7Kz9solanaAddr", derivationPath: "m/44'/501'/0'/0'", chainId: "solana:5eykt" },
        { accountId: "eip155:8453:0xAbCd", address: "0xAbCdEvmAddr", derivationPath: "m/44'/60'/0'/0/0", chainId: "eip155:8453" },
      ],
      metadata: {},
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ows-home-"));
  process.env.OWS_HOME = home;
  delete process.env.OWS_WALLET_ADDRESS;
  delete process.env.LOBSTER_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_ADDRESS;
  delete process.env.UNBROWSE_DISABLE_LOCAL_WALLET;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

test("listOwsWallets reads public descriptors from the vault", () => {
  writeOwsWallet(home);
  const wallets = listOwsWallets(join(home, "wallets"));
  expect(wallets).toHaveLength(1);
  expect(wallets[0].accounts).toHaveLength(2);
  expect(owsAvailable()).toBe(true);
});

test("resolveOwsWalletAddress prefers the EVM account, else the first", () => {
  writeOwsWallet(home);
  expect(resolveOwsWalletAddress()).toBe("0xAbCdEvmAddr"); // eip155 first
});

test("an explicit OWS_WALLET_ADDRESS wins over the vault", () => {
  writeOwsWallet(home);
  process.env.OWS_WALLET_ADDRESS = "ExplicitOwsAddr";
  expect(resolveOwsWalletAddress()).toBe("ExplicitOwsAddr");
});

test("getWalletContext PREFERS OWS over lobster.cash", () => {
  // both an OWS vault wallet AND a lobster env wallet are present
  writeOwsWallet(home);
  process.env.LOBSTER_WALLET_ADDRESS = "LobsterAddr";
  const ctx = getWalletContext();
  expect(ctx.wallet_provider).toBe("ows");
  expect(ctx.wallet_address).toBe("0xAbCdEvmAddr");
});

test("explicit OWS_WALLET_ADDRESS is the wallet context provider", () => {
  process.env.OWS_WALLET_ADDRESS = "OwsPrimary";
  process.env.LOBSTER_WALLET_ADDRESS = "LobsterAddr";
  const ctx = getWalletContext();
  expect(ctx.wallet_provider).toBe("ows");
  expect(ctx.wallet_address).toBe("OwsPrimary");
});

test("no OWS + disabled local wallet → still unconfigured (back-compat)", () => {
  process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";
  const ctx = getWalletContext();
  expect(ctx.wallet_address).toBeUndefined();
});
