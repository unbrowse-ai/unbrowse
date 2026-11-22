// Gas for members: Unbrowse pays a member node's first writes (Lewis, 18 Nov 2026: "the whole point is to make it
// frictionless, so that we gas our users"). On Arc the gas is USDC, so a node is gassed by sending it a little: the first
// time a member node reads a network through the gateway with less than LOW_WEI there, the gateway sends it DRIP_WEI
// from Unbrowse's gas wallet (the GAS_KEY secret), once a node a network, within DAILY_WEI a network a day.

import { privateKeyToAccount } from "viem/accounts";

/** What a node is sent: 0.10 USDC (Arc's native USDC counts 18 decimals). Its identity's registration is about 0.05. */
export const DRIP_WEI = 10n ** 17n;
/** A node holding less than this (0.05 USDC) on a network is gassed there. */
export const LOW_WEI = 5n * 10n ** 16n;
/** The most the gateway sends a network a day, all nodes together: 20 USDC. */
export const DAILY_WEI = 20n * 10n ** 18n;
/** The least a drip pays a unit of gas: Arc's mempool silently drops anything under 20 gwei. */
export const MIN_FEE_WEI = 25_000_000_000n;

/** What a drip's transaction may use: a plain value transfer. A recipient that needs more (a contract's fallback) fails
 *  at this limit, so the gas wallet pays at most this much a drip. */
export const DRIP_GAS = 21_000n;

/** What a drip counts against the day's budget: the drip and the most its gas can cost at `maxFeePerGas`. */
export function dripCost(maxFeePerGas) {
  return DRIP_WEI + DRIP_GAS * maxFeePerGas;
}

/** The day `nowMs` falls in, as the budget counts days (UTC). */
export function day(nowMs) {
  return Math.floor(nowMs / 86_400_000);
}

/** Why a node isn't gassed, or null when it is: it was sent one on this network already, today's budget can't pay
 *  another, or it holds enough. */
export function withheld({ sentBefore, spentToday, balance, cost = DRIP_WEI }) {
  if (sentBefore) return "already gassed on this network";
  if (spentToday + cost > DAILY_WEI) return "today's gas budget is spent";
  if (balance >= LOW_WEI) return "it holds enough";
  return null;
}

/** The most a unit of gas may cost a drip now: twice the network's price, never under Arc's floor. */
export async function feeCap(rpc) {
  const price = BigInt(await rpc("eth_gasPrice", []));
  return price * 2n > MIN_FEE_WEI ? price * 2n : MIN_FEE_WEI;
}

/** Sends `wei` of native USDC from the gas `key` to `to`, through `rpc(method, params)` on chain `chainId`, and returns
 *  the transaction's hash. `fee` is the `feeCap` already read, so the budget counted the same price. */
export async function send(rpc, key, chainId, to, wei, fee) {
  const account = privateKeyToAccount(key);
  const nonce = Number(BigInt(await rpc("eth_getTransactionCount", [account.address, "pending"])));
  const maxFeePerGas = fee ?? (await feeCap(rpc));
  const raw = await account.signTransaction({
    type: "eip1559",
    chainId,
    nonce,
    to,
    value: wei,
    gas: DRIP_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas: maxFeePerGas / 10n,
  });
  return rpc("eth_sendRawTransaction", [raw]);
}
