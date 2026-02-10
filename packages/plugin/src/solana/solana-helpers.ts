/**
 * Solana helpers
 *
 * Centralizes dynamic imports + base58 key handling so we:
 * - Keep error messaging consistent when Solana native bindings fail
 * - Avoid duplicating Keypair decode/sign logic across the codebase
 */

type Web3Module = typeof import("@solana/web3.js");
type SplTokenModule = typeof import("@solana/spl-token");

function solanaLoadError(err: unknown): Error {
  const msg = (err as Error)?.message ?? String(err);
  return new Error(
    `Solana native bindings failed to load (Node ${process.version}). ` +
      `Try Node v22 LTS. Error: ${msg}`,
  );
}

export async function loadWeb3(): Promise<Web3Module> {
  try {
    return await import("@solana/web3.js");
  } catch (err) {
    throw solanaLoadError(err);
  }
}

export async function loadSplToken(): Promise<SplTokenModule> {
  try {
    return await import("@solana/spl-token");
  } catch (err) {
    // spl-token can fail if web3 native bindings fail too; keep message consistent.
    throw solanaLoadError(err);
  }
}

export async function loadBs58(): Promise<typeof import("bs58")> {
  return import("bs58");
}

export async function loadNacl(): Promise<typeof import("tweetnacl")> {
  return import("tweetnacl");
}

export async function keypairFromBase58PrivateKey(privateKeyB58: string) {
  const { Keypair } = await loadWeb3();
  const bs58mod = await loadBs58();
  const bs58: any = (bs58mod as any).default ?? bs58mod;
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKeyB58));
  } catch {
    throw new Error("Invalid Solana private key. Must be base58-encoded.");
  }
}

export async function generateBase58Keypair(): Promise<{ publicKey: string; privateKeyB58: string }> {
  const { Keypair } = await loadWeb3();
  const bs58mod = await loadBs58();
  const bs58: any = (bs58mod as any).default ?? bs58mod;
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKeyB58: bs58.encode(keypair.secretKey),
  };
}

export async function signEd25519MessageBase58(opts: {
  privateKeyB58: string;
  message: string;
}): Promise<string> {
  const bs58mod = await loadBs58();
  const bs58: any = (bs58mod as any).default ?? bs58mod;
  // tweetnacl is CJS; dynamic import may return { default: nacl } in ESM.
  const naclMod = await loadNacl();
  const nacl: any = (naclMod as any).default ?? naclMod;
  const keypair = await keypairFromBase58PrivateKey(opts.privateKeyB58);

  const messageBytes = new TextEncoder().encode(opts.message);
  const sig = nacl.sign.detached(messageBytes, keypair.secretKey);
  return bs58.encode(sig);
}
