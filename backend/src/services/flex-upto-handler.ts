/**
 * Three-recipient Flex split wiring for the `createUptoHandler` x402-v2
 * Hono entrypoint. Closes contract 1a80cffd
 * (DEFERRED-FAREMETER-FLEX-SPLITS-IMPL).
 *
 * The shape mandated by docs/public/primitives/07-fair-split-and-claim.md:
 *
 *   defaultSplits: [
 *     { recipient: indexerWalletATA,                bps: indexerBps },
 *     { recipient: domainWalletATA ?? globalHoldATA, bps: domainBps },
 *     { recipient: platformWalletATA,               bps: platformBps },
 *   ]
 *   // indexerBps + domainBps + platformBps === 10000
 *
 * Recipient resolution:
 *   - indexerWalletATA: top-cumulative-delta contributor's
 *     `wallet_address`, normalised through `mergeSplits` so the three
 *     recipients stay distinct on-chain.
 *   - domainWalletATA: read `domain-wallet:<host>` binding from statsKV
 *     (set by routes/claim.ts on a verified DNS-TXT claim). When absent
 *     OR the domain has an `domain-optout:<host>` row, fall back to
 *     `FLEX_GLOBAL_HOLD_USDC_ATA` (the global holding wallet's USDC ATA).
 *   - platformWalletATA: `FLEX_PLATFORM_RECIPIENT_USDC_ATA` env binding.
 *
 * Bps derivation:
 *   - Reuses `computeFlexSplits` from services/flex.ts which already encodes
 *     the paper §3.5 partition and the markup_bps override clamp. The
 *     three-recipient projection collapses the contributor pool into a
 *     single indexer share (top-1 contributor only, matching the
 *     primitive doc's "indexer who captured the route").
 *   - Bps are derived from on-ledger metrics (cumulative_delta,
 *     markup_bps), never hardcoded per-domain.
 *
 * Surfaces:
 *   - `resolveThreeRecipientSplits(env, kv, skill)` — pure-ish resolver
 *     (KV read only). Returns `{ recipients, defaultSplits }` ready for
 *     the facilitator config.
 *   - `createUptoHandlerForSkill(env, opts)` — returns a Hono `Handler`
 *     produced by `createUptoHandler` with the three-recipient
 *     `defaultSplits` plumbed into the facilitator config the handler
 *     reaches over `opts.facilitatorURL`. The `payTo` on the
 *     `UptoAccept` is the indexer ATA (the variable-receiver per
 *     Faremeter's `buildSplits` convention); the platform + domain ATAs
 *     are the fixed-cut entries in `defaultSplits`.
 *
 * This module does NOT make any Solana RPC calls. The settlement +
 * signing path is exercised by services/flex-facilitator.ts (which
 * receives these `defaultSplits` when our self-hosted facilitator is
 * the target). Pure assembly so tests can prove the wire-shape without
 * mocks.
 */

import type { Handler } from "hono";
import type { Env, SkillManifest } from "../types.js";
import { buildBindingKey, buildOptOutKey, type DomainClaimBinding } from "./domain-claim.js";
import {
  computeFlexSplits,
  mergeSplits,
  type FlexSplit,
  type FlexSplitRoleConfig,
  OWNER_BPS,
  PLATFORM_BPS,
} from "./flex.js";
import { platformRecipientUsdcAta } from "./flex-facilitator.js";
import { statsKV } from "./kv.js";

/**
 * Minimal KV interface — matches the shape returned by `statsKV(env)`.
 * Declared here as a structural type so tests can inject an in-memory
 * stub without dragging the full EdbKV/LocalKV chain.
 */
export interface UptoSplitsKV {
  get(key: string): Promise<string | null>;
}

/**
 * Three-recipient split projection. Each entry carries a `role` tag for
 * journal-row readers; the on-chain Flex program only consumes
 * `{ recipient, bps }`. Sum of bps === 10000.
 */
