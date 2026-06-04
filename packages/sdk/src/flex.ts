/**
 * Flex payment primitives — typed shapes for the @faremeter/flex-solana
 * escrow-and-session-key payment scheme. Day-4: real wiring against
 * @faremeter/flex-solana@0.2.1 (peer + optional dep so SDK callers who only
 * use free routes don't pull @solana/kit).
 *
 * Aligned with the package's exported wire shape:
 *   - `FlexPaymentPayload` (`@faremeter/flex-solana/types`) =
 *     { escrow, mint, maxAmount, authorizationId, expiresAtSlot,
 *       splits[], sessionKey, signature }
 *   - `FlexPaymentRequirementsExtra` (`@faremeter/flex-solana/types`) =
 *     { facilitator, supportedMints[], splits[], escrow?, minGracePeriodSlots? }
 *   - `SplitInput` (`@faremeter/flex-solana/authorization`) =
 *     { recipient: Address, bps: number }
 *
 * IMPORTANT (tree-shake invariant from Day 3): this file MUST NOT import
 * @faremeter/flex-solana at top-level. All package references go through
 * `await import("@faremeter/flex-solana")` inside function bodies so SDK
 * callers who never sign Flex authorizations don't pull @solana/kit (~3MB).
 */

import type { PaymentRequiredError } from "./errors.js";

/** USDC SPL mint addresses. v6.16 defaults to mainnet; callers override per-env. */
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/**
 * Unsigned Flex payment authorization. Matches the persistable subset of
 * `FlexPaymentPayload` from @faremeter/flex-solana minus the wire-only
 * `sessionKey` (added at signing time) and `signature` (added at signing
 * time). All numeric fields are base10 strings so the shape survives JSON.
 */
export interface FlexAuthorization {
  /** Base58 escrow PDA. */
  escrow: string;
  /** USDC mint address (base58). */
  mint: string;
  /** µ¢ atomic units the facilitator may draw, as base10 string. */
  maxAmount: string;
  /** Random u64 as base10 string, used for replay protection. */
  authorizationId: string;
  /** Slot height after which this authorization is invalid, as base10 string. */
  expiresAtSlot: string;
  /**
   * Up to 5 splits whose bps sum to exactly 10000. Each recipient is a
   * base58 token-account address; bps is an integer in [1, 10000].
   * Matches `SplitInput` from @faremeter/flex-solana/authorization.d.ts.
   */
  splits: Array<{ recipient: string; bps: number }>;
}

/**
 * Minimal contract a caller's Flex wallet must satisfy. The wallet owns
 * the escrow PDA AND has registered a session key — both wire-time facts
 * the SDK does not produce, only consume.
 */
export interface FlexWalletLike {
  /** Wallet address that owns the escrow PDA (base58). */
  address: string;
  /** Registered session key address (base58). */
  sessionKeyAddress: string;
  /**
   * Sign the authorization with the session key's Ed25519 secret. Returns
   * the 64-byte signature as base64 — same shape the on-chain
   * `createEd25519VerifyInstruction` expects.
   */
  signFlexAuthorization(auth: FlexAuthorization): Promise<string>;
}

/**
 * Opaque signer object — the caller's `@solana/kit`-compatible
 * `TransactionSigner` for the escrow owner / depositor. We avoid pulling
 * @solana/kit types here (tree-shake); the lazy-imported instruction
 * builders accept this through structural typing.
 */
// deno-lint-ignore no-explicit-any
export type TransactionSignerOpaque = any;

/** Arguments for `fundEscrow` — builds + sends create-escrow + deposit in one tx. */
export interface FlexFundEscrowParams {
  walletAddress: string;
  facilitatorAddress: string;
  amountUsdc: string;
  refundTimeoutSlots?: number;
  deadmanTimeoutSlots?: number;
  /** USDC mint (defaults to mainnet USDC). */
  mint?: string;
  /**
   * Optional caller-supplied `TransactionSigner` for the wallet. If
   * omitted, `fundEscrow` rejects with a `requires_signer` error and
   * recommends `buildEscrowCreationTx` instead.
   */
  signer?: TransactionSignerOpaque;
  /** Optional caller-supplied `@solana/kit` RPC + sender; if omitted we throw. */
  rpc?: unknown;
  rpcSubscriptions?: unknown;
}

