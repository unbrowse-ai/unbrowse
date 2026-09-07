/**
 * Flex facilitator instantiation (Day 5, v6.16.0).
 *
 * Wires `createFacilitatorHandler` from
 * `@faremeter/payment-solana/flex/facilitator`. Self-host decision is LOCKED
 * per Day-2 firmament.
 *
 * The underlying Faremeter `FlexFacilitator` exposes the x402 protocol shape:
 *   getSupported / getRequirements / handleVerify / handleSettle / flush /
 *   getHoldManager / stop
 *
 * Our wrapper:
 *   - keeps it lazy (dynamic imports) so cold-start stays light
 *   - caches a single handle per worker isolate
 *   - exposes `verify(payload)` and `settle(holdId, amount)` — thin wrappers
 *     over `handleVerify`/`handleSettle` that the Day-4 route helper already
 *     calls, so route code doesn't have to learn x402's full request shape
 *   - also exposes `handler` for callers (Worker 2 routes) that want the raw
 *     x402 protocol surface
 *   - exposes `flush` / `stop` / `supported` for ops surfaces (admin, scheduled)
 *   - supports DI via `opts.handler` for tests (matches the `payFn` injection
 *     pattern sanctioned in CLAUDE.md / sponsor.ts)
 *
 * TODO Day-6: Use Cloudflare `scheduled` cron trigger to call `flush()` for
 * reliable batch progress. For now, route handlers should
 * `c.executionCtx.waitUntil(handle.flush())` after verify/settle to opportunistically
 * advance the hold manager. The Faremeter `setInterval` flush runs in-process
 * but Worker isolates don't keep timers alive between requests.
 */

import type { Env } from "../types.js";
import { x402UseTestnet } from "../middleware/x402-gate.js";

/** USDC SPL mints per cluster (mirror packages/sdk/src/flex.ts). */
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/**
 * Resolve the Solana network + USDC mint the Flex facilitator should target,
 * from config — NOT a hardcode. The FLEX escrow program
 * (EcfUgNgDXmBx4Xns2qZLE54xpM7V1N6PL8MdDW1syujS) is deployed on DEVNET; it is
 * NOT on mainnet today, so non-production environments must target devnet for
 * settlement to actually succeed. Production keeps mainnet by default (gated by
 * X402_NETWORK_MODE / ENVIRONMENT via `x402UseTestnet`); the cluster name maps
 * to the value `@faremeter/payment-solana`'s `createFacilitatorHandler` expects.
 */
export function resolveFlexNetwork(
  env: Pick<Env, "ENVIRONMENT" | "X402_NETWORK_MODE">,
): { network: "devnet" | "mainnet"; usdcMint: string } {
  return x402UseTestnet(env)
    ? { network: "devnet", usdcMint: USDC_MINT_DEVNET }
    : { network: "mainnet", usdcMint: USDC_MINT_MAINNET };
}

/**
 * Minimal structural type for the Faremeter `FlexFacilitator` runtime
 * contract. Matches the shape returned by `createFacilitatorHandler` (see
 * `/tmp/flex-probe/.../flex/facilitator/handler.d.ts` and handler.js:696-704).
 * Kept structural so we don't have to import the heavy Faremeter type graph
 * at compile time.
 */
export interface FlexFacilitatorHandler {
  getSupported: () => Array<Promise<unknown>>;
  getRequirements: (args: { accepts: unknown[]; resource?: unknown }) => Promise<unknown[]>;
  handleVerify: (
    requirements: unknown,
    payment: unknown,
  ) => Promise<{ isValid: boolean; invalidReason?: string; payer?: string } | null>;
  handleSettle: (
    requirements: unknown,
    payment: unknown,
  ) => Promise<{
    success: boolean;
    transaction: string;
    network: string;
    payer?: string;
    errorReason?: string;
  } | null>;
  flush: () => Promise<
    Array<{ authorizationId: bigint; success: boolean; transaction?: string; error?: string }>
  >;
  stop: () => void;
}

/**
 * The handle returned to the rest of the backend. Wraps the raw Faremeter
 * handler with a payload-shaped verify/settle convenience surface that the
 * route helper already calls.
 */