export interface ThreeRecipientSplit {
  recipients: {
    indexer_ata: string;
    domain_or_hold_ata: string;
    platform_ata: string;
    /** true when the domain has a verified DNS-TXT claim binding. */
    domain_claimed: boolean;
    /** Source of the domain recipient: claimed wallet vs global-hold fallback. */
    domain_recipient_source: "claimed_wallet" | "global_hold";
  };
  /**
   * The three-recipient `defaultSplits` array shaped exactly per
   * docs/public/primitives/07-fair-split-and-claim.md. Index order is
   * stable: [indexer, domain-or-hold, platform].
   */
  defaultSplits: Array<{ recipient: string; bps: number; role: "contributor" | "site_owner" | "infrastructure" }>;
}

/**
 * Read the env-bound global-hold USDC ATA. Returns null if unset so the
 * caller can decide whether absence is a hard error (claim flow live and
 * domain unclaimed) or a soft warning (domain claimed, fallback unused).
 */
export function globalHoldUsdcAta(env: Env): string | null {
  const raw = env.FLEX_GLOBAL_HOLD_USDC_ATA?.trim();
  if (!raw) return null;
  // Loose Solana ATA shape check (same rule as platformRecipientUsdcAta).
  if (raw.length < 32 || raw.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(raw)) {
    throw new Error(
      `FLEX_GLOBAL_HOLD_USDC_ATA does not look like a base58 Solana ATA (length=${raw.length}). ` +
      "Derive via `spl-token address --owner <hold-wallet> --token <USDC-mint>`.",
    );
  }
  return raw;
}

/**
 * Pick the top contributor by cumulative_delta whose wallet is bound.
 * Used as the indexer recipient — primitive doc 07 §"Who gets what"
 * row 1: "Indexer ... The Solana wallet on the indexer's profile".
 *
 * NOTE: this collapses the multi-contributor compute-splits pool into a
 * SINGLE indexer share. The primitive doc is explicit that the indexer
 * is a single recipient ("the indexer who captured the route"). When
 * multiple contributors exist, the top-cumulative-delta one wins; the
 * rest accumulate via the existing settlement batch flow on the
 * marketplace side rather than per-request flex splits.
 */
export function pickIndexerWallet(
  contributors: SkillManifest["contributors"],
): string | null {
  const payable = (contributors ?? []).filter((c) => c.wallet_address?.trim());
  if (payable.length === 0) return null;
  const sorted = [...payable].sort((a, b) => b.cumulative_delta - a.cumulative_delta);
  const ata = sorted[0]?.wallet_address?.trim();
  return ata && ata.length > 0 ? ata : null;
}

/**
 * Look up the domain owner's wallet USDC ATA from a verified DNS-TXT
 * claim binding. Returns:
 *   - `{ ata: string, source: "claimed_wallet" }` when a binding exists
 *     and the domain is NOT opted-out.
 *   - `{ ata: null, source: "global_hold" }` when no binding exists OR
 *     the domain is opted-out (caller falls back to global-hold).
 *
 * Opt-out wins over claim — if a domain is taken down, payments to its
 * owner halt even if previously claimed (the share routes to global
 * hold until claim is reasserted via a fresh verify).
 */
export async function lookupDomainWallet(
  kv: UptoSplitsKV,
  domain: string,
): Promise<{ ata: string | null; source: "claimed_wallet" | "global_hold" }> {
  const normalized = domain.trim().toLowerCase();
  if (!normalized) return { ata: null, source: "global_hold" };

  // Opt-out short-circuit: a taken-down domain routes to global hold.
  const optOutRaw = await kv.get(buildOptOutKey(normalized));
  if (optOutRaw) return { ata: null, source: "global_hold" };

  const bindingRaw = await kv.get(buildBindingKey(normalized));
  if (!bindingRaw) return { ata: null, source: "global_hold" };

  try {
    const binding = JSON.parse(bindingRaw) as Partial<DomainClaimBinding>;
    const ata = binding.wallet_usdc_ata?.trim();
    if (ata && ata.length >= 32 && ata.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(ata)) {
      return { ata, source: "claimed_wallet" };
    }
  } catch {
    // Malformed binding row — treat as unclaimed, route to global hold.
  }
  return { ata: null, source: "global_hold" };
}

