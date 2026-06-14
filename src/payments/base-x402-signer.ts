/**
 * Base (EVM) x402 signer — the missing rail. pay.sh settles Solana; this settles the EVM "exact"
 * scheme (eip155 USDC) that the Solana wallet can't touch. The x402 "exact" scheme on an EVM chain
 * is an EIP-3009 `transferWithAuthorization`: the payer signs an EIP-712 typed message authorizing
 * a USDC transfer; the facilitator broadcasts it (gasless for the payer). We build the signed
 * X-PAYMENT header from a 402 envelope's `accepts[]` entry, no on-chain tx from our side.
 *
 * Key: ~/.identity/base-x402-key.json ({address, privateKey}, mode 600 — never committed/echoed).
 * Dedicated wallet, funded only with what the operator wants exposed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";
import { resolveSecret } from "../values/keychain.js";

export interface EvmAccept {
  scheme: string; // "exact"
  network: string; // "eip155:8453" | "base" | ...
  amount?: string; // smallest unit (USDC 6dp)
  maxAmountRequired?: string;
  asset: string; // ERC-20 contract (USDC)
  payTo: string; // recipient
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

const KEY_FILE = join(homedir(), ".identity", "base-x402-key.json");
const KEY_SERVICE = "unbrowse-base-x402";
const KEY_ACCOUNT = "default";

/** Read the EVM privateKey from the legacy KEY_FILE (the pre-keychain home). */
function legacyKeyFile(): string | null {
  try {
    const pk = JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey;
    return typeof pk === "string" && pk.length > 0 ? pk : null;
  } catch {
    return null;
  }
}

/** The Base x402 privateKey, from the unified store (migrating the legacy file in). */
function basePrivateKey(): `0x${string}` | null {
  const pk = resolveSecret(KEY_SERVICE, KEY_ACCOUNT, legacyKeyFile);
  return pk ? (pk as `0x${string}`) : null;
}

/** True iff a usable Base x402 key is present (store or legacy file). */
export function baseX402Available(): boolean {
  return !!basePrivateKey();
}

/** The funded Base address (public) — what gets funded, and the `from` of the authorization. */
export function baseX402Address(): string | undefined {
  const pk = basePrivateKey();
  if (pk) {
    try { return privateKeyToAccount(pk).address; } catch { /* fall through */ }
  }
  // Last resort: a legacy file that recorded the address but not a usable key.
  try { return JSON.parse(readFileSync(KEY_FILE, "utf8")).address; } catch { return undefined; }
}

function loadAccount() {
  const pk = basePrivateKey();
  if (!pk) throw new Error("base-x402: no key in the unified store or ~/.identity/base-x402-key.json");
  return privateKeyToAccount(pk);
}

/** eip155 chain id out of the CAIP network string ("eip155:8453" → 8453) or a known alias. */
export function evmChainId(network: string): number | undefined {
  const m = /^eip155:(\d+)$/.exec(network.trim());
  if (m) return Number(m[1]);
  const alias: Record<string, number> = { base: 8453, "base-mainnet": 8453, "base-sepolia": 84532, ethereum: 1, mainnet: 1 };
  return alias[network.trim().toLowerCase()];
}

/** Is this 402 accept an EVM "exact" entry this signer can settle? */
export function isEvmExact(accept: EvmAccept): boolean {
  return accept.scheme === "exact" && evmChainId(accept.network) !== undefined && !!accept.asset && !!accept.payTo;
}

/**
 * Sign an EIP-3009 TransferWithAuthorization for the given EVM `accept` and return the x402
 * X-PAYMENT header value (base64 JSON). `nowSec` is injectable for testing.
 */
export async function buildBaseX402Header(accept: EvmAccept, nowSec: number): Promise<string> {
  const account = loadAccount();
  const chainId = evmChainId(accept.network)!;
  const value = BigInt(accept.amount ?? accept.maxAmountRequired ?? "0");
  const validAfter = 0n;
  const validBefore = BigInt(nowSec + (accept.maxTimeoutSeconds ?? 300));
  // 32-byte random nonce (no Math.random — use crypto via viem's toHex over getRandomValues).
  const rnd = new Uint8Array(32);
  globalThis.crypto.getRandomValues(rnd);
  const nonce = toHex(rnd);

  const domain = {
    name: accept.extra?.name ?? "USD Coin",
    version: accept.extra?.version ?? "2",
    chainId,
    verifyingContract: accept.asset as `0x${string}`,
  } as const;
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;
  const message = {
    from: account.address,
    to: accept.payTo as `0x${string}`,
    value,
    validAfter,
    validBefore,
    nonce: nonce as `0x${string}`,
  };
  const signature = await account.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });

  // x402 "exact" EVM payload (Coinbase x402 scheme). Strings for big ints; network echoed verbatim.
  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: accept.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: accept.payTo,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}