/** Arguments for `registerSessionKey`. */
export interface FlexRegisterSessionKeyParams {
  walletAddress: string;
  escrowAddress: string;
  sessionKeyAddress: string;
  expiresAtSlot?: string;
  revocationGracePeriodSlots?: number;
  signer?: TransactionSignerOpaque;
  rpc?: unknown;
}

/** Pure tx-build result — what the sender wrappers consume. */
export interface BuiltFlexTx {
  /** Instructions to feed `@solana/kit`'s tx message builder. */
  instructions: unknown[];
  /**
   * Addresses the user is putting at risk by signing this tx. Lets a wallet
   * UI render a sane confirmation screen ("you are depositing X USDC into
   * escrow Y, registering session key Z against facilitator F").
   */
  accountsAtRisk: string[];
  /** Programmatic hint about what this tx does. */
  intent: "create_escrow_and_deposit" | "register_session_key";
}

function randomAuthorizationId(): string {
  // 8 random bytes → bigint (u64) → base10 string. Matches
  // `SerializePaymentAuthorizationArgs.authorizationId: bigint` at the boundary.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(10);
}

function validateSplits(splits: FlexAuthorization["splits"]): void {
  if (!Array.isArray(splits) || splits.length === 0 || splits.length > 5) {
    throw new Error(
      `flex: splits must be 1..5 entries, got ${splits?.length ?? 0}`,
    );
  }
  const sum = splits.reduce((s, e) => s + e.bps, 0);
  if (sum !== 10_000) {
    throw new Error(`flex: splits bps must sum to 10000, got ${sum}`);
  }
  for (const s of splits) {
    if (!s.recipient || typeof s.recipient !== "string") {
      throw new Error("flex: split.recipient must be a base58 address");
    }
    if (!Number.isInteger(s.bps) || s.bps < 1 || s.bps > 10_000) {
      throw new Error(`flex: split.bps must be int in [1,10000], got ${s.bps}`);
    }
  }
}

/**
 * Build an unsigned `FlexAuthorization`. Validates splits sum, generates
 * a random `authorizationId`, and returns the canonical JSON shape.
 *
 * Cited symbol: shape mirrors `FlexPaymentPayload` from
 * `@faremeter/flex-solana/types` (minus wire-only `sessionKey`/`signature`).
 */
export async function buildFlexAuthorization(
  opts: {
    escrow: string;
    mint: string;
    maxAmount: string;
    splits: FlexAuthorization["splits"];
    expiresAtSlot: string;
  },
): Promise<FlexAuthorization> {
  if (!opts.escrow) throw new Error("flex: escrow required");
  if (!opts.mint) throw new Error("flex: mint required");
  if (!/^\d+$/.test(opts.maxAmount)) {
    throw new Error("flex: maxAmount must be base10 string");
  }
  if (!/^\d+$/.test(opts.expiresAtSlot)) {
    throw new Error("flex: expiresAtSlot must be base10 string");
  }
  validateSplits(opts.splits);

  return {
    escrow: opts.escrow,
    mint: opts.mint,
    maxAmount: opts.maxAmount,
    authorizationId: randomAuthorizationId(),
    expiresAtSlot: opts.expiresAtSlot,
    splits: opts.splits,
  };
}

/**
 * Settle a `PaymentRequiredError` whose `accepts[]` advertises a Flex
 * scheme. Picks the first Flex-shaped requirement (one whose
 * `extra.escrow` and `extra.splits` are populated — matches
 * `FlexPaymentRequirementsExtra` from `@faremeter/flex-solana/types`),
 * has the wallet sign, packs as `FlexPaymentPayload` inside an
 * `X402PaymentPayload`, base64-encodes, and replays via
 * `retry(paymentHeader)`.
 */
