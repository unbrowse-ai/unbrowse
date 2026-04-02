/**
 * x402 payment gating middleware — lobster.cash / Corbits compatible path.
 *
 * Core boundary:
 * - this service describes payment requirements and validates settlement
 * - lobster.cash owns wallet provisioning, signing, and transaction execution
 */

import type { Context } from "hono";

const CORBITS_FACILITATOR_URL = "https://facilitator.corbits.dev";
const VERIFY_TIMEOUT_MS = 5_000;
const SUPPORTED_CACHE_TTL_MS = 5 * 60_000;
const X402_TIMEOUT_SECONDS = 300;
const X402_VERSION = 2 as const;

let supportedKindsCache:
  | {
    expiresAt: number;
    kinds: Array<{
      x402Version: number;
      scheme: string;
      network: string;
      extra?: Record<string, unknown>;
    }>;
  }
  | null = null;

export interface ChainConfig {
  network: string;
  mainnetAsset: string;
  testnetAsset: string;
  mainnet: string;
  testnet: string;
}

export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  solana: {
    network: "solana",
    mainnetAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    testnetAsset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    testnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  },
  base: {
    network: "base",
    mainnetAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    testnetAsset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    mainnet: "eip155:8453",
    testnet: "eip155:84532",
  },
};

export interface X402PaymentRequirementV2 {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface X402PaymentRequiredV2 {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepts: X402PaymentRequirementV2[];
}

interface X402PaymentPayloadV2 {
  x402Version: 2;
  accepted: X402PaymentRequirementV2;
  payload: Record<string, unknown>;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  extensions?: Record<string, unknown>;
}

function safeBase64Encode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.btoa === "function") {
    const bytes = new TextEncoder().encode(data);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    return globalThis.btoa(binary);
  }
  return Buffer.from(data, "utf8").toString("base64");
}

function safeBase64Decode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") {
    const binary = globalThis.atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
  return Buffer.from(data, "base64").toString("utf8");
}

function encodeBase64Json(value: unknown): string {
  return safeBase64Encode(JSON.stringify(value));
}

function decodeBase64Json<T>(value: string): T {
  return JSON.parse(safeBase64Decode(value)) as T;
}

async function fetchSupportedKinds(): Promise<Array<{
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}>> {
  if (supportedKindsCache && supportedKindsCache.expiresAt > Date.now()) {
    return supportedKindsCache.kinds;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const res = await fetch(`${CORBITS_FACILITATOR_URL}/supported`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`supported returned ${res.status}`);
    }

    const body = await res.json() as {
      kinds?: Array<{
        x402Version: number;
        scheme: string;
        network: string;
        extra?: Record<string, unknown>;
      }>;
    };

    supportedKindsCache = {
      expiresAt: Date.now() + SUPPORTED_CACHE_TTL_MS,
      kinds: body.kinds ?? [],
    };
    return supportedKindsCache.kinds;
  } finally {
    clearTimeout(timer);
  }
}

async function getSupportedKindExtra(
  x402Version: number,
  scheme: string,
  network: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const kinds = await fetchSupportedKinds();
    return kinds.find((kind) =>
      kind.x402Version === x402Version
      && kind.scheme === scheme
      && kind.network === network
    )?.extra;
  } catch (err) {
    console.warn(`[x402] failed to load facilitator supported kinds: ${(err as Error).message}`);
    return undefined;
  }
}

export function x402Response(c: Context, terms: X402PaymentRequiredV2) {
  return c.json(terms, 402, {
    "PAYMENT-REQUIRED": encodeBase64Json(terms),
    "X-Payment-Required": JSON.stringify(terms),
  });
}

async function settlePaymentPayload(
  paymentPayload: X402PaymentPayloadV2,
): Promise<{ valid: boolean; degraded: boolean; transaction?: string; settlementHeader?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const res = await fetch(`${CORBITS_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: paymentPayload.x402Version,
        paymentPayload,
        paymentRequirements: paymentPayload.accepted,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return { valid: false, degraded: false };
    }

    return {
      valid: !!body.success,
      degraded: false,
      transaction: (body.transaction ?? body.txHash) as string | undefined,
      settlementHeader: encodeBase64Json(body),
    };
  } catch (err) {
    console.error("[x402] facilitator settlement failed, degrading gracefully:", (err as Error).message);
    return { valid: true, degraded: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a lobster-compatible PAYMENT-SIGNATURE header, or fall back to the
 * old X-Payment-Proof verification path.
 */
export async function verifyX402Proof(
  proof: string,
): Promise<{ valid: boolean; degraded: boolean; transaction?: string; settlementHeader?: string }> {
  try {
    const paymentPayload = decodeBase64Json<X402PaymentPayloadV2>(proof);
    if (paymentPayload?.x402Version === 2 && paymentPayload.accepted) {
      return await settlePaymentPayload(paymentPayload);
    }
  } catch {
    // not a PAYMENT-SIGNATURE payload
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    const res = await fetch(`${CORBITS_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentHeader: proof }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      return {
        valid: !!body.success,
        degraded: false,
        transaction: (body.transaction ?? body.txHash) as string | undefined,
      };
    }

    const res2 = await fetch(`${CORBITS_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof }),
    });

    return { valid: res2.ok, degraded: false };
  } catch (err) {
    console.error("[x402] facilitator verification failed, degrading gracefully:", (err as Error).message);
    return { valid: true, degraded: true };
  }
}

/**
 * Build x402 payment terms for a skill access request.
 *
 * Docs-aligned defaults:
 * - Corbits facilitator
 * - USDC settlement
 * - Solana / Base networks that lobster.cash can actually pay on
 */
export async function buildSkillPaymentTerms(
  priceUsd: number,
  skillId: string,
  recipient: string,
  resource: string,
  options?: {
    recipients?: Record<string, string>;
    chain?: string;
    testnet?: boolean;
  },
): Promise<X402PaymentRequiredV2> {
  const amount = String(Math.max(1, Math.round(priceUsd * 1_000_000)));
  const useTestnet = options?.testnet ?? true;
  const scheme = "exact";

  const buildRequirement = async (
    chainName: string,
    config: ChainConfig,
  ): Promise<X402PaymentRequirementV2> => {
    const network = useTestnet ? config.testnet : config.mainnet;
    const asset = useTestnet ? config.testnetAsset : config.mainnetAsset;
    return {
      scheme,
      network,
      amount,
      asset,
      payTo: options?.recipients?.[chainName] ?? recipient,
      maxTimeoutSeconds: X402_TIMEOUT_SECONDS,
      extra: await getSupportedKindExtra(X402_VERSION, scheme, network),
    };
  };

  if (options?.chain) {
    const chainConfig = SUPPORTED_CHAINS[options.chain];
    if (!chainConfig) throw new Error(`Unsupported chain: ${options.chain}`);
    return {
      x402Version: X402_VERSION,
      error: "Payment Required",
      resource: {
        url: resource,
        description: `Skill access: ${skillId}`,
        mimeType: "application/json",
      },
      accepts: [await buildRequirement(options.chain, chainConfig)],
    };
  }

  const accepts = await Promise.all(
    Object.entries(SUPPORTED_CHAINS).map(([chainName, config]) => buildRequirement(chainName, config)),
  );

  return {
    x402Version: X402_VERSION,
    error: "Payment Required",
    resource: {
      url: resource,
      description: `Skill access: ${skillId}`,
      mimeType: "application/json",
    },
    accepts,
  };
}