/**
 * Build the three-recipient split for a paid request against `skill`.
 *
 * Pure projection on top of `computeFlexSplits`:
 *   - platform_ata, platform_bps  ← effective markup (PLATFORM_BPS default,
 *                                    clamped via skill.markup_bps)
 *   - domain_or_hold_ata, OWNER_BPS ← claimed wallet OR global-hold
 *   - indexer_ata, remainder       ← top-1 contributor's wallet
 *
 * If `skill.contributors` has no payable wallet, throws — the caller
 * cannot pay an indexer who has no payout address.
 */
export async function resolveThreeRecipientSplits(
  env: Env,
  kv: UptoSplitsKV,
  skill: Pick<
    SkillManifest,
    | "contributors"
    | "domain"
    | "owner_compensation_opt_in"
    | "owner_wallet_usdc_ata"
    | "markup_bps"
  >,
  opts: { roleConfig?: FlexSplitRoleConfig } = {},
): Promise<ThreeRecipientSplit> {
  const domain = skill.domain?.trim().toLowerCase();
  if (!domain) {
    throw new Error("resolveThreeRecipientSplits: skill.domain required");
  }

  const indexerAta = pickIndexerWallet(skill.contributors);
  if (!indexerAta) {
    throw new Error(
      "resolveThreeRecipientSplits: skill has no payable contributor — no indexer wallet to route to",
    );
  }

  const platformAta = platformRecipientUsdcAta(env);
  const holdAta = globalHoldUsdcAta(env);

  const domainLookup = await lookupDomainWallet(kv, domain);
  // Fallback chain: claimed wallet → global hold → throw.
  // The global hold MUST be configured when shipping; if it isn't and
  // the domain is unclaimed, throw an honest error rather than silently
  // dropping the domain lane or routing it to platform (which would
  // shadow-claim every unclaimed domain to ourselves).
  let domainAta: string;
  let domainSource: "claimed_wallet" | "global_hold";
  if (domainLookup.ata) {
    domainAta = domainLookup.ata;
    domainSource = "claimed_wallet";
  } else if (holdAta) {
    domainAta = holdAta;
    domainSource = "global_hold";
  } else {
    throw new Error(
      "resolveThreeRecipientSplits: domain is unclaimed and FLEX_GLOBAL_HOLD_USDC_ATA is unset — " +
      "configure the global-hold wallet OR claim the domain before paid execute fires.",
    );
  }

  // Reuse the canonical split engine. Force the owner lane on
  // (opt-in + owner_wallet_usdc_ata) so the indexer/domain/platform
  // partition lands. We feed a synthetic single-contributor manifest so
  // computeFlexSplits emits exactly three entries (platform + owner + 1
  // contributor) at the bps proportions encoded in the paper §3.5.
  const syntheticManifest = {
    contributors: [
      {
        agent_id: "indexer",
        wallet_address: indexerAta,
        endpoints_contributed: 1,
        cumulative_delta: 1,
        share: 0,
        first_contributed_at: "1970-01-01T00:00:00Z",
        last_contributed_at: "1970-01-01T00:00:00Z",
      },
    ],
    owner_compensation_opt_in: true as const,
    owner_wallet_usdc_ata: domainAta,
    markup_bps: skill.markup_bps,
  };

  const raw = computeFlexSplits(syntheticManifest, platformAta, opts.roleConfig);
  // computeFlexSplits returns [platform, owner, ...contributors] AFTER
  // running mergeSplits internally, so duplicate-recipient collisions
  // (e.g. indexerAta === domainAta on a self-claimed indexer-owned
  // domain) are ALREADY collapsed here. Two valid shapes survive:
  //   - 3 entries: distinct indexer + domain + platform (normal case)
  //   - 2 entries: indexer collapsed into domain (or domain into
  //     platform) because their ATAs match. The merged entry keeps the
  //     first-seen role (which `mergeSplits` defines as the order
  //     `[platform, owner, contributors]` — owner wins over contributor).
  // Treat both as legitimate; the caller learns about the merge via
  // the returned `defaultSplits.length`.
  if (raw.length < 2 || raw.length > 3) {
    throw new Error(
      `resolveThreeRecipientSplits: computeFlexSplits produced ${raw.length} entries ` +
      `(roles=${raw.map((s) => s.role).join(",")}); expected 2 (merged) or 3 (distinct)`,
    );
  }

  // Canonicalise the order so the wire-shape stays predictable per
  // primitive doc 07: [indexer, domain, platform]. When indexer ==
  // domain the merged entry takes the indexer slot (mergeSplits
  // already added their bps).
  let merged: FlexSplit[];
  if (raw.length === 3) {
    const platformEntry = raw.find((s) => s.recipient === platformAta && s.role === "infrastructure")!;
    const domainEntry = raw.find((s) => s.recipient === domainAta && s.role === "site_owner")!;
    const indexerEntry = raw.find((s) => s.role === "contributor")!;
    merged = [
      { recipient: indexerEntry.recipient, bps: indexerEntry.bps, role: "contributor" },
      { recipient: domainEntry.recipient, bps: domainEntry.bps, role: "site_owner" },
      { recipient: platformEntry.recipient, bps: platformEntry.bps, role: "infrastructure" },
    ];
  } else {
    // 2 entries — duplicate-merge case. Preserve mergeSplits ordering:
    // [platform, owner-or-contributor]. We re-orient so the non-platform
    // entry comes first (it's the "indexer + domain" merged slot).
    const platformEntry = raw.find((s) => s.recipient === platformAta && s.role === "infrastructure")!;
    const otherEntry = raw.find((s) => s !== platformEntry)!;
    merged = [
      { recipient: otherEntry.recipient, bps: otherEntry.bps, role: otherEntry.role },
      { recipient: platformEntry.recipient, bps: platformEntry.bps, role: "infrastructure" },
    ];
  }

  // Sum invariant — must hit exactly 10000 bps. computeFlexSplits already
  // guarantees this; mergeSplits preserves the total.
  const total = merged.reduce((s, x) => s + x.bps, 0);
  if (total !== 10000) {
    throw new Error(
      `resolveThreeRecipientSplits: bps sum ${total} != 10000 (entries=${JSON.stringify(merged)})`,
    );
  }

  return {
    recipients: {
      indexer_ata: indexerAta,
      domain_or_hold_ata: domainAta,
      platform_ata: platformAta,
      domain_claimed: domainSource === "claimed_wallet",
      domain_recipient_source: domainSource,
    },
    defaultSplits: merged.map((s) => ({
      recipient: s.recipient,
      bps: s.bps,
      role: (s.role ?? "contributor") as "contributor" | "site_owner" | "infrastructure",
    })),
  };
}

