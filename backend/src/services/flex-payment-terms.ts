/**
 * Flex payment-terms builder (Day 4, v6.16.0).
 *
 * Integration glue between `computeFlexSplits` + `buildFlexAuthorization` and
 * the x402 payment-required envelope. Returns a v2 `accepts[]` entry shaped
 * for `scheme: "@faremeter/flex"`.
 *
 * NOT wired into routes today — that's Day-5's job (the `buildSkillPaymentTerms`
 * callsites in routes/{skills,search,demos}.ts swap over there). Today this
 * function is install-only: tests prove it produces the right wire shape.
 *
 * Probe-confirmed Faremeter exports used here:
 *   - `FLEX_PROGRAM_ADDRESS` (from `@faremeter/flex-solana`, lazy-imported)
 *
 * The `FlexAuthorizationDraft` we embed in `extra.flexAuthorizationDraft`
 * matches the field set required by `serializePaymentAuthorization`'s
 * `SerializePaymentAuthorizationArgs` minus `programId` (caller fills from
 * `extra.programId`).
 */

import type { Env, SkillManifest } from "../types.js";
import {
  buildFlexAuthorization,
  computeFlexSplits,
  type FlexAuthorizationDraft,
  type FlexSplit,
} from "./flex.js";
import { platformRecipientUsdcAta } from "./flex-facilitator.js";

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface FlexAcceptEntry {
  scheme: "@faremeter/flex";
  network: "solana-mainnet";
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    flexAuthorizationDraft: FlexAuthorizationDraft;
    splits: FlexSplit[];
    programId: string;
  };
}

/**
 * Exact-scheme accept entry that delegates verify+settle to PayAI's
 * facilitator (`facilitator.payai.network`). Clients without Flex setup
 * (no escrow, no session key) can settle through this path using
 * `@faremeter/payment-solana/exact` or PayAI's `x402-solana`. The
 * platform cut on this path is the full amount routed to
 * `platformRecipientUsdcAta(env)` — Flex-style splits do not apply, so
 * contributors are not paid through the exact path. Documented at
 * docs/payai-exact-dual-accept.md.
 *
 * `feePayer` is PayAI's declared Solana feePayer pubkey, harvested from
 * `https://facilitator.payai.network/supported` at the time this entry
 * was wired (the value is stable across releases; PayAI documents it on
 * their /supported endpoint).
 */
export interface ExactAcceptEntry {
  scheme: "exact";
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    feePayer: string;
    facilitator: "https://facilitator.payai.network";
  };
}

export interface FlexPaymentRequired {
  x402Version: 2;
  error: "Payment Required";
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<FlexAcceptEntry | ExactAcceptEntry>;
}

export async function buildFlexPaymentTerms(
  env: Env,
  opts: {
    skill: Pick<SkillManifest, "skill_id" | "contributors">;
    priceUsd: number;
    agentEscrow: string;
    resource: string;
    currentSlot: bigint;
    /**
     * Caller agent_id for the L2 rail-rotation bucket. When provided,
     * the `accepts` array ordering is biased by PAYAI_ROTATION_BPS so a
     * given agent consistently sees the same scheme first across calls.
     * Anonymous callers fall back to bucket 0.
     */
    agentId?: string;
  },
): Promise<FlexPaymentRequired> {
  const platformAta = platformRecipientUsdcAta(env);
  const splits = computeFlexSplits(opts.skill, platformAta);
  if (splits.length === 0) {
    throw new Error("buildFlexPaymentTerms: skill has no payable contributors");
  }
  const maxAmountUc = BigInt(Math.max(1, Math.round(opts.priceUsd * 1_000_000)));
  const draft = await buildFlexAuthorization(env, {
    agentEscrow: opts.agentEscrow,
    maxAmountUc,
    splits,
    currentSlot: opts.currentSlot,
  });

  // Lazy-import to keep cold-start light when the route isn't Flex-eligible.
  const flex = await import("@faremeter/flex-solana");
  const programId = String(flex.FLEX_PROGRAM_ADDRESS);

  // PayAI's Solana feePayer pubkey from facilitator.payai.network/supported.
  // If you operate your own PayAI relationship and need to swap this, set
  // `PAYAI_FEEPAYER_PUBKEY` in env; we read it lazily here.
  const payaiFeePayer = env.PAYAI_FEEPAYER_PUBKEY?.trim() ||
    "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";

  const flexAccept: FlexAcceptEntry = {
    scheme: "@faremeter/flex",
    network: "solana-mainnet",
    amount: maxAmountUc.toString(10),
    asset: USDC_MINT_MAINNET,
    payTo: opts.agentEscrow,
    maxTimeoutSeconds: 60,
    extra: {
      flexAuthorizationDraft: draft,
      splits,
      programId,
    },
  };
  const exactAccept: ExactAcceptEntry = {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: maxAmountUc.toString(10),
    asset: USDC_MINT_MAINNET,
    payTo: platformAta,
    maxTimeoutSeconds: 300,
    extra: {
      feePayer: payaiFeePayer,
      facilitator: "https://facilitator.payai.network",
    },
  };

  // L2 rotation: bias which scheme the client sees first by the
  // PAYAI_ROTATION_BPS hash bucket on the caller's agent_id. Clients
  // generally pay the first accept entry whose scheme they recognize,
  // so the array order is the actual traffic-routing knob.
  const { pickRail } = await import("./rail-rotation.js");
  const rail = pickRail(env, opts.agentId);
  const accepts = rail.primary === "payai"
    ? [exactAccept, flexAccept]
    : [flexAccept, exactAccept];

  return {
    x402Version: 2,
    error: "Payment Required",
    resource: {
      url: opts.resource,
      description: `Skill access: ${opts.skill.skill_id}`,
      mimeType: "application/json",
    },
    accepts,
  };
}