export interface FlexFacilitatorHandle {
  /** The underlying Faremeter handler — x402 route handlers can consume this directly. */
  handler: FlexFacilitatorHandler;
  /**
   * Verify a Flex payment payload. The payload is the parsed JSON body of
   * the `X-PAYMENT` header. Returns `{ok: true, holdId}` on success (holdId
   * is the authorizationId as a base-10 string — matches the Faremeter
   * convention where `handleSettle` echoes back `transaction =
   * authorizationId.toString()` on the held path). On failure returns
   * `{ok: false, reason}`.
   */
  verify(payload: unknown): Promise<{ ok: boolean; reason?: string; holdId?: string }>;
  /**
   * Settle a previously-verified hold for `actualAmountUc` micro-USDC.
   * `holdId` is the authorizationId returned by `verify`.
   */
  settle(
    holdId: string,
    actualAmountUc: bigint,
  ): Promise<{ ok: boolean; txSignature?: string; reason?: string }>;
  /** Opportunistic flush — call from waitUntil after route work. */
  flush(): Promise<{ submitted: number; finalized: number; results: unknown[] }>;
  /** Tear down (clears Faremeter's setInterval). */
  stop(): Promise<void>;
  /** x402 protocol "what schemes do we support" surface. */
  supported(): Promise<unknown[]>;
}

/**
 * DI seam for tests. When `opts.handler` is provided, we skip the entire
 * Faremeter init (no Solana RPC, no signing, no `@solana/kit` import).
 *
 * Optionally `opts.requirementsForPayload(payload)` lets tests stub the
 * x402-shaped requirements we synthesise from a payload; defaults to a
 * permissive minimal `{}` object that the stubbed handler ignores.
 */
export interface CreateFlexFacilitatorOpts {
  handler?: FlexFacilitatorHandler;
  requirementsForPayload?: (payload: unknown) => Record<string, unknown>;
}

let cachedHandle: FlexFacilitatorHandle | null = null;

/**
 * Decodes a Solana secret key from either a JSON array (Phantom export shape:
 * `"[12,34,...]"`) or a base58 string. Matches the canonical pattern in
 * `services/sponsor-pay.ts` so secrets rotate the same way across the worker.
 */
async function decodeSecretKey(raw: string): Promise<Uint8Array> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty signer secret");
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }
  const { default: bs58 } = (await import("bs58")) as unknown as {
    default: { decode: (s: string) => Uint8Array };
  };
  return Uint8Array.from(bs58.decode(trimmed));
}

/**
 * Lazily-built FlexFacilitator handle. Reuses a single isolate-scoped cache
 * so the in-memory hold manager + slot snapshot persist across requests
 * inside the same worker isolate.
 */
