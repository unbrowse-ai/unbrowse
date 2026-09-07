/**
 * getWalletContext() provider matrix — TEST-SPECS §8 row 1 (AC-WAL-1).
 *
 * The full resolution order, hermetically:
 *   1. OWS — explicit OWS_WALLET_ADDRESS always; vault probe unless
 *      UNBROWSE_DISABLE_LOCAL_WALLET=1
 *   2. LOBSTER_WALLET_ADDRESS env            → "lobster.cash"
 *   3. AGENT_WALLET_ADDRESS (+_PROVIDER) env → generic
 *   4. ~/.lobster/agents.json (map and array shapes; solana > walletAddress
 *      > wallet_address), skipped when the disable flag is set
 *   5. nothing → {}
 *
 * HOME and OWS_HOME point at temp dirs for every test so the developer's
 * real wallets can never leak in (the lesson the registration suite
 * learned the hard way).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWalletContext, checkWalletConfigured } from "../src/payments/wallet";

const ENV_KEYS = [
  "HOME",
  "OWS_HOME",
  "OWS_WALLET_ADDRESS",
  "LOBSTER_WALLET_ADDRESS",
  "AGENT_WALLET_ADDRESS",
  "AGENT_WALLET_PROVIDER",
  "UNBROWSE_DISABLE_LOCAL_WALLET",
] as const;

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wallet-matrix-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = home; // pristine: no ~/.ows, no ~/.lobster
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function seedOwsVault(address: string) {
  const dir = join(home, ".ows", "wallets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "w.json"),
    JSON.stringify({ id: "w-1", accounts: [{ chain_id: "eip155:1", address }] }),
  );
}

function seedLobsterFile(record: object, agents: "map" | "array" = "map") {
  const dir = join(home, ".lobster");
  mkdirSync(dir, { recursive: true });
  const file =
    agents === "map"
      ? { activeAgentId: "a1", agents: { a1: record } }
      : { activeAgentId: "a1", agents: [{ id: "a1", ...record }] };
  writeFileSync(join(dir, "agents.json"), JSON.stringify(file));
}

describe("getWalletContext precedence (AC-WAL-1)", () => {
  test("rank 1: explicit OWS_WALLET_ADDRESS beats every other source", () => {
    process.env.OWS_WALLET_ADDRESS = "0xOws";
    process.env.LOBSTER_WALLET_ADDRESS = "LobsterEnv";
    process.env.AGENT_WALLET_ADDRESS = "AgentEnv";
    seedLobsterFile({ walletAddress: "LobsterFile" });
    expect(getWalletContext()).toEqual({ wallet_address: "0xOws", wallet_provider: "ows" });
  });

  test("rank 1: an OWS vault wallet also beats the lobster env address", () => {
    seedOwsVault("0xVaultWallet");
    process.env.LOBSTER_WALLET_ADDRESS = "LobsterEnv";
    expect(getWalletContext()).toEqual({ wallet_address: "0xVaultWallet", wallet_provider: "ows" });
  });

  test("disable flag skips the vault probe and falls through to lobster env", () => {
    seedOwsVault("0xVaultWallet");
    process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";
    process.env.LOBSTER_WALLET_ADDRESS = "LobsterEnv";
    expect(getWalletContext()).toEqual({
      wallet_address: "LobsterEnv",
      wallet_provider: "lobster.cash",
    });
  });

  test("rank 2: LOBSTER_WALLET_ADDRESS beats AGENT_WALLET_ADDRESS", () => {
    process.env.LOBSTER_WALLET_ADDRESS = "LobsterEnv";
    process.env.AGENT_WALLET_ADDRESS = "AgentEnv";
    expect(getWalletContext().wallet_provider).toBe("lobster.cash");
  });

  test("rank 3: AGENT_WALLET_ADDRESS carries its declared provider", () => {
    process.env.AGENT_WALLET_ADDRESS = "AgentEnv";
    process.env.AGENT_WALLET_PROVIDER = "pay.sh";
    expect(getWalletContext()).toEqual({ wallet_address: "AgentEnv", wallet_provider: "pay.sh" });
  });

  test("rank 4 (map shape): agents.json active agent resolves, solana lane preferred", () => {
    seedLobsterFile({
      walletAddress: "PlainAddr",
      authorizedWallets: { solana: "SolanaAddr" },
    });
    expect(getWalletContext()).toEqual({
      wallet_address: "SolanaAddr",
      wallet_provider: "lobster.cash",
    });
  });

  test("rank 4 (array shape): agent matched by id, walletAddress fallback", () => {
    seedLobsterFile({ walletAddress: "ArrayAddr" }, "array");
    expect(getWalletContext()).toEqual({
      wallet_address: "ArrayAddr",
      wallet_provider: "lobster.cash",
    });
  });

  test("disable flag also skips the agents.json probe → no wallet", () => {
    seedLobsterFile({ walletAddress: "FileAddr" });
    process.env.UNBROWSE_DISABLE_LOCAL_WALLET = "1";
    expect(getWalletContext()).toEqual({});
  });

  test("corrupt agents.json is tolerated → no wallet, no throw", () => {
    const dir = join(home, ".lobster");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agents.json"), "{ not json");
    expect(getWalletContext()).toEqual({});
  });

  test("rank 5: pristine machine resolves to {}", () => {
    expect(getWalletContext()).toEqual({});
  });
});

describe("checkWalletConfigured", () => {
  test("reports configured + provider when a wallet resolves", () => {
    process.env.LOBSTER_WALLET_ADDRESS = "LobsterEnv";
    expect(checkWalletConfigured()).toEqual({ configured: true, provider: "lobster.cash" });
  });

  test("defaults provider to 'unknown' when the source has none", () => {
    process.env.AGENT_WALLET_ADDRESS = "AgentEnv"; // no AGENT_WALLET_PROVIDER
    expect(checkWalletConfigured()).toEqual({ configured: true, provider: "unknown" });
  });

  test("reports not-configured on a pristine machine", () => {
    expect(checkWalletConfigured()).toEqual({ configured: false });
  });
});
