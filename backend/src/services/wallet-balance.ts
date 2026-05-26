/**
 * wallet-balance — read a Solana wallet's USDC balance via raw JSON-RPC.
 *
 * Used by the /v1/contract/declare auth-first onramp signal: after the
 * server verifies a signed declare, it queries the wallet's USDC balance
 * (via `getTokenAccountsByOwner`) and surfaces the result in the 402
 * envelope's `extra` field so observers (orchestrator + future onramp
 * adapter contracts) know whether the wallet can satisfy the payment.
 *
 * Per SKILL.md "Native onramp is the cloud's obligation": the server
 * notices unfunded pubkeys; the local binary stays minimal. This is the
 * "notice" half — the actual onramp trigger (Privy / Coinbase / Foundry
 * treasury credit) is a follow-up adapter contract that reads this same
 * extra field.
 *
 * Per SKILL.md "Fallbacks are visible, never silent": every degradation
 * path (RPC unconfigured, RPC failed, no token account) returns a typed
 * status so the envelope carries the reason, not an opaque null.
 */

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BS58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("hex string contains non-hex chars");
    out[i] = byte;
  }
  return out;
}

/**
 * Encode 32 raw bytes as a base58 Solana address. Standard Bitcoin/Solana
 * base58 alphabet (no '0', 'O', 'I', 'l'). Leading zero bytes become '1'.
 */
export function bytesToBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let result = "";
  while (num > 0n) {
    result = BS58_ALPHABET[Number(num % 58n)] + result;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) result = "1" + result;
    else break;
  }
  return result;
}

export type WalletBalanceProbe =
  | { status: "found"; micros: string; address: string }
  | { status: "no_token_account"; micros: "0"; address: string }
  | { status: "rpc_unconfigured"; address: string }
  | { status: "rpc_failed"; address: string; error: string }
  | { status: "invalid_pubkey"; address: string };

/**
 * Query the USDC balance (in micros — 6-decimal USDC base units) for the
 * given wallet pubkey. Accepts the hex pubkey form the binary emits in
 * `wallet_identity` (64 hex chars); converts to base58 Solana address
 * internally.
 *
 * Returns a typed status:
 *   - found              → wallet has a USDC token account with `micros` balance
 *   - no_token_account   → wallet exists but holds no USDC ATA (effective balance 0)
 *   - rpc_unconfigured   → CASCADE_RPC_URL not set on this Worker (test / local dev)
 *   - rpc_failed         → RPC returned an error; carries the message
 *   - invalid_pubkey     → wallet_identity didn't parse as 32-byte hex
 *
 * Caller folds these into the 402 envelope's `extra` field so observers
 * see the wallet's funding state alongside the payment requirements.
 */
export async function queryUsdcBalanceMicros(
  env: { CASCADE_RPC_URL?: string },
  walletPubkeyHex: string,
): Promise<WalletBalanceProbe> {
  let address: string;
  try {
    const bytes = hexToBytes(walletPubkeyHex);
    if (bytes.length !== 32) {
      return { status: "invalid_pubkey", address: walletPubkeyHex };
    }
    address = bytesToBase58(bytes);
  } catch {
    return { status: "invalid_pubkey", address: walletPubkeyHex };
  }

  const rpcUrl = env.CASCADE_RPC_URL?.trim();
  if (!rpcUrl) return { status: "rpc_unconfigured", address };

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [
          address,
          { mint: USDC_MINT_MAINNET },
          { encoding: "jsonParsed" },
        ],
      }),
    });
    if (!res.ok) {
      return { status: "rpc_failed", address, error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      result?: {
        value?: Array<{
          account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } };
        }>;
      };
      error?: { message?: string };
    };
    if (json.error) {
      return { status: "rpc_failed", address, error: json.error.message ?? "rpc error" };
    }
    const accounts = json.result?.value ?? [];
    if (accounts.length === 0) {
      return { status: "no_token_account", micros: "0", address };
    }
    // Sum balances across multiple USDC ATAs (rare in practice; usually one).
    let total = 0n;
    for (const a of accounts) {
      try {
        total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
      } catch {
        // Skip malformed entries; the sum still reflects readable accounts.
      }
    }
    return { status: "found", micros: total.toString(10), address };
  } catch (err) {
    return { status: "rpc_failed", address, error: (err as Error).message };
  }
}
