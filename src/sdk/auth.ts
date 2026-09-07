import { ensureLocalWalletAddress } from "../values/signer.js";
import { mergedAuthHeaders as buildMergedAuthHeaders } from "../lib/wallet-auth-headers.js";

/** Published local-wallet signer used by the zero-argument SDK quickstart. */
export async function mergedAuthHeaders(key?: string): Promise<Record<string, string>> {
  ensureLocalWalletAddress();
  return buildMergedAuthHeaders(key ?? process.env.UNBROWSE_API_KEY?.trim());
}
