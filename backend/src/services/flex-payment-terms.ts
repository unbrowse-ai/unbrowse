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

export interface FlexPaymentRequired {
  x402Version: 2;
  error: "Payment Required";
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<{
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
  }>;
}

export async function buildFlexPaymentTerms(
  env: Env,
  opts: {
    skill: Pick<SkillManifest, "skill_id" | "contributors">;
    priceUsd: number;
    agentEscrow: string;
    resource: string;
    currentSlot: bigint;
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

  return {
    x402Version: 2,
    error: "Payment Required",
    resource: {
      url: opts.resource,
      description: `Skill access: ${opts.skill.skill_id}`,
      mimeType: "application/json",
    },
    accepts: [{
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
    }],
  };
}
