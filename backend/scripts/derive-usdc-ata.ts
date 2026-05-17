#!/usr/bin/env bun
/**
 * Derive the USDC associated token account (ATA) for a Solana wallet
 * pubkey. Run this once per platform/contributor wallet you want to pay
 * out to via Faremeter Flex; pin the result as
 * FLEX_PLATFORM_RECIPIENT_USDC_ATA (or the per-contributor ATA in your
 * SkillContributor records).
 *
 * Uses @solana-program/token + @solana/kit (already pinned in
 * backend/package.json for the Flex facilitator), no new deps required.
 *
 * Usage:
 *   bun backend/scripts/derive-usdc-ata.ts <base wallet pubkey>
 *   bun backend/scripts/derive-usdc-ata.ts Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1
 *
 * Output: the base58 ATA pubkey on stdout, nothing else. Pipe-friendly.
 */

import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function main(): Promise<void> {
  const ownerArg = process.argv[2]?.trim();
  if (!ownerArg) {
    console.error("usage: bun backend/scripts/derive-usdc-ata.ts <base wallet pubkey>");
    process.exit(2);
  }
  // Light input validation. The base58 alphabet excludes 0 O I l. A real
  // Solana pubkey is 32 bytes -> 32 to 44 base58 chars.
  if (ownerArg.length < 32 || ownerArg.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(ownerArg)) {
    console.error(
      `error: ${JSON.stringify(ownerArg)} does not look like a base58 Solana pubkey`,
    );
    process.exit(2);
  }
  try {
    const [ata] = await findAssociatedTokenPda({
      owner: address(ownerArg),
      mint: address(USDC_MINT_MAINNET),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    console.log(ata);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

void main();