/**
 * Options for createUptoHandlerForSkill. Mostly DI seams so tests can
 * inject in-memory KV + a stub upto factory without touching network.
 */
export interface CreateUptoHandlerForSkillOpts {
  /** Self-hosted facilitator URL the upto handler delegates verify/settle to. */
  facilitatorURL: string;
  /** SkillManifest the paid resource is bound to. */
  skill: Pick<
    SkillManifest,
    | "contributors"
    | "domain"
    | "owner_compensation_opt_in"
    | "owner_wallet_usdc_ata"
    | "markup_bps"
  >;
  /** USDC mint to settle in. Defaults to mainnet USDC. */
  asset?: string;
  /** caip-2 network id. Defaults to Solana mainnet. */
  network?: string;
  /** UpTo ceiling in micro-USDC (string, base 10). Caller sets per route. */
  maxAmountUc: string;
  /** Optional timeout override (seconds). */
  maxTimeoutSeconds?: number;
  /**
   * `authorize` callback per upto-handler: returns the actual amount
   * (bigint µ¢) the route is going to settle for. Defaults to the
   * full `maxAmountUc` (pure ceiling spend). Routes that meter their
   * own cost should override.
   */
  authorize?: (body: unknown) => bigint | Promise<bigint>;
  /**
   * `handle` callback per upto-handler: invoked after payment verify
   * succeeds with a `settle(amount)` fn. Caller MUST call `settle(...)`
   * before returning a non-402 response.
   */
  handle: (
    body: unknown,
    settle: (amount: bigint) => Promise<unknown>,
  ) => Promise<Response>;
  /** Test seam: KV override. Production uses `statsKV(env)`. */
  kv?: UptoSplitsKV;
  /** Test seam: stub the upto-handler factory (default = real one). */
  uptoFactory?: (opts: unknown) => Promise<Handler>;
  /** Test seam: stub fetch passed to createUptoHandler. */
  fetch?: typeof fetch;
}

