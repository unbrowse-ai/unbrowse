/**
 * GET /skills/:id/download — x402 paywalled skill package download.
 *
 * Protected by Solana x402 payment gate in the main server.
 * When payment is verified, returns the full skill package and records the download.
 */

import { getDb } from "../db.js";
import type { SkillPackage } from "../types.js";
import type { PaymentSplitInfo } from "../x402.js";
import { getDownloadPriceUsd } from "../x402.js";

export function downloadSkill(
  id: string,
  paymentInfo?: {
    signature: string;
    amount: bigint;
    splits: PaymentSplitInfo;
    payerWallet?: string;
  },
): Response {
  const db = getDb();

  const row = db.query(`
    SELECT id, service, base_url, auth_method_type,
           endpoints_json, skill_md, api_template, creator_wallet,
           review_status, review_reason, ability_type, price_cents, content_json
    FROM skills WHERE id = ?
  `).get(id) as any;

  if (!row) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  // Only serve skills that passed safety review
  const reviewStatus = row.review_status ?? "pending";
  if (reviewStatus === "rejected") {
    return Response.json(
      { error: "Skill rejected by safety review", reason: row.review_reason },
      { status: 403 },
    );
  }
  if (reviewStatus === "pending") {
    return Response.json(
      { error: "Skill is pending safety review — try again shortly" },
      { status: 202 },
    );
  }
  if (reviewStatus === "flagged") {
    return Response.json(
      { error: "Skill is flagged for manual review", reason: row.review_reason },
      { status: 403 },
    );
  }
  // reviewStatus === "approved" — proceed with download

  // Increment download count
  db.run(`UPDATE skills SET download_count = download_count + 1 WHERE id = ?`, [id]);

  // Use per-ability price if set, otherwise global default
  const abilityPriceCents = row.price_cents ?? 1;
  const priceUsd = abilityPriceCents / 100;

  // Track unique payers for brain marketplace ranking
  if (paymentInfo?.payerWallet) {
    db.run(
      `INSERT OR IGNORE INTO ability_payers (ability_id, payer_wallet) VALUES (?, ?)`,
      [id, paymentInfo.payerWallet],
    );
  }

  // Track download with payment details (matches reference recordX402Payment pattern)
  if (paymentInfo?.signature) {
    const chain = (process.env.SOLANA_RPC_URL ?? "").includes("devnet") ? "devnet" : "mainnet-beta";
    const mint = process.env.USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    db.run(
      `INSERT INTO downloads (skill_id, amount_usd, payment_signature, payment_chain, payment_mint, payer_wallet, fee_payer_amount, creator_amount, treasury_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        priceUsd,
        paymentInfo.signature,
        chain,
        mint,
        paymentInfo.payerWallet ?? null,
        paymentInfo.splits.wallet1Amount.toString(),
        paymentInfo.splits.creatorAmount.toString(),
        paymentInfo.splits.fdryTreasuryAmount.toString(),
      ],
    );
  } else {
    db.run(
      `INSERT INTO downloads (skill_id, amount_usd) VALUES (?, ?)`,
      [id, priceUsd],
    );
  }

  // Update creator earnings
  db.run(`
    INSERT INTO creator_earnings (creator_wallet, total_earned_usd, total_downloads, pending_usd)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(creator_wallet) DO UPDATE SET
      total_earned_usd = total_earned_usd + ?,
      total_downloads = total_downloads + 1,
      pending_usd = pending_usd + ?
  `, [row.creator_wallet, priceUsd, priceUsd, priceUsd, priceUsd]);

  // For non-skill abilities (patterns, extensions, etc.), return content_json
  const abilityType = row.ability_type ?? "skill";
  if (abilityType !== "skill" && row.content_json) {
    const ability = {
      id: row.id,
      type: abilityType,
      service: row.service,
      content: JSON.parse(row.content_json),
      creatorWallet: row.creator_wallet,
    };
    return Response.json(ability);
  }

  // Standard skill package
  const pkg: SkillPackage = {
    id: row.id,
    service: row.service,
    baseUrl: row.base_url,
    authMethodType: row.auth_method_type,
    endpoints: JSON.parse(row.endpoints_json ?? "[]"),
    skillMd: row.skill_md,
    apiTemplate: row.api_template,
  };

  return Response.json(pkg);
}
