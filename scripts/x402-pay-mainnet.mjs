#!/usr/bin/env bun
/**
 * Plain Ed25519 keypair x402 exact-scheme payer for Solana mainnet.
 *
 * The repo had no plain-keypair x402 client — only the lobster SMART-wallet
 * adapter, which cannot do the faremeter "ToSpec" exact-scheme flow (it needs a
 * raw `partiallySignTransaction` over a noop-signer authority). This standalone
 * client wraps a raw keypair so a real mainnet USDC micropayment can settle:
 *   402 -> sign TransferChecked (authority=payer, feePayer=PayAI) -> X-PAYMENT
 *   retry -> backend forwards to PayAI /verify+/settle -> on-chain tx sig.
 *
 * Usage:
 *   UNBROWSE_PAYMENT_SECRET=<base58 64-byte secret> \
 *   bun scripts/x402-pay-mainnet.mjs https://beta-api.unbrowse.ai/v1/llm/nebius/messages
 *
 * Spends real USDC. The payer keypair must hold >= the 402 amount in USDC and
 * already have a USDC associated-token-account (receiving USDC creates it).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import bs58 from "bs58";
import { createKeyPairFromBytes, partiallySignTransaction, address, createSolanaRpc } from "@solana/kit";
import { createPaymentHandler } from "@faremeter/payment-solana/exact";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC = process.env.UNBROWSE_SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const url = process.argv[2] || "https://beta-api.unbrowse.ai/v1/llm/nebius/messages";
const bodyJson = process.argv[3] || '{"model":"kimi-k2.5","messages":[{"role":"user","content":"hi"}],"max_tokens":16}';

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

const secretB58 = loadSecret();
if (!secretB58) { console.error("FATAL: UNBROWSE_PAYMENT_SECRET not set (need a funded plain Ed25519 keypair, base58)"); process.exit(1); }
const secretBytes = bs58.decode(secretB58);
const keyPair = await createKeyPairFromBytes(secretBytes);
const payerPubkey = bs58.encode(secretBytes.slice(32));
console.log("[pay] payer", payerPubkey, "rpc", RPC);

const wallet = {
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  publicKey: address(payerPubkey),
  partiallySignTransaction: (tx) => partiallySignTransaction([keyPair], tx),
};

// Step 1: trigger the 402.
const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: bodyJson });
console.log("[pay] initial status", r1.status);
if (r1.status !== 402) { console.log("[pay] not a 402; body:", (await r1.text()).slice(0, 400)); process.exit(r1.status === 200 ? 0 : 2); }
const envelope = await r1.json();
const accepts = envelope.accepts || [];
console.log("[pay] envelope.resource", JSON.stringify(envelope.resource));
const exactAccept = accepts.find((a) => a.scheme === "exact" && String(a.network).startsWith("solana:"));
if (!exactAccept) { console.error("FATAL: no exact solana accept in envelope:", JSON.stringify(accepts)); process.exit(3); }
console.log("[pay] paying", exactAccept.amount, "atomic USDC to", exactAccept.payTo, "feePayer", exactAccept.extra?.feePayer);

// Step 2: build + sign the transfer via faremeter exact handler (ToSpec).
const rpc = createSolanaRpc(RPC);
const handler = createPaymentHandler(wallet, USDC_MINT, rpc);
const options = handler.length; // no-op; keep ref
const results = await handler({ url }, accepts);
if (!results.length) { console.error("FATAL: handler produced no compatible requirement"); process.exit(4); }
const { payload } = await results[0].exec();
console.log("[pay] signed tx bytes (base64) len", payload.transaction?.length);

// Step 3: construct X-PAYMENT (backend reads payload.scheme + payload.accepted, forwards to PayAI).
const xPayment = {
  x402Version: 2,
  scheme: "exact",
  network: exactAccept.network,
  accepted: exactAccept,
  payload,
  extra: { facilitator: exactAccept.extra?.facilitator || "https://facilitator.payai.network" },
};
const header = Buffer.from(JSON.stringify(xPayment)).toString("base64");

// Step 4: retry with X-PAYMENT.
const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": header }, body: bodyJson });
console.log("[pay] paid retry status", r2.status);
const payResp = r2.headers.get("PAYMENT-RESPONSE");
if (payResp) {
  try {
    const decoded = JSON.parse(Buffer.from(payResp, "base64").toString("utf8"));
    console.log("[pay] PAYMENT-RESPONSE tx:", decoded.transaction, "network:", decoded.network);
    console.log("[pay] SOLSCAN: https://solscan.io/tx/" + decoded.transaction);
  } catch { console.log("[pay] PAYMENT-RESPONSE (raw):", payResp); }
} else {
  console.log("[pay] no PAYMENT-RESPONSE header");
}
const text = await r2.text();
console.log("[pay] body:", text.slice(0, 600));
process.exit(r2.status === 200 ? 0 : 5);