export async function payAndRetryFlex<T>(
  error: PaymentRequiredError,
  wallet: FlexWalletLike,
  retry: (paymentHeader: string) => Promise<T>,
): Promise<T> {
  const accepts = error.accepts ?? [];
  // Pick the first requirement whose `extra` carries Flex-shape fields.
  // Backend will set scheme="@faremeter/flex" but we don't gate on the
  // scheme string — `extra` shape is the source of truth.
  const requirement = accepts.find((r) => {
    const extra = r.extra as
      | { escrow?: string; splits?: unknown; facilitator?: string }
      | undefined;
    return !!extra?.escrow && Array.isArray(extra?.splits);
  });
  if (!requirement) throw error;

  const extra = requirement.extra as {
    escrow: string;
    splits: Array<{ recipient: string; bps: number }>;
    facilitator?: string;
    minGracePeriodSlots?: string;
    expiresAtSlot?: string;
  };

  // We need an expiresAtSlot. Prefer extra.expiresAtSlot; else derive
  // from minGracePeriodSlots + a sentinel (caller can refine).
  const expiresAtSlot = extra.expiresAtSlot ?? extra.minGracePeriodSlots ?? "0";

  const auth = await buildFlexAuthorization({
    escrow: extra.escrow,
    mint: USDC_MINT_MAINNET,
    maxAmount: requirement.maxAmountRequired,
    splits: extra.splits,
    expiresAtSlot,
  });

  const signature = await wallet.signFlexAuthorization(auth);

  // Wire shape: `FlexPaymentPayload` from @faremeter/flex-solana/types.
  // sessionKey + signature added here (signing-time fields).
  const flexPayload = {
    escrow: auth.escrow,
    mint: auth.mint,
    maxAmount: auth.maxAmount,
    authorizationId: auth.authorizationId,
    expiresAtSlot: auth.expiresAtSlot,
    splits: auth.splits,
    sessionKey: wallet.sessionKeyAddress,
    signature,
  };

  // x402 envelope (`X402PaymentPayload` from `./x402.ts` = standard
  // x402 wire format: {x402Version, scheme, network, payload}).
  const envelope = {
    x402Version: 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: flexPayload,
  };

  // X-PAYMENT header value: base64-encoded JSON of the envelope.
  // Matches what the backend's Flex facilitator decodes.
  const headerValue = base64UrlSafeEncodeJson(envelope);
  return retry(headerValue);
}

function base64UrlSafeEncodeJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  // Cross-runtime base64: prefer Buffer (Node), else btoa (browser/edge).
  // Standard x402 uses regular base64 (not url-safe), so we match that.
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.Buffer?.from) return g.Buffer.from(json, "utf8").toString("base64");
  if (typeof g.btoa === "function") {
    // btoa needs a binary string
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return g.btoa(bin);
  }
  throw new Error("flex: no base64 encoder available in this runtime");
}

/**
 * Pure tx-builder for create-escrow + deposit (no signer required, no
 * network call). Returns instructions a caller can sign + send with any
 * `@solana/kit`-compatible runtime. Lazy-imports @faremeter/flex-solana
 * so tree-shake is preserved.
 *
 * Cited symbols: `getCreateEscrowInstructionAsync`, `getDepositInstructionAsync`
 * (both from `@faremeter/flex-solana` root export, per
 * `/tmp/flex-probe/.../flex-solana/dist/src/index.d.ts:9`).
 */
