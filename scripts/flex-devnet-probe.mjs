#!/usr/bin/env bun
/**
 * Flex devnet probe — proves the real on-chain create-escrow round-trip
 * against the deployed FLEX program (EcfUgNgDXmBx4Xns2qZLE54xpM7V1N6PL8MdDW1syujS,
 * devnet-only) using the @faremeter/flex-solana instruction builders + the
 * @solana/kit v6 send pipeline. Spends only free devnet SOL.
 *
 * This is the send-pipeline learning rig for packages/sdk/src/flex.ts's
 * stubbed `fundEscrow` sender. Witness: an escrow PDA readable on devnet.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// Devnet RPC (Helius keyed endpoint kept in a gitignored file, never inlined).
// Falls back to the public devnet faucet RPC.
function devnetRpcUrl() {
  if (process.env.FLEX_DEVNET_RPC) return process.env.FLEX_DEVNET_RPC.trim();
  try { return readFileSync(homedir() + "/.unbrowse/flex-devnet/rpc.txt", "utf8").trim(); }
  catch { return "https://api.devnet.solana.com"; }
}
const DEVNET_RPC = devnetRpcUrl();
const DEVNET_WSS = DEVNET_RPC.replace(/^https/, "wss");

// Fresh, persisted devnet owner keypair (NOT a real-money wallet — the FLEX
// program is devnet-only, so mainnet keys carry no benefit and needless risk).
function loadOwnerKeypairBytes() {
  const raw = JSON.parse(readFileSync(homedir() + "/.unbrowse/flex-devnet/owner.json", "utf8"));
  return Uint8Array.from(raw);
}

async function main() {
  const kit = await import("@solana/kit");
  const flex = await import("@faremeter/flex-solana");
  const {
    createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes,
    createTransactionMessage, setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
    signTransactionMessageWithSigners, sendAndConfirmTransactionFactory,
    getSignatureFromTransaction, airdropFactory, lamports, pipe, address,
    generateKeyPairSigner,
  } = kit;

  const rpc = createSolanaRpc(DEVNET_RPC);
  const rpcSubscriptions = createSolanaRpcSubscriptions(DEVNET_WSS);
  const owner = await createKeyPairSignerFromBytes(loadOwnerKeypairBytes());
  console.log("[probe] owner", owner.address);

  // Ensure owner has devnet SOL for rent + fees.
  const bal = await rpc.getBalance(owner.address).send();
  console.log("[probe] owner devnet SOL", Number(bal.value) / 1e9);
  if (Number(bal.value) < 0.05e9) {
    console.log("[probe] airdropping 1 devnet SOL ...");
    const airdrop = airdropFactory({ rpc, rpcSubscriptions });
    await airdrop({ commitment: "confirmed", lamports: lamports(1_000_000_000n), recipientAddress: owner.address });
    const b2 = await rpc.getBalance(owner.address).send();
    console.log("[probe] owner devnet SOL after airdrop", Number(b2.value) / 1e9);
  }

  // A facilitator address is stored in the escrow; generate one for the probe.
  const facilitator = await generateKeyPairSigner();
  console.log("[probe] facilitator", facilitator.address);

  const index = BigInt(Date.now());
  const createIx = await flex.getCreateEscrowInstructionAsync({
    owner,
    index,
    facilitator: facilitator.address,
    refundTimeoutSlots: 150n,
    deadmanTimeoutSlots: 432000n,
    maxSessionKeys: 5,
  });
  const escrowAddress = createIx.accounts[1].address;
  console.log("[probe] derived escrow PDA", escrowAddress, "index", index.toString());

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([createIx], m),
  );
  const signedTx = await signTransactionMessageWithSigners(txMessage);
  const sig = getSignatureFromTransaction(signedTx);
  console.log("[probe] sending create-escrow tx", sig);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx, { commitment: "confirmed" });
  console.log("[probe] CONFIRMED https://solscan.io/tx/" + sig + "?cluster=devnet");

  // Witness: the escrow account now exists and is owned by the FLEX program.
  const acct = await rpc.getAccountInfo(address(escrowAddress), { encoding: "base64" }).send();
  if (!acct.value) throw new Error("escrow account not found after create");
  console.log("[probe] ESCROW ON-CHAIN owner-program", acct.value.owner, "lamports", acct.value.lamports);
  if (acct.value.owner !== flex.FLEX_PROGRAM_ADDRESS) {
    throw new Error(`escrow owned by ${acct.value.owner}, expected FLEX program`);
  }
  // Structured proof for downstream wiring.
  console.log("PROBE_RESULT " + JSON.stringify({
    ok: true, network: "devnet", escrow: escrowAddress,
    owner: owner.address, facilitator: facilitator.address,
    createTx: sig, index: index.toString(),
  }));
}

main().catch((e) => { console.error("[probe] FAIL", e?.message ?? e); process.exit(1); });
