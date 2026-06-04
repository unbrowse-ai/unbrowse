#!/usr/bin/env bun
/**
 * Flex devnet end-to-end settlement witness — the real x402 owner-credit round-trip
 * against the deployed FLEX program (devnet-only). Proves the north star's
 * "rewards via x402": a paid authorization settles on-chain and CREDITS the
 * owner's token account. Spends only free devnet SOL + a self-minted devnet token.
 *
 * Steps (all real on-chain txns):
 *   1. create escrow (owner)         3. register session key (owner)
 *   2. deposit token into escrow      4. facilitator verify+settle+flush
 *   5. WITNESS: recipient (owner) token-account balance increased by the split.
 *
 * State (fresh devnet keypairs, NOT real-money): ~/.unbrowse/flex-devnet/
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { webcrypto } from "node:crypto";

const HOME = homedir();
const DIR = HOME + "/.unbrowse/flex-devnet";
const RPC_URL = (process.env.FLEX_DEVNET_RPC || readFileSync(DIR + "/rpc.txt", "utf8")).trim();
const WSS_URL = RPC_URL.replace(/^https/, "wss");
const MINT = readFileSync(DIR + "/mint.txt", "utf8").trim();
const RECIP_ATA = readFileSync(DIR + "/recip_ata.txt", "utf8").trim();
const RECIP_WALLET = readFileSync(DIR + "/recipient_wallet.txt", "utf8").trim();
const OWNER_ATA = readFileSync(DIR + "/owner_ata.txt", "utf8").trim();

const bs58encode = (bytes) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { const r = n % 58n; n /= 58n; s = A[Number(r)] + s; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
};

async function tokenBalance(rpc, ata) {
  const r = await rpc.getTokenAccountBalance(ata).send().catch(() => null);
  return r?.value ? Number(r.value.amount) : 0;
}

async function main() {
  const kit = await import("@solana/kit");
  const flex = await import("@faremeter/flex-solana");
  const { createPaymentHandler } = await import("@faremeter/payment-solana/flex/client");
  const { createFacilitatorHandler } = await import("@faremeter/payment-solana/flex/facilitator");
  const {
    createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes,
    createTransactionMessage, setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
    signTransactionMessageWithSigners, sendAndConfirmTransactionFactory,
    getSignatureFromTransaction, pipe, address,
    getProgramDerivedAddress, getAddressEncoder, getU64Encoder, AccountRole,
  } = kit;

  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WSS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  const owner = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(DIR + "/owner.json", "utf8"))));
  console.log("[settle] owner", owner.address, "mint", MINT);

  async function send(instructions, signer = owner, label = "") {
    const { value: bh } = await rpc.getLatestBlockhash().send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const signed = await signTransactionMessageWithSigners(msg);
    const sig = getSignatureFromTransaction(signed);
    try {
      await sendAndConfirm(signed, { commitment: "confirmed" });
    } catch (e) {
      const ctx = e?.context ?? e?.cause?.context;
      const logs = ctx?.logs || ctx?.__serverMessage || e?.cause?.context?.logs;
      console.error(`[settle] ${label} SEND FAILED:`, e?.message);
      if (logs) console.error(`[settle] ${label} program logs:\n` + (Array.isArray(logs) ? logs.join("\n") : JSON.stringify(logs)));
      throw e;
    }
    if (label) console.log(`[settle] ${label} tx ${sig}`);
    return sig;
  }

  // Facilitator signer = owner (owner holds the devnet SOL; the program only
  // checks the escrow's stored facilitator signs the submit — owner satisfies it).
  const facilitator = owner;
  console.log("[settle] facilitator", facilitator.address);

  // 1. create escrow (facilitator field = the facilitator signer).
  const index = BigInt(Date.now());
  const createIx = await flex.getCreateEscrowInstructionAsync({
    owner, index, facilitator: facilitator.address,
    refundTimeoutSlots: 150n, deadmanTimeoutSlots: 432000n, maxSessionKeys: 5,
  });
  const escrow = createIx.accounts[1].address;
  await send([createIx], owner, "create-escrow " + escrow);

  // 2. deposit token into escrow (depositor=owner, source=owner ATA).
  const depositAmount = 1_000_000_000n; // 1 token (9 decimals default mint)
  const depositIx = await flex.getDepositInstructionAsync({
    depositor: owner, escrow, mint: address(MINT), source: address(OWNER_ATA), amount: depositAmount,
  });
  await send([depositIx], owner, "deposit");

  // 3. session key — webcrypto Ed25519; address = base58(raw pubkey).
  const sk = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey("raw", sk.publicKey));
  const sessionKeyAddress = bs58encode(rawPub);
  console.log("[settle] session key", sessionKeyAddress);
  // Exercise the SDK's real sender (proves packages/sdk/src/flex.ts::registerSessionKey
  // is wired end-to-end, not the old throw-stub).
  const sdkFlex = await import("../packages/sdk/src/flex.ts");
  const reg = await sdkFlex.registerSessionKey({
    walletAddress: owner.address, escrowAddress: escrow, sessionKeyAddress,
    revocationGracePeriodSlots: 0, signer: owner, rpc,
  });
  console.log("[settle] register-session-key (via SDK) tx", reg.txSignature);

  // 4. settle via the SAME handlers the prod facilitator uses, on devnet.
  // network = cluster name "devnet" (resolves to the real devnet caip2); the
  // on-wire accept.network must be that caip2 for the requirement matcher.
  const CLUSTER = "devnet";
  const CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const SETTLE = 1_000_000n; // settle 0.001 token to the recipient (owner credit)
  // defaultSplits EMPTY: the 100% receiver split comes from payTo (a WALLET);
  // buildSplits derives its ATA (deriveATA(payTo,mint) == RECIP_ATA).
  const fac = await createFacilitatorHandler(CLUSTER, rpc, facilitator, {
    supportedMints: [address(MINT)],
    defaultSplits: [],
    minGracePeriodSlots: 0n,
    confirmationBufferSlots: 2n, // shrink the finalize wait (must be < escrow refundTimeoutSlots)
    flushIntervalMs: 2000,
  });
  const client = createPaymentHandler({
    network: CLUSTER, escrow: address(escrow), mint: address(MINT),
    sessionKeyPair: sk, sessionKeyAddress: address(sessionKeyAddress), rpc,
  });

  const baseAccept = {
    scheme: "flex", network: CAIP2, amount: SETTLE.toString(),
    asset: MINT, payTo: RECIP_WALLET, maxTimeoutSeconds: 120,
    resource: { url: "https://unbrowse.ai/devnet-witness" },
  };
  const reqs = await fac.getRequirements({ accepts: [baseAccept], resource: { url: "https://unbrowse.ai/devnet-witness" } });
  console.log("[settle] enriched requirements", JSON.stringify(reqs).slice(0, 400));
  const execers = await client({ request: "https://unbrowse.ai/devnet-witness" }, reqs);
  if (!execers.length) throw new Error("client produced no execer for the flex requirement");
  const { payload } = await execers[0].exec();

  const bigintSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
  const before = await tokenBalance(rpc, address(RECIP_ATA));
  const settleResp = await fac.handleSettle(reqs[0], { x402Version: 2, scheme: reqs[0].scheme, network: CAIP2, payload });
  console.log("[settle] handleSettle ->", JSON.stringify(settleResp, bigintSafe).slice(0, 300));
  // submit the hold; the FLEX program is two-phase (submit -> finalize). The
  // background interval finalizes (transfers vault->recipient) after the
  // refund window elapses. Keep the handler ALIVE and poll for the credit.
  const flushed = await fac.flush();
  console.log("[settle] flush(submit) ->", JSON.stringify(flushed, bigintSafe).slice(0, 500));
  const submitTx = flushed?.[0]?.transaction;
  const authorizationId = BigInt(settleResp.transaction); // handleSettle returns authorizationId
  fac.stop(); // drive finalize explicitly (the interval's logger is silent)

  // The FLEX program enforces a refund window: finalize only after
  // submitSlot + refundTimeoutSlots. Wait that out on-chain, then finalize.
  const submitSlot = await rpc.getSlot().send();
  const REFUND_TIMEOUT = 150n;
  const targetSlot = submitSlot + REFUND_TIMEOUT + 4n;
  console.log(`[settle] waiting refund window: submitSlot=${submitSlot} target=${targetSlot}`);
  for (let i = 0; i < 60; i++) {
    const s = await rpc.getSlot().send();
    if (s >= targetSlot) { console.log(`[settle] refund window passed at slot ${s}`); break; }
    await new Promise((r) => setTimeout(r, 4000));
  }

  // 5. Build + send the finalize tx explicitly (mirrors handler.finalizeHold),
  // surfacing any on-chain error. This transfers vault -> recipient (the credit).
  const flexGen = await import("@faremeter/flex-solana");
  const addrEnc = getAddressEncoder();
  const u64Enc = getU64Encoder();
  const te = new TextEncoder();
  const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const [pendingPda] = await getProgramDerivedAddress({ programAddress: flexGen.FLEX_PROGRAM_ADDRESS, seeds: [te.encode("pending"), addrEnc.encode(address(escrow)), u64Enc.encode(authorizationId)] });
  const [vaultPda] = await getProgramDerivedAddress({ programAddress: flexGen.FLEX_PROGRAM_ADDRESS, seeds: [te.encode("token"), addrEnc.encode(address(escrow)), addrEnc.encode(address(MINT))] });
  const finalizeIx = {
    programAddress: flexGen.FLEX_PROGRAM_ADDRESS,
    data: flexGen.getFinalizeInstructionDataEncoder().encode({}),
    accounts: [
      { address: address(escrow), role: AccountRole.WRITABLE },
      { address: facilitator.address, role: AccountRole.WRITABLE_SIGNER, signer: facilitator },
      { address: pendingPda, role: AccountRole.WRITABLE },
      { address: vaultPda, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: address(RECIP_ATA), role: AccountRole.WRITABLE },
    ],
  };
  const finalizeTx = await send([finalizeIx], facilitator, "finalize");

  let after = before;
  for (let i = 0; i < 8; i++) { after = await tokenBalance(rpc, address(RECIP_ATA)); if (after > before) break; await new Promise((r) => setTimeout(r, 4000)); }
  console.log(`[settle] recipient credit: before=${before} after=${after} delta=${after - before}`);
  const tx = finalizeTx || submitTx;
  if (after <= before) throw new Error("NO CREDIT observed — finalize did not transfer to recipient");
  const proof = {
    ok: true, network: "devnet",
    program: "EcfUgNgDXmBx4Xns2qZLE54xpM7V1N6PL8MdDW1syujS",
    note: "Live x402 (Flex) owner-credit settlement witnessed on-chain. The FLEX escrow program is deployed on devnet only (not mainnet), so this is the real, complete owner-credit round-trip on the network where settlement is possible — same @faremeter/flex-solana code the prod facilitator uses.",
    escrow, sessionKey: sessionKeyAddress, recipientAta: RECIP_ATA, recipientWallet: RECIP_WALLET,
    mint: MINT, beforeAtomic: before, afterAtomic: after, creditedAtomic: after - before,
    createEscrowTx: undefined, submitTx, finalizeTx, owner: owner.address, facilitator: facilitator.address,
    witnessedAt: process.env.WITNESS_TS || null,
  };
  const proofPath = process.env.X402_PROOF || (HOME + "/.unbrowse/x402-owner-credit-proof.json");
  await import("node:fs").then((fs) => fs.writeFileSync(proofPath, JSON.stringify(proof, bigintSafe, 2)));
  console.log("[settle] proof written -> " + proofPath);
  console.log("RESULT " + JSON.stringify(proof, bigintSafe));
}
main().catch((e) => { console.error("[settle] FAIL", e?.stack || e?.message || e); process.exit(1); });
