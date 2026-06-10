/**
 * OWS (Open Wallet Standard) vault + policy units — TEST-SPECS §8 gaps
 * (AC-WAL-1/AC-WAL-2).
 *
 * Hermetic: OWS_HOME points at a temp vault for every test, so this
 * machine's real ~/.ows can never leak into assertions. Covers the
 * declarative policy engine (deny blocks, warn allows + reports, rules
 * AND-combined, expiry honored), vault descriptor parsing in both the
 * spec's camelCase and the CLI's snake_case shapes, and address
 * resolution precedence (env override → eip155-first vault account).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluatePolicy,
  listOwsWallets,
  resolveOwsWalletAddress,
  owsAvailable,
  type OwsPolicy,
  type PolicyContext,
  type WalletDescriptor,
} from "../src/payments/ows";

let vaultHome: string;
let walletsDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vaultHome = mkdtempSync(join(tmpdir(), "ows-test-"));
  walletsDir = join(vaultHome, "wallets");
  mkdirSync(walletsDir, { recursive: true });
  savedEnv.OWS_HOME = process.env.OWS_HOME;
  savedEnv.OWS_WALLET_ADDRESS = process.env.OWS_WALLET_ADDRESS;
  process.env.OWS_HOME = vaultHome;
  delete process.env.OWS_WALLET_ADDRESS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(vaultHome, { recursive: true, force: true });
});

function policy(action: "deny" | "warn", rules: OwsPolicy["rules"]): OwsPolicy {
  return { id: "pol-1", name: "test policy", rules, action };
}

const WALLET: WalletDescriptor = {
  id: "11111111-2222-4333-8444-555555555555",
  accounts: [],
} as unknown as WalletDescriptor;

function ctx(chainId: string, timestamp = "2026-06-10T00:00:00Z"): PolicyContext {
  return { chainId: chainId as PolicyContext["chainId"], wallet: WALLET, timestamp };
}

describe("evaluatePolicy (AC-WAL-2)", () => {
  test("deny policy blocks a chain outside the allowlist, naming the chain", () => {
    const p = policy("deny", [{ type: "allowed_chains", chain_ids: ["eip155:1"] }]);
    const r = evaluatePolicy(p, ctx("solana:mainnet"));
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("solana:mainnet");
  });

  test("deny policy allows a listed chain with no reason attached", () => {
    const p = policy("deny", [{ type: "allowed_chains", chain_ids: ["eip155:1"] }]);
    expect(evaluatePolicy(p, ctx("eip155:1"))).toEqual({ allow: true });
  });

  test("warn policy allows the violating action but surfaces the reason", () => {
    const p = policy("warn", [{ type: "allowed_chains", chain_ids: ["eip155:1"] }]);
    const r = evaluatePolicy(p, ctx("solana:mainnet"));
    expect(r.allow).toBe(true);
    expect(r.reason).toContain("not in allowlist");
  });

  test("expires_at blocks at/after expiry and allows before it", () => {
    const p = policy("deny", [{ type: "expires_at", timestamp: "2026-06-01T00:00:00Z" }]);
    expect(evaluatePolicy(p, ctx("eip155:1", "2026-06-10T00:00:00Z")).allow).toBe(false);
    expect(evaluatePolicy(p, ctx("eip155:1", "2026-05-01T00:00:00Z")).allow).toBe(true);
  });

  test("rules are AND-combined: one failing rule denies even when others pass", () => {
    const p = policy("deny", [
      { type: "allowed_chains", chain_ids: ["eip155:1"] },
      { type: "expires_at", timestamp: "2026-06-01T00:00:00Z" },
    ]);
    const r = evaluatePolicy(p, ctx("eip155:1", "2026-06-10T00:00:00Z"));
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("expired");
  });

  test("empty rule set allows", () => {
    expect(evaluatePolicy(policy("deny", []), ctx("eip155:1"))).toEqual({ allow: true });
  });
});

describe("listOwsWallets vault parsing", () => {
  test("missing vault dir returns [] (never throws)", () => {
    expect(listOwsWallets(join(vaultHome, "nope"))).toEqual([]);
  });

  test("parses valid descriptors; skips corrupt JSON and descriptor-less blobs", () => {
    writeFileSync(
      join(walletsDir, "good.json"),
      JSON.stringify({ id: "w-1", accounts: [{ chain_id: "eip155:1", address: "0xabc" }] }),
    );
    writeFileSync(join(walletsDir, "corrupt.json"), "{ not json");
    writeFileSync(join(walletsDir, "no-descriptor.json"), JSON.stringify({ ciphertext: "..." }));
    const wallets = listOwsWallets(walletsDir);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].id).toBe("w-1");
  });
});

describe("resolveOwsWalletAddress precedence (AC-WAL-1 OWS lane)", () => {
  test("explicit OWS_WALLET_ADDRESS env wins over any vault content", () => {
    process.env.OWS_WALLET_ADDRESS = "0xExplicitOverride";
    writeFileSync(
      join(walletsDir, "w.json"),
      JSON.stringify({ id: "w-1", accounts: [{ chain_id: "eip155:1", address: "0xVault" }] }),
    );
    expect(resolveOwsWalletAddress()).toBe("0xExplicitOverride");
  });

  test("prefers the eip155 account over an earlier non-EVM account (snake_case CLI shape)", () => {
    writeFileSync(
      join(walletsDir, "w.json"),
      JSON.stringify({
        id: "w-1",
        accounts: [
          { chain_id: "solana:mainnet", address: "SoLaNaAddr" },
          { chain_id: "eip155:1", address: "0xEvmAddr" },
        ],
      }),
    );
    expect(resolveOwsWalletAddress()).toBe("0xEvmAddr");
  });

  test("falls back to the first account when no EVM account exists (camelCase spec shape)", () => {
    writeFileSync(
      join(walletsDir, "w.json"),
      JSON.stringify({
        id: "w-1",
        accounts: [{ chainId: "solana:mainnet", address: "SoLaNaOnly" }],
      }),
    );
    expect(resolveOwsWalletAddress()).toBe("SoLaNaOnly");
  });

  test("empty vault resolves to undefined so the caller falls back to the next provider", () => {
    expect(resolveOwsWalletAddress()).toBeUndefined();
  });

  test("owsAvailable reflects the (hermetic) vault home", () => {
    expect(owsAvailable()).toBe(true); // temp OWS_HOME exists
  });
});