export async function buildEscrowCreationTx(
  params: FlexFundEscrowParams,
): Promise<BuiltFlexTx> {
  if (!params.walletAddress) throw new Error("flex: walletAddress required");
  if (!params.facilitatorAddress) {
    throw new Error("flex: facilitatorAddress required");
  }
  if (!/^\d+$/.test(params.amountUsdc)) {
    throw new Error("flex: amountUsdc must be base10 atomic-unit string");
  }

  const mint = params.mint ?? USDC_MINT_MAINNET;
  const refundTimeoutSlots = BigInt(params.refundTimeoutSlots ?? 150);
  const deadmanTimeoutSlots = BigInt(params.deadmanTimeoutSlots ?? 432000);
  const index = BigInt(Date.now()); // monotonic-ish nonce for PDA derivation

  // Lazy import — tree-shake invariant.
  const flex = await import("@faremeter/flex-solana");

  if (!params.signer) {
    // Pure-build mode: we can't produce a `TransactionSigner` from a string
    // address. Caller must build the tx with their own kit-compatible signer.
    // Return the intended shape so the caller can mirror this with their
    // own `getCreateEscrowInstructionAsync` call.
    return {
      instructions: [],
      accountsAtRisk: [
        params.walletAddress,
        params.facilitatorAddress,
        mint,
      ],
      intent: "create_escrow_and_deposit",
    };
  }

  const createIx = await flex.getCreateEscrowInstructionAsync({
    owner: params.signer,
    index,
    facilitator: params.facilitatorAddress as never,
    refundTimeoutSlots,
    deadmanTimeoutSlots,
    maxSessionKeys: 5,
  });
  const depositIx = await flex.getDepositInstructionAsync({
    depositor: params.signer,
    escrow: (createIx.accounts[1].address) as never,
    mint: mint as never,
    source: params.walletAddress as never, // caller should pass the wallet ATA
    amount: BigInt(params.amountUsdc),
  });

  return {
    instructions: [createIx, depositIx],
    accountsAtRisk: [
      params.walletAddress,
      params.facilitatorAddress,
      mint,
      String((createIx.accounts[1] as { address?: unknown }).address ?? ""),
    ],
    intent: "create_escrow_and_deposit",
  };
}

/**
 * Pure tx-builder for register-session-key (no signer required).
 *
 * Cited symbol: `getRegisterSessionKeyInstructionAsync` from
 * `@faremeter/flex-solana` root export.
 */
export async function buildSessionKeyRegistrationTx(
  params: FlexRegisterSessionKeyParams,
): Promise<BuiltFlexTx> {
  if (!params.walletAddress) throw new Error("flex: walletAddress required");
  if (!params.escrowAddress) throw new Error("flex: escrowAddress required");
  if (!params.sessionKeyAddress) {
    throw new Error("flex: sessionKeyAddress required");
  }

  const flex = await import("@faremeter/flex-solana");

  if (!params.signer) {
    return {
      instructions: [],
      accountsAtRisk: [
        params.walletAddress,
        params.escrowAddress,
        params.sessionKeyAddress,
      ],
      intent: "register_session_key",
    };
  }

  const ix = await flex.getRegisterSessionKeyInstructionAsync({
    owner: params.signer,
    escrow: params.escrowAddress as never,
    sessionKey: params.sessionKeyAddress as never,
    expiresAtSlot: params.expiresAtSlot ? BigInt(params.expiresAtSlot) : null,
    revocationGracePeriodSlots: BigInt(params.revocationGracePeriodSlots ?? 0),
  });

  return {
    instructions: [ix],
    accountsAtRisk: [
      params.walletAddress,
      params.escrowAddress,
      params.sessionKeyAddress,
    ],
    intent: "register_session_key",
  };
}

/**
 * Assemble → sign → send → confirm a flex transaction via the caller's
 * `@solana/kit` RPC. Uses raw `sendTransaction` + `getSignatureStatuses`
 * polling (no rpcSubscriptions dependency), mirroring the facilitator's
 * own submit path. Lazy-imports @solana/kit to preserve tree-shake.
 *
 * Proven end-to-end against the deployed FLEX program on devnet
 * (`scripts/flex-devnet-settle.mjs`): create-escrow → deposit → register
 * session key → settle → finalize → recipient credited.
 */