export async function createFlexFacilitator(
  env: Env,
  opts: CreateFlexFacilitatorOpts = {},
): Promise<FlexFacilitatorHandle> {
  if (cachedHandle && !opts.handler) return cachedHandle;

  // Test path — skip Faremeter init entirely.
  if (opts.handler) {
    const handle = adaptHandler(opts.handler, opts.requirementsForPayload);
    cachedHandle = handle;
    return handle;
  }

  const key = env.FLEX_PLATFORM_FACILITATOR_KEY?.trim();
  if (!key) {
    throw new Error("Flex facilitator not configured: FLEX_PLATFORM_FACILITATOR_KEY missing");
  }
  const rpcUrl = env.CASCADE_RPC_URL?.trim();
  if (!rpcUrl) {
    throw new Error("Flex facilitator not configured: CASCADE_RPC_URL missing");
  }
  // createFacilitatorHandler only calls rpc.getSlot / rpc.getLatestBlockhash /
  // rpc.getTokenAccountBalance / rpc.sendTransaction / rpc.getSignatureStatuses.
  // Subscription URL is unused today; we still let Day-6+ wire it for
  // hold-finalization listeners.

  const platformAta = env.FLEX_PLATFORM_RECIPIENT_USDC_ATA?.trim();
  if (!platformAta) {
    throw new Error("Flex facilitator not configured: FLEX_PLATFORM_RECIPIENT_USDC_ATA missing");
  }

  const kit = (await import("@solana/kit")) as unknown as {
    address: (s: string) => unknown;
    createSolanaRpc: (url: string) => unknown;
    createKeyPairSignerFromBytes: (bytes: Uint8Array) => Promise<unknown>;
  };
  const flexFac = (await import("@faremeter/payment-solana/flex/facilitator")) as unknown as {
    createFacilitatorHandler: (
      network: string,
      rpc: unknown,
      signer: unknown,
      config: {
        supportedMints: unknown[];
        defaultSplits: Array<{ recipient: string; bps: number }>;
        maxSubmitRetries?: number;
        submitRetryDelayMs?: number;
        minGracePeriodSlots?: bigint;
        confirmationBufferSlots?: bigint;
        snapshotMaxAgeMs?: number;
        flushIntervalMs?: number;
      },
    ) => Promise<FlexFacilitatorHandler>;
  };

  const rpc = kit.createSolanaRpc(rpcUrl);
  const signer = await kit.createKeyPairSignerFromBytes(await decodeSecretKey(key));

  // Network + USDC mint are config-driven (NOT hardcoded): the FLEX program is
  // deployed on devnet only, so non-production targets devnet where settlement
  // can actually succeed; production keeps mainnet. See `resolveFlexNetwork`.
  const { network, usdcMint } = resolveFlexNetwork(env);

  const handler = await flexFac.createFacilitatorHandler(network, rpc, signer, {
    supportedMints: [kit.address(usdcMint)],
    defaultSplits: [{ recipient: platformAta, bps: 1000 }], // 10% platform default
    maxSubmitRetries: 30,
    submitRetryDelayMs: 1000,
    minGracePeriodSlots: 150n,
    flushIntervalMs: 5000,
  });

  const handle = adaptHandler(handler, opts.requirementsForPayload);
  cachedHandle = handle;
  return handle;
}

/**
 * Build the x402 requirements object that Faremeter's `handleVerify` /
 * `handleSettle` expect. The payload-shaped verify path doesn't carry the
 * requirements separately, so we re-derive them from the payload fields
 * Faremeter actually reads:
 *   - `requirements.scheme` is matched by `isMatchingRequirement` (handler.js:176)
 *   - `requirements.network` is the caip-2 network id
 *   - `requirements.asset` is the mint
 *   - `requirements.amount` is the actual amount to settle (set per call in settle)
 *   - `requirements.payTo` triggers `buildSplits` in `getRequirements` only
 *
 * For verify the only field used is `isMatchingRequirement` (scheme/network/mint),
 * so the minimal valid requirement is `{ scheme: "flex", network, asset: mint }`.
 */
function defaultRequirementsForPayload(payload: unknown): Record<string, unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  // Flex payload carries `payload: { scheme, network, payload: FlexPaymentPayload }`
  // when nested per x402 envelope shape. Be permissive — read whichever shape
  // the caller provided.
  const inner = (p.payload && typeof p.payload === "object" ? p.payload : p) as Record<
    string,
    unknown
  >;
  const mint =
    (inner.mint as string | undefined) ??
    (p.mint as string | undefined) ??
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  return {
    scheme: "flex",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // mainnet caip-2
    asset: mint,
    amount: "0", // overridden by settle; verify ignores amount
    maxTimeoutSeconds: 300,
  };
}

/**
 * Pull the authorizationId out of the payload as a base-10 string. Used as
 * our `holdId`. Mirrors `parseAndVerifyPayload` in handler.js:239-247 which
 * reads `parseResult.authorizationId` via `FlexPaymentPayload(payment.payload)`.
 */
function readAuthorizationIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    p.authorizationId,
    (p.payload as Record<string, unknown> | undefined)?.authorizationId,
    (p.authorization as Record<string, unknown> | undefined)?.authorizationId,
    (p.flexAuthorization as Record<string, unknown> | undefined)?.authorizationId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof c === "number" || typeof c === "bigint") return String(c);
  }
  return undefined;
}

/**
 * Wraps a `FlexFacilitatorHandler` (real or stubbed) in our handle interface.
 * Pure adapter — no Solana, no env.
 */
