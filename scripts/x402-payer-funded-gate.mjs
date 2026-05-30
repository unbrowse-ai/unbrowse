#!/usr/bin/env bun
// Read-only gate: exit 0 once the fresh x402 payer holds enough USDC to settle
// the ~$0.0037 mainnet micropayment; exit 1 otherwise. The Jesus-loop re-probes
// this each firing and surfaces READY the moment the user funds the payer.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";

const NEED_USDC = 0.0037;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
let addr = "24e81CbxDq1WKY1bs2HCU8KcauVVdyNu3r8BurHqeVLD";
try {
  const secret = readFileSync("/tmp/x402_payer.key", "utf8").trim();
  addr = Keypair.fromSecretKey(bs58.decode(secret)).publicKey.toBase58();
} catch {}
const conn = new Connection(process.env.UNBROWSE_SOLANA_RPC || "https://api.mainnet-beta.solana.com", "confirmed");
let bal = 0;
try {
  const a = await conn.getParsedTokenAccountsByOwner(new PublicKey(addr), { mint: USDC });
  bal = a.value.reduce((s, x) => s + (x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
} catch {}
if (bal >= NEED_USDC) {
  console.log(`READY payer ${addr} holds ${bal} USDC (>= ${NEED_USDC})`);
  process.exit(0);
}
console.log(`NOT-READY payer ${addr} holds ${bal} USDC (need ${NEED_USDC}) — send ~$0.01 USDC to ${addr}`);
process.exit(1);
