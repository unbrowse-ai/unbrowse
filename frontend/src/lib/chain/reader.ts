/**
 * chain/reader — the website-as-wrapper skin: read on-chain PUBLIC state directly via
 * dep-free Solana JSON-RPC (no backend, no @solana/web3 dependency). Seed-bearing slice
 * of internal/onchain-firmament.md boundary 4. Safe under BOTH architectures (a)/(b):
 * every plan needs the site to read on-chain pointers without a server.
 *
 * MOAT-NO-LEAK INVARIANT (boundary 2): on-chain rows carry pointers + SEALED (encrypted)
 * payloads only. This reader returns raw bytes; it NEVER decrypts. Plaintext route VALUES
 * are decrypted off-chain by the closed substrate, never in the browser.
 */

export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export interface ChainAccount {
  lamports: number;
  owner: string;
  /** [base64-data, "base64"] — SEALED; the reader does not decrypt it. */
  data: [string, string];
  executable: boolean;
}

/** Read one on-chain account's public state. Returns null if the account does not exist. */
export async function getAccountInfo(pubkey: string, rpc: string = DEFAULT_RPC): Promise<ChainAccount | null> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pubkey, { encoding: "base64" }],
    }),
  });
  if (!res.ok) throw new Error(`chain: rpc ${res.status}`);
  const j = (await res.json()) as { result?: { value: ChainAccount | null } };
  return j?.result?.value ?? null;
}

/** Moat-no-leak guard (boundary 2): the browser reader must never surface plaintext route
 * values. On-chain payload data is base64 sealed bytes; decryption happens off-chain only. */
export function isSealedPayload(data: [string, string]): boolean {
  return Array.isArray(data) && data[1] === "base64";
}
