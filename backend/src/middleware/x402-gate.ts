/**
 * x402 payment gating middleware — lobster.cash / Corbits compatible path.
 *
 * Core boundary:
 * - this service describes payment requirements and validates settlement
 * - lobster.cash owns wallet provisioning, signing, and transaction execution
 */

import type { Context } from "hono";
import type { Env } from "../types.js";

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

export function clearSupportedKindsCacheForTests(): void {
  supportedKindsCache = null;
}

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

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeBase64Encode(data: string): string {
  if (typeof globalThis?.btoa !== "function") throw new Error("base64 encoder unavailable");
  return globalThis.btoa(bytesToBinary(new TextEncoder().encode(data)));
}

function safeBase64Decode(data: string): string {
  if (typeof globalThis?.atob !== "function") throw new Error("base64 decoder unavailable");
  return new TextDecoder("utf-8").decode(binaryToBytes(globalThis.atob(data)));
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

export function paymentsEnabled(env: Pick<Env, "PAYMENTS_ENABLED">): boolean {
  const raw = env.PAYMENTS_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "disabled", "no"].includes(raw);
}

export function searchPaymentsEnabled(
  env: Pick<Env, "PAYMENTS_ENABLED" | "X402_SEARCH_ENABLED">,
): boolean {
  if (!paymentsEnabled(env)) return false;
  const raw = env.X402_SEARCH_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "disabled", "no"].includes(raw);
}

export function x402UseTestnet(
  env: Pick<Env, "ENVIRONMENT" | "X402_NETWORK_MODE">,
): boolean {
  const mode = env.X402_NETWORK_MODE?.trim().toLowerCase();
  if (mode === "mainnet") return false;
  if (mode === "testnet") return true;
  return env.ENVIRONMENT !== "production";
}

interface FacilitatorAttemptResult {
  valid: boolean;
  degraded: boolean;
  transaction?: string;
  settlementHeader?: string;
  definitive?: boolean;
}

/**
 * @deprecated v6.16 — Corbits legacy settle path. Slated for deletion in
 *   Phase 5 (Day-6). New routes verify via the Flex facilitator.
 */
async function settlePaymentPayloadLegacy(
  paymentPayload: X402PaymentPayloadV2,
): Promise<FacilitatorAttemptResult> {
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
      console.warn("[x402] legacy facilitator settle rejected:", body.error ?? body.invalidReason ?? res.status);
      return { valid: false, degraded: false };
    }

    return {
      valid: !!body.success,
      degraded: false,
      transaction: (body.transaction ?? body.txHash) as string | undefined,
      settlementHeader: encodeBase64Json(body),
      definitive: true,
    };
  } catch (err) {
    console.error("[x402] facilitator settlement failed, degrading gracefully:", (err as Error).message);
    return { valid: true, degraded: true, definitive: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @deprecated v6.16 — Corbits facilitator verify+settle for header flow.
 *   Slated for deletion in Phase 5 (Day-6). New routes use the Flex
 *   facilitator's `handleVerify`/`handleSettle` via `handleFlexPaymentAuthorized`.
 */
async function verifyAndSettlePaymentHeader(
  _paymentHeader: string,
  paymentPayload: X402PaymentPayloadV2,
): Promise<FacilitatorAttemptResult> {
  const normalizedPaymentPayload = {
    x402Version: paymentPayload.x402Version,
    scheme: paymentPayload.accepted.scheme,
    network: paymentPayload.accepted.network,
    payload: paymentPayload.payload,
  };
  const paymentRequirements = {
    ...paymentPayload.accepted,
    description: paymentPayload.resource?.description ?? "",
    resource: paymentPayload.resource?.url ?? "",
    maxAmountRequired: paymentPayload.accepted.amount,
    mimeType: paymentPayload.resource?.mimeType,
  };
  const requestBody = {
    x402Version: paymentPayload.x402Version,
    paymentPayload: normalizedPaymentPayload,
    paymentRequirements,
  };

  const verifyRes = await fetch(`${CORBITS_FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  const verifyBody = await verifyRes.json().catch(() => ({})) as Record<string, unknown>;
  if (!verifyRes.ok) {
    console.warn("[x402] facilitator verify rejected header flow:", verifyBody.error ?? verifyBody.invalidReason ?? verifyRes.status);
    return { valid: false, degraded: false, definitive: false };
  }

  const isValid = verifyBody.isValid ?? verifyBody.success;
  if (isValid === false) {
    console.warn("[x402] facilitator verify invalid:", verifyBody.invalidReason ?? verifyBody.error ?? "unknown");
    return { valid: false, degraded: false, definitive: true };
  }

  const settleRes = await fetch(`${CORBITS_FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const settleBody = await settleRes.json().catch(() => ({})) as Record<string, unknown>;
  if (!settleRes.ok || settleBody.success === false) {
    console.warn("[x402] facilitator settle rejected header flow:", settleBody.error ?? settleBody.invalidReason ?? settleRes.status);
    return { valid: false, degraded: false, definitive: true };
  }

  return {
    valid: true,
    degraded: false,
    transaction: (settleBody.transaction ?? settleBody.txHash) as string | undefined,
    settlementHeader: encodeBase64Json(settleBody),
    definitive: true,
  };
}

/**
 * Verify a lobster-compatible PAYMENT-SIGNATURE header, or fall back to the
 * old X-Payment-Proof verification path.
 *
 * @deprecated v6.16 — superseded by `handleFlexPaymentAuthorized` in
 *   `services/flex-route-helpers.ts`. Slated for deletion in Phase 5 (Day-6).
 *   Still wired into the routes' legacy fallback so older clients can settle
 *   while in-flight on the previous Corbits envelope.
 */
export async function verifyX402Proof(
  proof: string,
): Promise<{ valid: boolean; degraded: boolean; transaction?: string; settlementHeader?: string }> {
  try {
    const paymentPayload = decodeBase64Json<X402PaymentPayloadV2>(proof);
    if (paymentPayload?.x402Version === 2 && paymentPayload.accepted) {
      try {
        const headerResult = await verifyAndSettlePaymentHeader(proof, paymentPayload);
        if (headerResult.definitive) return headerResult;
      } catch (err) {
        console.warn("[x402] header flow failed, trying legacy payload flow:", (err as Error).message);
      }
      return await settlePaymentPayloadLegacy(paymentPayload);
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
 * @deprecated v6.16 — superseded by `buildFlexPaymentTerms` (Flex scheme with
 *   native splits). Slated for deletion in Phase 5 (Day-6). Do NOT call from
 *   new code paths; the priced routes (skills, demos, search) have already
 *   migrated to `respondWithFlexTerms` in `services/flex-route-helpers.ts`.
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
