/**
 * Opt-in LIVE witness for the IQ on-chain contract ledger (crypto-was-all-you-needed):
 * every resolution is a wallet-SIGNED row written on Solana mainnet via the real
 * @iqlabs-official/solana-sdk, and the append-only signed history is read back through
 * the corrected derivation (getDbRootPda(toSeedBytes(id)) → getTablePda(dbRootPda, …)).
 *
 * DEFAULT-SKIPPED: this spends real mainnet SOL per run, so it only fires with
 * `IQ_E2E=1` set AND the IQ env present (SOLANA_RPC_URL + IQ_SIGNER_SECRET_KEY +
 * IQ_DB_ROOT_ID + IQ_TABLE_SEED — loaded from .env if not already in process.env).
 *
 *   IQ_E2E=1 bun test tests/iq-ledger-mainnet-e2e.test.ts
 *
 * Witnessed 2026-06-21 on mainnet: DbRoot 5smEAR…, table 6QNMrE…, append seq=1
 * sig 26q6uX92…, find→value-v1. The mock contract (tests/iq-ledger.test.ts) covers
 * the pure ledger logic on every `bun test`; this proves the live SDK wiring.
 */
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";

const LIVE = process.env.IQ_E2E === "1";

function loadEnvFromDotenv() {
  // The IQ secret lives in .env, not the test runner env — load it transiently.
  const path = `${import.meta.dir}/../.env`;
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i < 0 || line.startsWith("#")) continue;
    const k = line.slice(0, i).trim();
    if (/^(SOLANA_RPC_URL|SOLANA_RPC_ENDPOINT|IQ_SIGNER_SECRET_KEY|IQ_DB_ROOT_ID|IQ_TABLE_SEED)$/.test(k) && !process.env[k]) {
      process.env[k] = line.slice(i + 1).trim();
    }
  }
}

test.if(LIVE)("IQ ledger: real wallet-signed on-chain append → signed-history read-back", async () => {
  loadEnvFromDotenv();
  const { iqClientFromEnv, iqLedger } = await import("../src/values/iq-ledger.ts");
  const client = await iqClientFromEnv(process.env);
  expect(client, "iqClientFromEnv must build from env (RPC+signer+db/table set)").not.toBeNull();

  const ledger = iqLedger(client!);
  const intent = `iq:e2e:${Date.now()}`;
  const row = await ledger.append(intent, "value-v1");
  // append() returns the row with the real Solana tx signature folded in — that tx
  // sig IS the wallet's signature over the write (the "signed" in signed history).
  expect(typeof row.sig).toBe("string");
  expect(row.sig.length).toBeGreaterThan(40);

  // Read the append-only history back through the CORRECTED PDA derivation
  // (getDbRootPda(toSeedBytes(id)) → getTablePda(dbRootPda, …)) — the value must
  // round-trip. NOTE: the on-chain row's own `sig` field is "" by design — the row
  // is written before its tx signature exists, so the authoritative signature is the
  // writeRow tx sig (asserted above) / chain-recoverable, not a row column. Surfacing
  // per-row sig on read-back is a documented follow-up in iq-ledger.ts.
  await new Promise((r) => setTimeout(r, 12000));
  const found = await ledger.find(intent);
  expect(found, "the just-written row must be readable back via the fixed derivation").not.toBeUndefined();
  expect(found!.result).toBe("value-v1");
  expect(found!.intent).toBe(intent);
}, 120_000);

test("placeholder so the file is never an empty suite when IQ_E2E is unset", () => {
  // bun test treats a file with only skipped tests as 0 assertions; this keeps it green.
  expect(LIVE === true || LIVE === false).toBe(true);
});
