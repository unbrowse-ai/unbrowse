/**
 * Witness for crypto-was-all-you-needed Phase 3 — the paper's CENTRAL CLAIM wired end-to-end:
 *   declare → persist on-chain (sealed, signed) → NEW PROCESS (empty local) → cold-hydrate
 *   → resolve the hole → terminal pointer `iqseal:<txSig>` → reveal value WITH the bound wallet;
 *   the same reveal DENIED without it.
 *
 * Hermetic: real IQ crypto + tweetnacl, a stub IqClient standing in for the on-chain table, and
 * memIO standing in for the inscription store (the chain is the only thing mocked — the crypto,
 * the hole-pointer routing, the hash-chained ledger, and the cold-hydrate are all the real code
 * paths). No chain, no SOL. The live codeIn leg is proven separately (SEAL_ROUNDTRIP_OK).
 */
import { test, expect } from "bun:test";
import iq from "@iqlabs-official/solana-sdk";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  sealHoleValueOnChain, revealOnChainSealedHole, isOnChainSealedHole,
  type SignMessage, type OnChainIO,
} from "../src/values/iq-sealed-value.js";
import { hydrateLocalLedgerFromChain, iqLedger, type IqClient } from "../src/values/iq-ledger.js";
import { type AsyncResolutionLedger, type ResolutionRecord, GENESIS, recordHash } from "../src/values/async-resolution.js";

const crypto = (iq as any).default?.crypto ?? (iq as any).crypto;
const signerFor = (kp: Keypair): SignMessage => async (msg) => nacl.sign.detached(msg, kp.secretKey);

/** In-memory inscription store (the on-chain sealed-value blobs). */
function memIO(): OnChainIO & { store: Map<string, string> } {
  const store = new Map<string, string>();
  let n = 0;
  return {
    store,
    async codeIn(data) { const sig = `seal_${n++}`; store.set(sig, data); return sig; },
    async readCodeIn(txSig) { return { data: store.get(txSig) ?? null }; },
  };
}

/** A stub on-chain TABLE (the resolution ledger) — append-only rows, exactly what live IQ returns. */
function memIqClient(): IqClient {
  const rows: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    async writeRow(rowJson) { rows.push(JSON.parse(rowJson)); return `row_${n++}`; },
    async readRows() { return rows.map((r) => ({ ...r })); },
  };
}

/** A real in-memory local ledger (the fresh machine's fast tier). */
function memLedger(): AsyncResolutionLedger {
  const rows: ResolutionRecord[] = [];
  return {
    async find(intent) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].intent === intent) return rows[i]; return undefined; },
    async history(intent) { return rows.filter((r) => r.intent === intent); },
    async append(intent, result, ts) {
      const seq = rows.length, prev = rows.length ? rows[rows.length - 1].hash : GENESIS;
      const rec: ResolutionRecord = { seq, intent, result, prev, hash: recordHash({ intent, prev, result, seq }), ts };
      rows.push(rec); return rec;
    },
  };
}

test("end-to-end: declare → seal on-chain → new process hydrates → resolve → reveal only with the bound wallet", async () => {
  const owner = Keypair.generate();        // the wallet the contract value is bound to
  const intruder = Keypair.generate();      // any other wallet
  const intent = "ptr:contract/secret-terms";
  const value = "the-contract-value::rendered-only-on-owner-auth::v1";

  // ── PROCESS 1: declare + persist. The value is sealed on-chain (P1); the resolution row
  //    stores the HOLE POINTER (iqseal:<txSig>), never the value, on the signed on-chain ledger.
  const io = memIO();
  const holePointer = await sealHoleValueOnChain(crypto, signerFor(owner), io, value);
  expect(isOnChainSealedHole(holePointer)).toBe(true);

  const chainClient = memIqClient();
  await iqLedger(chainClient).append(intent, holePointer);          // signed on-chain row: intent → pointer
  // The on-chain row carries only the pointer, never the plaintext value.
  const rawRows = JSON.stringify(await chainClient.readRows());
  expect(rawRows).not.toContain("rendered-only-on-owner-auth");

  // ── PROCESS 2: a FRESH machine — empty local ledger, but the same io/chain are durable.
  const local = memLedger();
  expect(await local.find(intent)).toBeUndefined();                 // cold: nothing local yet
  const hy = await hydrateLocalLedgerFromChain(chainClient, local); // P2 cold-hydrate the history
  expect(hy.hydrated).toBe(1);

  // Resolve the hole locally → its terminal pointer.
  const resolved = await local.find(intent);
  expect(resolved?.result).toBe(holePointer);

  // Reveal WITH the bound wallet → the value is rendered.
  const rendered = await revealOnChainSealedHole(crypto, signerFor(owner), io, resolved!.result);
  expect(rendered).toBe(value);

  // Reveal WITHOUT the bound wallet → denied (the wallet-gate holds).
  let leaked = false;
  try { leaked = (await revealOnChainSealedHole(crypto, signerFor(intruder), io, resolved!.result)) === value; } catch { leaked = false; }
  expect(leaked).toBe(false);
});

test("a non-on-chain pointer is refused by the on-chain reveal path (shape-routed, not guessed)", async () => {
  const io = memIO();
  await expect(revealOnChainSealedHole(crypto, signerFor(Keypair.generate()), io, "sha256:deadbeef"))
    .rejects.toThrow(/not an on-chain sealed hole/);
});
