/**
 * chain-resolve — chain-first route resolution via the IQ on-chain ledger.
 *
 * Queries the IQ Solana table for cached resolution records matching an intent.
 * Returns a shortlist in the same shape as the backend /v1/search/resolve response,
 * or null if chain is unconfigured / empty / errors (fail-open to backend).
 *
 * This is the "land" — the dry ground under the resolve path. When the chain has
 * routes, the agent gets them without touching the backend at all.
 */
import { resolutionLedgerFromEnv } from "./iq-ledger.js";

export interface ChainResolveResult {
  source: "chain";
  shortlist: unknown[];
  intent: string;
}

/**
 * Attempt to resolve an intent from the IQ on-chain ledger.
 * Returns null when chain is unconfigured or has no matching records.
 * Never throws — fail-open by design.
 */
export async function chainResolve(
  intent: string,
  opts: { limit?: number; env?: Record<string, string | undefined> } = {},
): Promise<ChainResolveResult | null> {
  try {
    const ledger = await resolutionLedgerFromEnv(opts.env ?? process.env);
    if (!ledger) return null;

    const row = await ledger.find(intent);
    if (!row?.result) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.result);
    } catch {
      return null;
    }

    const limit = opts.limit ?? 10;

    // The result may be a direct shortlist array or a contract value with nested routes.
    // Handle both shapes gracefully.
    let shortlist: unknown[];
    if (Array.isArray(parsed)) {
      shortlist = parsed.slice(0, limit);
    } else if (parsed && typeof parsed === "object" && "shortlist" in parsed && Array.isArray((parsed as { shortlist: unknown[] }).shortlist)) {
      shortlist = (parsed as { shortlist: unknown[] }).shortlist.slice(0, limit);
    } else if (parsed && typeof parsed === "object" && "global_results" in parsed && Array.isArray((parsed as { global_results: unknown[] }).global_results)) {
      shortlist = (parsed as { global_results: unknown[] }).global_results.slice(0, limit);
    } else {
      shortlist = [parsed];
    }

    if (shortlist.length === 0) return null;

    return { source: "chain", shortlist, intent };
  } catch {
    return null;
  }
}
