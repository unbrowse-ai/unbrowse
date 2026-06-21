/**
 * iq-sealed-value — "a value rendered only upon authentication of the wallet bound
 * to it" (crypto-was-all-you-needed). A value is sealed to a wallet's deterministic
 * X25519 key (derived from the wallet's own signature, so the wallet IS the key —
 * no separate key to manage), and revealed only by deriving that same key again.
 *
 * Two layers, kept distinct so the crypto is testable without a chain:
 *   - sealForWallet / revealForWallet — PURE: derive→encrypt / derive→decrypt. No I/O.
 *   - sealValueOnChain / revealValueOnChain — persist the sealed envelope on-chain via
 *     IQLabs `codeIn` (wallet-signed) and read it back. Thin wrappers over the pure core.
 *
 * The on-chain history is git-like + signed (see iq-ledger.ts); this adds the VALUE
 * itself, sealed, so the chain row resolves to a value only the bound wallet can render.
 * Proven live on mainnet (codeIn round-trip, SEAL_ROUNDTRIP_OK).
 */

/** The IQ crypto surface this module needs — a thin slice of @iqlabs-official/solana-sdk. */
interface IqCrypto {
  deriveX25519Keypair(signMessage: (msg: Uint8Array) => Promise<Uint8Array>): Promise<{ privKey: Uint8Array; pubKey: Uint8Array }>;
  bytesToHex(b: Uint8Array): string;
  dhEncrypt(recipientPubHex: string, plaintext: Uint8Array): Promise<{ senderPub: string; iv: string; ciphertext: string }>;
  dhDecrypt(privKey: Uint8Array, senderPubHex: string, ivHex: string, ciphertextHex: string): Promise<Uint8Array>;
}

/** A wallet's sign function (ed25519 over a message) — the only authority the seal needs. */
export type SignMessage = (msg: Uint8Array) => Promise<Uint8Array>;

/** The sealed envelope persisted on-chain — opaque without the bound wallet. */
export interface SealedEnvelope {
  senderPub: string;
  iv: string;
  ciphertext: string;
}

/** Seal `value` so ONLY the wallet behind `signMessage` can later reveal it. Pure (no I/O). */
export async function sealForWallet(crypto: IqCrypto, signMessage: SignMessage, value: string): Promise<SealedEnvelope> {
  const { pubKey } = await crypto.deriveX25519Keypair(signMessage);
  const enc = await crypto.dhEncrypt(crypto.bytesToHex(pubKey), new TextEncoder().encode(value));
  return { senderPub: enc.senderPub, iv: enc.iv, ciphertext: enc.ciphertext };
}

/** Reveal a sealed envelope — succeeds ONLY for the wallet it was sealed to. Pure (no I/O). */
export async function revealForWallet(crypto: IqCrypto, signMessage: SignMessage, env: SealedEnvelope): Promise<string> {
  const { privKey } = await crypto.deriveX25519Keypair(signMessage);
  const plain = await crypto.dhDecrypt(privKey, env.senderPub, env.iv, env.ciphertext);
  return new TextDecoder().decode(plain);
}

/** The on-chain persistence slice — `codeIn` writes a wallet-signed inscription and
 *  returns its tx signature; `readCodeIn` reads it back. Injected so the wrappers are
 *  deterministically testable with an in-memory stand-in (no chain, no SOL). */
export interface OnChainIO {
  codeIn(data: string): Promise<string>;
  readCodeIn(txSig: string): Promise<{ data: string | null }>;
}

/** Seal `value` to the wallet AND persist the sealed envelope on-chain (wallet-signed).
 *  Returns the tx signature — the on-chain pointer to a value only the wallet can render. */
export async function sealValueOnChain(crypto: IqCrypto, signMessage: SignMessage, io: OnChainIO, value: string): Promise<string> {
  const env = await sealForWallet(crypto, signMessage, value);
  return io.codeIn(JSON.stringify(env));
}

/** Read a sealed value back from its on-chain tx signature and render it — succeeds ONLY
 *  for the wallet it was sealed to. Throws (never silently empties) when the blob is missing. */
export async function revealValueOnChain(crypto: IqCrypto, signMessage: SignMessage, io: OnChainIO, txSig: string): Promise<string> {
  const { data } = await io.readCodeIn(txSig);
  if (data == null) throw new Error(`sealed value not found on-chain for tx ${txSig}`);
  return revealForWallet(crypto, signMessage, JSON.parse(data) as SealedEnvelope);
}

/** Build a real OnChainIO over the IQ SDK + a connection from the IQ env, or null when
 *  not configured (RPC + signer required). The dynamic import keeps the SDK off the cold path. */
export async function onChainIoFromEnv(env: Record<string, string | undefined> = process.env): Promise<OnChainIO | null> {
  const rpc = env.SOLANA_RPC_URL || env.SOLANA_RPC_ENDPOINT;
  const secret = env.IQ_SIGNER_SECRET_KEY;
  if (!rpc || !secret) return null;
  try {
    const sdk = (await import("@iqlabs-official/solana-sdk")).default as {
      writer: { codeIn: (input: { connection: unknown; signer: unknown }, data: string, filename?: string) => Promise<string> };
      reader: { readCodeIn: (txSig: string) => Promise<{ data: string | null }> };
    };
    const { Connection, Keypair } = await import("@solana/web3.js");
    const connection = new Connection(rpc);
    const signer = Keypair.fromSecretKey(
      secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : (await import("bs58")).default.decode(secret),
    );
    return {
      codeIn: (data) => sdk.writer.codeIn({ connection, signer }, data, "sealed-contract-value.json"),
      readCodeIn: (txSig) => sdk.reader.readCodeIn(txSig),
    };
  } catch {
    return null;
  }
}

/**
 * Build the IQ crypto slice + a wallet signMessage from the IQ env (RPC + signer secret),
 * or null when not configured — same presence-gated, fail-closed-to-local rule as
 * iqClientFromEnv. Kept dynamic so the heavy SDK stays off the cold path.
 */
export async function sealerFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<{ crypto: IqCrypto; signMessage: SignMessage } | null> {
  const secret = env.IQ_SIGNER_SECRET_KEY;
  if (!secret) return null;
  try {
    const crypto = (await import("@iqlabs-official/solana-sdk")).default.crypto as IqCrypto;
    const { Keypair } = await import("@solana/web3.js");
    const signer = Keypair.fromSecretKey(
      secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : (await import("bs58")).default.decode(secret),
    );
    const nacl = (await import("tweetnacl")).default;
    const signMessage: SignMessage = async (msg) => nacl.sign.detached(msg, signer.secretKey);
    return { crypto, signMessage };
  } catch {
    return null; // SDK absent / env incomplete — the local wallet-seal path remains.
  }
}