/**
 * Lazy import seam so tests can swap the upto factory without dragging
 * the full @faremeter/payment-solana surface into the unit test.
 *
 * @faremeter/payment-solana ships its own pinned hono copy so the
 * return type technically differs from our top-level `hono`'s Handler
 * by HonoRequest's GET_MATCH_RESULT symbol. The runtime is interchangeable
 * (both are Hono handlers); we cast to unknown then to our Handler so
 * the caller's mount-on-Hono-app code type-checks against ours.
 */
async function defaultUptoFactory(opts: unknown): Promise<Handler> {
  const mod = await import("@faremeter/payment-solana/flex/hono");
  const h = mod.createUptoHandler(opts as Parameters<typeof mod.createUptoHandler>[0]);
  return h as unknown as Handler;
}

/**
 * Build a `createUptoHandler`-backed Hono Handler whose accepts carry
 * the three-recipient split per primitive doc 07.
 *
 * Per Faremeter's `buildSplits` convention (flex/facilitator/handler.js
 * L159-175), the `payTo` on each accept becomes the variable receiver
 * that absorbs `10000 - reservedBps` after the facilitator's fixed
 * defaultSplits. We pin `payTo = indexerAta` so the indexer's bps is
 * the variable lane; the domain + platform lanes ride on the
 * facilitator's defaultSplits which we pre-load at deploy time.
 *
 * IMPORTANT: this returns a Hono Handler that, when mounted on a route,
 * will require the upstream facilitator (`opts.facilitatorURL`) to have
 * been configured with the same three-recipient `defaultSplits`. For
 * our self-hosted facilitator that means `createFlexFacilitator` is
 * invoked with `defaultSplits: [{domain, OWNER_BPS}, {platform, PLATFORM_BPS}]`
 * (the indexer slot is variable per-request, NOT a default split).
 */
export async function createUptoHandlerForSkill(
  env: Env,
  opts: CreateUptoHandlerForSkillOpts,
): Promise<{
  handler: Handler;
  split: ThreeRecipientSplit;
}> {
  // Adapt statsKV (returns unknown) to our string-typed UptoSplitsKV.
  // The values we read here (domain-wallet:, domain-optout:) are always
  // strings on the write side; the cast is a typing convenience.
  const kv: UptoSplitsKV = opts.kv ?? {
    get: async (key: string) => {
      const raw = (await statsKV(env).get(key)) as string | null;
      return raw;
    },
  };
  const split = await resolveThreeRecipientSplits(env, kv, opts.skill);

  const network = opts.network ?? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet caip-2
  const asset = opts.asset ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC mainnet mint

  const uptoFactory = opts.uptoFactory ?? defaultUptoFactory;
  const handler = await uptoFactory({
    facilitatorURL: opts.facilitatorURL,
    accepts: [
      {
        scheme: "flex",
        network,
        amount: opts.maxAmountUc,
        asset,
        // Indexer lane is the variable receiver per buildSplits convention.
        payTo: split.recipients.indexer_ata,
        ...(opts.maxTimeoutSeconds !== undefined
          ? { maxTimeoutSeconds: opts.maxTimeoutSeconds }
          : {}),
      },
    ],
    authorize: opts.authorize ?? (() => BigInt(opts.maxAmountUc)),
    handle: opts.handle,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return { handler, split };
}

/**
 * Static expected bps for the three-recipient split with default markup
 * (PLATFORM_BPS=5000, OWNER_BPS=1500). Exported so the journal /
 * settlement readers can assert the wire-shape without re-running the
 * compute. When `markup_bps` is set on a skill, the platform lane shifts
 * inside [MARKUP_BPS_MIN, MARKUP_BPS_MAX] and the indexer lane absorbs
 * the delta; the domain lane stays at OWNER_BPS.
 */
export const DEFAULT_THREE_RECIPIENT_BPS = {
  indexer: 10_000 - PLATFORM_BPS - OWNER_BPS, // 3500 default
  domain: OWNER_BPS,                          // 1500
  platform: PLATFORM_BPS,                     // 5000
} as const;
