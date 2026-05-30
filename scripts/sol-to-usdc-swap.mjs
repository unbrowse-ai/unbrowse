#!/usr/bin/env bun
/**
 * SOL -> USDC swap for the x402 payer, via Jupiter (lite-api v1).
 *
 * The default funding workflow: an identity that holds only SOL can still settle
 * a USDC-denominated x402 rail — pull SOL into the plain payer keypair, run this
 * to convert just-enough SOL to USDC (creates the USDC ATA), then pay via
 * scripts/x402-pay-mainnet.mjs. Proven on mainnet 2026-05-30 (swap 3nHP2U…,
 * settle 2kbnPks… finalized).
 *
 * Usage: UNBROWSE_PAYMENT_SECRET_FILE=/tmp/x402_payer.key bun scripts/sol-to-usdc-swap.mjs [lamports]
 *   default lamports = 1_000_000 (0.001 SOL) — yields plenty over a $0.0037 fee.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import bs58 from "bs58";
import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function loadSecret() {
  if (process.env.UNBROWSE_PAYMENT_SECRET) return process.env.UNBROWSE_PAYMENT_SECRET.trim();
  if (process.env.UNBROWSE_PAYMENT_SECRET_FILE) {
    try { return readFileSync(process.env.UNBROWSE_PAYMENT_SECRET_FILE, "utf8").trim(); } catch {}
  }
  try {
    const txt = readFileSync(homedir() + "/.config/env/global.env", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?UNBROWSE_PAYMENT_SECRET\s*=\s*(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch {}
  return "";
}

const inLamports = Number(process.argv[2] || 1_000_000);
const secret = loadSecret();
if (!secret) { console.error("FATAL: payer secret not set (UNBROWSE_PAYMENT_SECRET[_FILE])"); process.exit(1); }
const kp = Keypair.fromSecretKey(bs58.decode(secret));
const conn = new Connection(process.env.UNBROWSE_SOLANA_RPC || "https://api.mainnet-beta.solana.com", "confirmed");
console.log("[swap] payer", kp.publicKey.toBase58(), "swapping", inLamports / 1e9, "SOL -> USDC");

const q = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=${inLamports}&slippageBps=300`).then((r) => r.json());
if (!q?.outAmount) { console.error("[swap] no quote:", JSON.stringify(q).slice(0, 300)); process.exit(2); }
console.log("[swap] quote out:", Number(q.outAmount) / 1e6, "USDC");

const swapResp = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ quoteResponse: q, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
}).then((r) => r.json());
if (!swapResp?.swapTransaction) { console.error("[swap] no swapTransaction:", JSON.stringify(swapResp).slice(0, 400)); process.exit(3); }

const tx = VersionedTransaction.deserialize(Buffer.from(swapResp.swapTransaction, "base64"));
tx.sign([kp]);
const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
const conf = await conn.confirmTransaction(sig, "confirmed");
const accts = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(USDC) });
const bal = accts.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
console.log("[swap] confirmed err:", JSON.stringify(conf.value.err), "| USDC now:", bal);
console.log("[swap] https://solscan.io/tx/" + sig);
process.exit(conf.value.err ? 5 : 0);
