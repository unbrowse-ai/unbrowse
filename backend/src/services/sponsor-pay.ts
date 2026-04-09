/**
 * Sponsor USDC payment — direct transfer from Lewis's wallet to route creators.
 *
 * No Cascade splits, no intermediaries. Just: signer → USDC SPL transfer → recipient.
 * Uses @solana/kit (v2, CF Worker compatible).
 *
 * All amounts in micro-cents internally, converted to USDC (6 decimals) for on-chain.
 */

import type { Env } from "../types.js";

// USDC on Solana mainnet (6 decimals)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

interface TransferResult {
  success: boolean;
  signature?: string;
  error?: string;
}

/**
 * Send USDC from the sponsor wallet to a recipient.
 * @param env - Worker env with CASCADE_SIGNER_SECRET_KEY and CASCADE_RPC_URL
 * @param recipientAddress - Solana wallet address of the route creator
 * @param amountUc - Amount in micro-cents (1,000,000 µ¢ = $1 = 1 USDC)
 */
export async function sendSponsorPayment(
  env: Env,
  recipientAddress: string,
  amountUc: number,
): Promise<TransferResult> {
  const secretKey = env.CASCADE_SIGNER_SECRET_KEY?.trim();
  const rpcUrl = env.CASCADE_RPC_URL?.trim();

  if (!secretKey || !rpcUrl) {
    return { success: false, error: "missing signer key or RPC URL" };
  }

  if (!recipientAddress?.trim() || amountUc <= 0) {
    return { success: false, error: "invalid recipient or amount" };
  }

  // Convert µ¢ to USDC base units (both have 6 decimal places, so 1 µ¢ = 1 base unit)
  // $1 = 1,000,000 µ¢ = 1,000,000 USDC base units = 1 USDC
  const usdcAmount = BigInt(amountUc);

  try {
    const kit = await import("@solana/kit");
    const { getTransferInstruction } = await import("@solana-program/token");

    // Create RPC + signer
    const rpc = kit.createSolanaRpc(rpcUrl);
    const signer = await kit.createKeyPairSignerFromBytes(await decodeSecretKey(secretKey));
    const senderAddress = kit.address(signer.address);
    const recipientAddr = kit.address(recipientAddress.trim());
    const usdcMint = kit.address(USDC_MINT);

    // Derive Associated Token Accounts
    const senderAta = await findAta(kit, senderAddress, usdcMint);
    const recipientAta = await findAta(kit, recipientAddr, usdcMint);

    // Build transfer instruction
    const transferIx = getTransferInstruction({
      source: senderAta,
      destination: recipientAta,
      authority: senderAddress,
      amount: usdcAmount,
    });

    // Build + sign + send transaction
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const tx = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      (msg) => kit.setTransactionMessageFeePayer(senderAddress, msg),
      (msg) => kit.setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => kit.appendTransactionMessageInstruction(transferIx, msg),
    );

    const signedTx = await kit.signTransactionMessageWithSigners(tx);
    const signature = await kit.sendAndConfirmTransactionFactory({ rpc })(signedTx, {
      commitment: "confirmed",
    });

    console.log(`[sponsor-pay] sent ${amountUc} µ¢ USDC to ${recipientAddress}: ${signature}`);
    return { success: true, signature: String(signature) };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[sponsor-pay] transfer failed: ${msg}`);
    return { success: false, error: msg };
  }
}

// --- Helpers ---

async function decodeSecretKey(raw: string): Promise<Uint8Array> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }
  // Hex-encoded
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 64) {
    const bytes = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < trimmed.length; i += 2) {
      bytes[i / 2] = parseInt(trimmed.slice(i, i + 2), 16);
    }
    return bytes;
  }
  // Base58
  const { default: bs58 } = await import("bs58") as any;
  return bs58.decode(trimmed);
}

async function findAta(
  kit: typeof import("@solana/kit"),
  owner: ReturnType<typeof kit.address>,
  mint: ReturnType<typeof kit.address>,
): Promise<ReturnType<typeof kit.address>> {
  // ATA = PDA([owner, TOKEN_PROGRAM, mint], ATA_PROGRAM)
  const TOKEN_PROGRAM = kit.address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ATA_PROGRAM = kit.address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

  const [ata] = await kit.getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [
      kit.getAddressEncoder().encode(owner),
      kit.getAddressEncoder().encode(TOKEN_PROGRAM),
      kit.getAddressEncoder().encode(mint),
    ],
  });
  return ata;
}