function adaptHandler(
  handler: FlexFacilitatorHandler,
  requirementsForPayload: (payload: unknown) => Record<string, unknown> = defaultRequirementsForPayload,
): FlexFacilitatorHandle {
  const lastPayloadByHoldId = new Map<string, unknown>();

  return {
    handler,
    verify: async (payload) => {
      try {
        const requirements = requirementsForPayload(payload);
        const r = await handler.handleVerify(requirements, payload);
        if (r === null) return { ok: false, reason: "facilitator_declined" };
        if (!r.isValid) return { ok: false, reason: r.invalidReason ?? "verify_failed" };
        const holdId = readAuthorizationIdFromPayload(payload) ?? "";
        if (holdId) lastPayloadByHoldId.set(holdId, payload);
        return { ok: true, holdId };
      } catch (e) {
        return { ok: false, reason: `verify_threw: ${(e as Error).message}` };
      }
    },
    settle: async (holdId, actualAmountUc) => {
      const payload = lastPayloadByHoldId.get(holdId);
      if (!payload) {
        return { ok: false, reason: "no_pending_hold_for_id" };
      }
      try {
        const requirements = {
          ...requirementsForPayload(payload),
          amount: actualAmountUc.toString(10),
        };
        const r = await handler.handleSettle(requirements, payload);
        if (r === null) return { ok: false, reason: "facilitator_declined" };
        if (!r.success) return { ok: false, reason: r.errorReason ?? "settle_failed" };
        lastPayloadByHoldId.delete(holdId);
        return { ok: true, txSignature: r.transaction };
      } catch (e) {
        return { ok: false, reason: `settle_threw: ${(e as Error).message}` };
      }
    },
    flush: async () => {
      const results = await handler.flush();
      const submitted = results.filter((r) => r.success).length;
      // Faremeter's `flush` submits; finalization is a separate
      // `finalizeReady()` step driven by setInterval inside the handler
      // (see handler.js:618-694). Until we expose finalizeReady, this
      // count stays 0 from our side.
      const finalized = 0;
      return { submitted, finalized, results };
    },
    stop: async () => {
      handler.stop();
      cachedHandle = null;
    },
    supported: async () => {
      const promises = handler.getSupported();
      return Promise.all(promises);
    },
  };
}

/**
 * Reset the isolate-scoped cache. Test-only — production never calls this
 * because the cache is meant to survive across requests in the same isolate.
 */
export function resetFlexFacilitatorCacheForTests(): void {
  cachedHandle = null;
}

export function platformRecipientUsdcAta(env: Env): string {
  const ata = env.FLEX_PLATFORM_RECIPIENT_USDC_ATA?.trim();
  if (!ata) {
    // Common confusion: the base wallet pubkey (e.g. PAYMENT_RECIPIENT) is
    // NOT the right value here. Faremeter Flex pays into the USDC associated
    // token account derived from `<wallet, USDC mint>`. Derive it once with
    // `spl-token address --owner <wallet> --token EPjFWdd5Auf...` and pin
    // the resulting address as `FLEX_PLATFORM_RECIPIENT_USDC_ATA`.
    throw new Error(
      "FLEX_PLATFORM_RECIPIENT_USDC_ATA not set. " +
      "This must be the USDC associated token account of your platform wallet, " +
      "NOT the wallet's base pubkey. Derive via " +
      "`spl-token address --owner <PAYMENT_RECIPIENT> --token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.",
    );
  }
  // Loose validation: USDC ATAs on Solana are 32-byte ed25519-derived
  // addresses, base58-encoded into 32-44 chars. Reject obviously wrong
  // values (e.g. someone pasted a hex eth address or a placeholder).
  if (ata.length < 32 || ata.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(ata)) {
    throw new Error(
      `FLEX_PLATFORM_RECIPIENT_USDC_ATA does not look like a base58 Solana address (got length=${ata.length}). ` +
      "Expected a 32-44 char base58 USDC ATA pubkey.",
    );
  }
  return ata;
}

export function flexRefundTimeoutSlots(env: Env): bigint {
  const raw = env.FLEX_REFUND_TIMEOUT_SLOTS?.trim();
  if (!raw) return 150n; // minimum allowed per Flex spec (~1 min)
  const n = BigInt(raw);
  if (n < 150n) return 150n;
  if (n > 1_296_000n) return 1_296_000n; // max per Flex spec (~6 days)
  return n;
}
