#!/usr/bin/env node
// iq-ledger — browse the IQ on-chain resolution ledger (IQLabs / Solana mainnet).
//
// Every unbrowse resolution is mirrored to a wallet-signed, append-only IQ table
// (cached-resolution.ts → mirrorResolutionToChain). This is the human window onto it:
// it derives the table PDA from IQ_DB_ROOT_ID + IQ_TABLE_SEED (the same derivation the
// writer uses), prints the Solana-explorer URL so you can browse the raw account, and —
// when --rows is passed and the reader is reachable — prints the most recent rows.
//
//   node scripts/iq-ledger.mjs           # PDA + explorer URLs (offline, no RPC)
//   node scripts/iq-ledger.mjs --rows 20 # + read the latest 20 on-chain rows
//
// Read-only. Never prints the signer secret. Resolves config from .env.
import { readFileSync } from "node:fs";

const N = (() => { const i = process.argv.indexOf("--rows"); return i >= 0 ? Number(process.argv[i + 1] || 20) : 0; })();

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(new URL("../.env", import.meta.url), "utf8")
        .split("\n").filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).replace(/^"|"$/g, "").trim()]; }),
    );
  } catch { return process.env; }
}

const env = { ...loadEnv(), ...process.env };
const dbRootId = env.IQ_DB_ROOT_ID, tableSeed = env.IQ_TABLE_SEED || "resolutions";
if (!dbRootId) { console.error("iq-ledger: IQ_DB_ROOT_ID not set — nothing to browse"); process.exit(2); }

const iqlabs = await import("@iqlabs-official/solana-sdk");
const c = iqlabs.contract ?? iqlabs.default?.contract ?? iqlabs;
const u = iqlabs.utils ?? iqlabs.default?.utils ?? iqlabs;
const dbRoot = c.getDbRootPda(u.toSeedBytes(dbRootId));
const table = c.getTablePda(dbRoot, u.toSeedBytes(tableSeed));
const b58 = (x) => (x && x.toBase58 ? x.toBase58() : String(x));
const tableAddr = b58(table);

console.log(`IQ ledger — table "${tableSeed}" (DbRoot ${b58(dbRoot)})`);
console.log(`  on-chain table : ${tableAddr}`);
console.log(`  solscan        : https://solscan.io/account/${tableAddr}`);
console.log(`  explorer       : https://explorer.solana.com/address/${tableAddr}`);

if (N > 0) {
  try {
    const reader = iqlabs.reader ?? iqlabs.default?.reader ?? c;
    const rows = await (reader.readTableRows
      ? reader.readTableRows(dbRoot, u.toSeedBytes(tableSeed))
      : Promise.reject(new Error("readTableRows unavailable in this SDK build")));
    const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    console.log(`\n  latest ${Math.min(N, list.length)} of ${list.length} rows:`);
    for (const r of list.slice(-N).reverse()) {
      const intent = r.intent ?? r.key ?? "?";
      const result = r.result ?? r.value ?? "?";
      const ts = r.ts ? new Date(Number(r.ts)).toISOString() : "";
      console.log(`    ${ts}  ${String(intent).slice(0, 48)} -> ${String(result).slice(0, 40)}`);
    }
  } catch (e) {
    console.log(`\n  (row read needs RPC/reader: ${e instanceof Error ? e.message : String(e)})`);
    console.log("  → browse the rows visually at the solscan URL above.");
  }
}
