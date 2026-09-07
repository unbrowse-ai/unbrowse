/**
 * Worker-side Base/EVM x402 PAY client — lets the backend FRONT a paid upstream (web-unblocker,
 * paid API) on an agent's behalf, then resell it at cost + fair-compensation (services/
 * fair-compensation.ts). This is the missing leg of the reseller: the backend already RECEIVES
 * x402 from agents (Flex facilitator) and prices with the fair-comp engine; this lets it PAY the
 * upstream too.
 *
 * Runs in a Cloudflare Worker: viem is isomorphic (pure-JS @noble signing — no Node fs/crypto),
 * so EIP-712 `TransferWithAuthorization` (the x402 "exact" EVM scheme = EIP-3009, gasless for us)
 * signs fine in-Worker. The signer key is a Worker SECRET (`BASE_X402_SIGNER_KEY`), never a file.
 *
 * Transport: handles BOTH x402 header conventions seen in the wild — the challenge in a base64
 * `payment-required` header (paysponge/agentcash style) AND/OR a JSON body `accepts[]`; the signed
 * payload echoed in BOTH `X-PAYMENT` and `PAYMENT-SIGNATURE` (200ok uses the latter). An optional
 * per-upstream apiKey header is forwarded when configured (some vendors, e.g. 200ok, gate on
 * apiKey+paid — operator holds ONE account; agents never see the key).
 */
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";

export interface EvmAccept {
  scheme: string; // "exact"
  network: string; // "eip155:8453" | "base"
  amount?: string;
  maxAmountRequired?: string;
  asset: string; // USDC contract
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

export interface BaseX402PayEnv {
  /** 0x-prefixed EVM private key (Worker secret) for the platform's brokering wallet. */
  BASE_X402_SIGNER_KEY?: string;
}

/** Is a Base brokering key configured? (No key → the backend cannot front Base upstreams.) */
export function baseX402SignerAvailable(env: BaseX402PayEnv): boolean {
  const k = env.BASE_X402_SIGNER_KEY?.trim();
  return !!k && /^0x[0-9a-fA-F]{64}$/.test(k);
}

export function evmChainId(network: string): number | undefined {
  const m = /^eip155:(\d+)$/.exec(network.trim());
  if (m) return Number(m[1]);
  const alias: Record<string, number> = { base: 8453, "base-mainnet": 8453, "base-sepolia": 84532, ethereum: 1, mainnet: 1 };
  return alias[network.trim().toLowerCase()];
}

export function isEvmExact(a: EvmAccept): boolean {
  return a.scheme === "exact" && evmChainId(a.network) !== undefined && !!a.asset && !!a.payTo;
}

/** Sign an EIP-3009 TransferWithAuthorization for `accept` and return the base64 x402 payload
 *  (the value for X-PAYMENT / PAYMENT-SIGNATURE). `nowSec` injectable for testing. */
export async function buildBaseX402Header(accept: EvmAccept, env: BaseX402PayEnv, nowSec: number): Promise<string> {
  const key = env.BASE_X402_SIGNER_KEY!.trim() as `0x${string}`;
  const account = privateKeyToAccount(key);
  const chainId = evmChainId(accept.network)!;
  const value = BigInt(accept.amount ?? accept.maxAmountRequired ?? "0");
  const validBefore = BigInt(nowSec + (accept.maxTimeoutSeconds ?? 300));
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const nonce = toHex(rnd);

  const domain = {
    name: accept.extra?.name ?? "USD Coin",
    version: accept.extra?.version ?? "2",
    chainId,
    verifyingContract: accept.asset as `0x${string}`,
  } as const;
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
  } as const;
  const message = { from: account.address, to: accept.payTo as `0x${string}`, value, validAfter: 0n, validBefore, nonce: nonce as `0x${string}` };
  const signature = await account.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });

  return btoa(JSON.stringify({
    x402Version: 1,
    scheme: "exact",
    network: accept.network,
    payload: {
      signature,
      authorization: { from: account.address, to: accept.payTo, value: value.toString(), validAfter: "0", validBefore: validBefore.toString(), nonce },
    },
  }));
}

/** Pull the EVM accepts[] out of a 402: base64 `payment-required` header, or a JSON body `accepts`. */
async function parse402Accepts(res: Response): Promise<EvmAccept[]> {
  const hdr = res.headers.get("payment-required") || res.headers.get("x-payment-required");
  if (hdr) {
    try { const d = JSON.parse(atob(hdr.trim())); if (Array.isArray(d?.accepts)) return d.accepts; } catch { /* fall through */ }
  }
  try { const j = await res.clone().json() as { accepts?: EvmAccept[] }; if (Array.isArray(j?.accepts)) return j.accepts; } catch { /* not json */ }
  return [];
}

export interface UpstreamPayResult {
  ok: boolean;
  status: number;
  json: unknown;
  /** Raw upstream USD cost actually paid (from the accept amount), for the fair-comp ledger. */
  paidUsd: number;
  reason?: "no_signer" | "no_evm_accept" | "upstream_error" | "still_402";
}

/**
 * Front a Base x402 upstream: POST (unpaid) → on 402, sign the EVM accept and retry with the
 * signed header → return the paid JSON. Gasless for us (facilitator settles). The caller prices
 * the agent at `compensateTxCost(result.paidUsd)`.
 */
export async function payUpstreamViaBaseX402(
  url: string,
  body: unknown,
  env: BaseX402PayEnv,
  opts: { apiKey?: string; apiKeyHeader?: string; timeoutMs?: number; nowSec?: () => number } = {},
): Promise<UpstreamPayResult> {
  if (!baseX402SignerAvailable(env)) return { ok: false, status: 0, json: null, paidUsd: 0, reason: "no_signer" };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers[opts.apiKeyHeader ?? "x-api-key"] = opts.apiKey;
  const payload = JSON.stringify(body);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);

  let res = await fetch(url, { method: "POST", headers, body: payload, signal });
  let paidUsd = 0;
  if (res.status === 402) {
    const evm = (await parse402Accepts(res)).find(isEvmExact);
    if (!evm) return { ok: false, status: 402, json: null, paidUsd: 0, reason: "no_evm_accept" };
    const amountUc = Number(evm.amount ?? evm.maxAmountRequired ?? "0");
    paidUsd = amountUc / 1_000_000;
    const nowSec = (opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
    const signed = await buildBaseX402Header(evm, env, nowSec);
    res = await fetch(url, {
      method: "POST",
      // Echo the signed payload in both header conventions — vendors differ (200ok: PAYMENT-SIGNATURE).
      headers: { ...headers, "X-PAYMENT": signed, "PAYMENT-SIGNATURE": signed },
      body: payload,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (res.status === 402) return { ok: false, status: 402, json: null, paidUsd, reason: "still_402" };
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, json, paidUsd, reason: res.ok ? undefined : "upstream_error" };
}
