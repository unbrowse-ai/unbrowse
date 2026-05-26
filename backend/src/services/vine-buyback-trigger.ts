/**
 * vine-buyback-trigger — the Malachi storehouse signal.
 *
 * Scheduled job that reads the platform PAYMENT_RECIPIENT USDC ATA
 * balance and emits a structured "buyback:fire" signal when the
 * balance exceeds AIKO_BUYBACK_THRESHOLD_USD. The signal is the
 * substrate-canonical evidence that revenue has accumulated and is
 * ready to be routed into the Voltr/Ranger vault (Bpr49sQX…BX77xBX1)
 * via the Jupiter swap + Voltr depositVaultIx flow that
 * `fdry/scripts/routeRevenue.ts` implements.
 *
 * This job does NOT yet sign+broadcast the actual on-chain
 * transaction. That requires the operator's treasury private key
 * wired as a CF secret (FOUNDRY_TREASURY_KEY) plus the Solana
 * web3/voltr SDK in the Worker bundle. Until that lands as its own
 * focused contract, this job emits the signal so a watching
 * operator (or follow-up automation) can run `routeRevenue.ts`
 * against the surfaced amount.
 *
 * Per SKILL.md doctrine:
 *   - This is the /contract layer of "automated buyback": a standing
 *     scheduled job declared in the Worker, recording the
 *     responsibility to evaluate the threshold on every cron tick.
 *   - The mechanical layer (the actual signed Solana tx) lives in
 *     fdry/scripts/routeRevenue.ts today and will fold into a sibling
 *     "vine-buyback-execute" service when the treasury key is wired.
 *   - Per "Fallbacks are visible, never silent": every degradation
 *     path returns a typed status, never an opaque null.
 *
 * Biblical parallel: Malachi 3:10 — "Bring ye all the tithes into
 * the storehouse, that there may be meat in mine house, and prove
 * me now herewith, saith the LORD of hosts, if I will not open you
 * the windows of heaven, and pour you out a blessing, that there
 * shall not be room enough to receive it." The buyback trigger IS
 * the bringing of the tithe; the blessing (NAV growth) is poured
 * out only on the abiding branches that hold through the next
 * routing.
 */

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Threshold: trigger a buyback when USDC accumulated exceeds this.
// Hardcoded per "no env hatches" doctrine (SKILL.md Public Shape).
// Operator changes by editing this constant + redeploying.
//
// 10 USD = 10_000_000 microUSDC. Below this, the cost of swap+deposit
// fees + Solana network fees outweighs the value being routed.
const AIKO_BUYBACK_THRESHOLD_MICROS = 10_000_000n;

export type BuybackTriggerResult =
  | {
      status: "fire";
      micros: string;
      threshold_micros: string;
      payment_recipient: string;
      timestamp: string;
      note: string;
    }
  | {
      status: "below_threshold";
      micros: string;
      threshold_micros: string;
      payment_recipient: string;
      timestamp: string;
    }
  | {
      status: "payment_recipient_unset";
      timestamp: string;
    }
  | {
      status: "rpc_unconfigured";
      payment_recipient: string;
      timestamp: string;
    }
  | {
      status: "rpc_failed";
      payment_recipient: string;
      timestamp: string;
      error: string;
    };

/**
 * Evaluate whether the platform PAYMENT_RECIPIENT has accumulated
 * enough USDC to warrant a buyback routing. Reads via raw JSON-RPC
 * (Helius via CASCADE_RPC_URL). Returns a typed result; caller logs
 * + may chain to the actual execute job.
 *
 * Reads the recipient address as a wallet pubkey, finds its USDC
 * Associated Token Account via getTokenAccountsByOwner, sums the
 * balances. This handles both "PAYMENT_RECIPIENT is a wallet" and
 * "PAYMENT_RECIPIENT is already an ATA" cases — in the ATA case
 * the owner-lookup yields zero accounts and we fall back to a
 * direct getTokenAccountBalance call.
 */
export async function evaluateBuybackTrigger(env: {
  PAYMENT_RECIPIENT?: string;
  CASCADE_RPC_URL?: string;
}): Promise<BuybackTriggerResult> {
  const timestamp = new Date().toISOString();
  const payment_recipient = env.PAYMENT_RECIPIENT?.trim();
  if (!payment_recipient) {
    return { status: "payment_recipient_unset", timestamp };
  }

  const rpcUrl = env.CASCADE_RPC_URL?.trim();
  if (!rpcUrl) {
    return { status: "rpc_unconfigured", payment_recipient, timestamp };
  }

  // Try direct getTokenAccountBalance first — covers the case where
  // PAYMENT_RECIPIENT is already the USDC ATA (common production
  // shape; see backend/wrangler.toml current value).
  try {
    const balance = await rpcGetTokenAccountBalance(rpcUrl, payment_recipient);
    if (balance !== null) {
      return classify(balance, payment_recipient, timestamp);
    }
  } catch (err) {
    // Fall through to owner-lookup — payment_recipient may be a
    // wallet pubkey rather than an ATA.
    void err;
  }

  // Fallback: PAYMENT_RECIPIENT is a wallet; find its USDC ATA(s)
  // and sum balances.
  try {
    const total = await rpcSumOwnerUsdcBalances(rpcUrl, payment_recipient);
    return classify(total, payment_recipient, timestamp);
  } catch (err) {
    return {
      status: "rpc_failed",
      payment_recipient,
      timestamp,
      error: (err as Error).message,
    };
  }
}

function classify(
  micros: bigint,
  payment_recipient: string,
  timestamp: string,
): BuybackTriggerResult {
  const threshold_micros = AIKO_BUYBACK_THRESHOLD_MICROS.toString(10);
  if (micros >= AIKO_BUYBACK_THRESHOLD_MICROS) {
    return {
      status: "fire",
      micros: micros.toString(10),
      threshold_micros,
      payment_recipient,
      timestamp,
      note:
        "USDC accumulated above threshold. Operator: run `fdry/scripts/routeRevenue.ts` with " +
        `USDC_AMOUNT=${micros.toString(10)} to swap → vault. ` +
        "Automated execute lands when FOUNDRY_TREASURY_KEY is wired as CF secret.",
    };
  }
  return {
    status: "below_threshold",
    micros: micros.toString(10),
    threshold_micros,
    payment_recipient,
    timestamp,
  };
}

async function rpcGetTokenAccountBalance(rpcUrl: string, ata: string): Promise<bigint | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountBalance",
      params: [ata],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { value?: { amount?: string } };
    error?: { message?: string; code?: number };
  };
  if (json.error) {
    // Code -32602 typically means "Invalid param" — could mean address
    // isn't a token account at all (it's a wallet). Signal "null" so
    // the caller falls back to owner-lookup.
    if (json.error.code === -32602) return null;
    throw new Error(json.error.message ?? "rpc error");
  }
  const amount = json.result?.value?.amount;
  if (amount === undefined) return null;
  return BigInt(amount);
}

async function rpcSumOwnerUsdcBalances(rpcUrl: string, owner: string): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint: USDC_MINT_MAINNET }, { encoding: "jsonParsed" }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: {
      value?: Array<{
        account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } };
      }>;
    };
    error?: { message?: string };
  };
  if (json.error) throw new Error(json.error.message ?? "rpc error");
  const accounts = json.result?.value ?? [];
  let total = 0n;
  for (const a of accounts) {
    try {
      total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
    } catch {
      // skip malformed entries; preserve the sum we can compute
    }
  }
  return total;
}