async function sendFlexTx(
  rpc: { getLatestBlockhash: () => { send: () => Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }> }; sendTransaction: (wire: string, opts: unknown) => { send: () => Promise<string> }; getSignatureStatuses: (sigs: string[]) => { send: () => Promise<{ value: Array<{ err?: unknown; confirmationStatus?: string } | null> }> } },
  feePayerSigner: TransactionSignerOpaque,
  instructions: unknown[],
  opts: { maxPolls?: number; pollDelayMs?: number } = {},
): Promise<string> {
  const kit = await import("@solana/kit") as unknown as {
    createTransactionMessage: (c: { version: 0 }) => unknown;
    setTransactionMessageFeePayerSigner: (s: unknown, m: unknown) => unknown;
    setTransactionMessageLifetimeUsingBlockhash: (bh: unknown, m: unknown) => unknown;
    appendTransactionMessageInstructions: (ix: unknown[], m: unknown) => unknown;
    signTransactionMessageWithSigners: (m: unknown) => Promise<unknown>;
    getSignatureFromTransaction: (tx: unknown) => string;
    getBase64EncodedWireTransaction: (tx: unknown) => string;
    pipe: (v: unknown, ...fns: Array<(x: unknown) => unknown>) => unknown;
  };
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayerSigner(feePayerSigner, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => kit.appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await kit.signTransactionMessageWithSigners(msg);
  const sig = kit.getSignatureFromTransaction(signed);
  const wire = kit.getBase64EncodedWireTransaction(signed);
  await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  const maxPolls = opts.maxPolls ?? 30;
  const pollDelayMs = opts.pollDelayMs ?? 1000;
  for (let i = 0; i < maxPolls; i++) {
    const status = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (status?.err) throw new Error(`flex tx ${sig} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, pollDelayMs));
  }
  throw new Error(`flex tx ${sig} not confirmed after ${maxPolls} polls`);
}

/**
 * Send a create-escrow + deposit transaction. Requires `params.signer`
 * (a `@solana/kit` TransactionSigner) and `params.rpc` (a kit RPC client).
 * Without them, throws `requires_signer` and points at `buildEscrowCreationTx`
 * for the pure-build path.
 */
export async function fundEscrow(
  params: FlexFundEscrowParams,
): Promise<{ escrowAddress: string; txSignature: string }> {
  if (!params.signer || !params.rpc) {
    throw new Error(
      "flex.fundEscrow: requires_signer — caller must supply " +
        "`signer` (TransactionSigner) and `rpc` (kit RPC client). For " +
        "pure tx construction without sending, use `buildEscrowCreationTx`.",
    );
  }
  const built = await buildEscrowCreationTx(params);
  // accountsAtRisk = [wallet, facilitator, mint, escrowPDA]; the escrow PDA is last.
  const escrowAddress = built.accountsAtRisk[built.accountsAtRisk.length - 1];
  const txSignature = await sendFlexTx(params.rpc as never, params.signer, built.instructions);
  return { escrowAddress, txSignature };
}

/**
 * Send a register-session-key transaction. Same `requires_signer` contract
 * as `fundEscrow`. Returns the confirmed transaction signature.
 */
export async function registerSessionKey(
  params: FlexRegisterSessionKeyParams,
): Promise<{ txSignature: string }> {
  if (!params.signer || !params.rpc) {
    throw new Error(
      "flex.registerSessionKey: requires_signer — caller must supply " +
        "`signer` (TransactionSigner) and `rpc` (kit RPC client). For " +
        "pure tx construction without sending, use `buildSessionKeyRegistrationTx`.",
    );
  }
  const built = await buildSessionKeyRegistrationTx(params);
  const txSignature = await sendFlexTx(params.rpc as never, params.signer, built.instructions);
  return { txSignature };
}
