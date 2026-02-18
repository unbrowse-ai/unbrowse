/**
 * Solana helpers
 *
 * Centralizes dynamic imports + base58 key handling so we:
 * - Keep error messaging consistent when Solana native bindings fail
 * - Avoid duplicating Keypair decode/sign logic across the codebase
 */

type Web3Module = typeof import("@solana/web3.js");
type SplTokenModule = typeof import("@solana/spl-token");
type Base58Module = typeof import("@scure/base");

type BasicPublicKey = {
  toBase58: () => string;
  toBytes: () => Uint8Array;
};

export type BasicKeypair = {
  publicKey: BasicPublicKey;
  secretKey: Uint8Array;
};

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

export async function loadBase58(): Promise<Base58Module["base58"]> {
  const mod = await import("@scure/base");
  const codec = (mod as any)?.base58;
  if (!codec || typeof codec.encode !== "function" || typeof codec.decode !== "function") {
    throw new Error("Base58 codec unavailable");
  }
  return codec;
}

export async function loadNacl(): Promise<typeof import("tweetnacl")> {
  return import("tweetnacl");
}

function normalizeSecretKey(decoded: Uint8Array, nacl: any): Uint8Array {
  if (decoded.length === 64) return decoded;
  if (decoded.length === 32) {
    return nacl.sign.keyPair.fromSeed(decoded).secretKey;
  }
  throw new Error("Invalid Solana private key. Must decode to 32 or 64 bytes.");
}

function toNacl(mod: any): any {
  return mod?.default ?? mod;
}

export async function keypairFromBase58PrivateKey(privateKeyB58: string): Promise<BasicKeypair> {
  const base58 = await loadBase58();
  const nacl = toNacl(await loadNacl());
  let secretKey: Uint8Array;
  let publicKeyBytes: Uint8Array;
  try {
    const decoded = base58.decode(privateKeyB58);
    secretKey = normalizeSecretKey(decoded, nacl);
    publicKeyBytes = nacl.sign.keyPair.fromSecretKey(secretKey).publicKey;
  } catch {
    throw new Error("Invalid Solana private key. Must be base58-encoded.");
  }

  const pub = publicKeyBytes;
  return {
    secretKey,
    publicKey: {
      toBase58: () => base58.encode(pub),
      toBytes: () => pub,
    },
  };
}

export async function keypairFromBase58PrivateKeyWeb3(privateKeyB58: string) {
  const { Keypair } = await loadWeb3();
  const basic = await keypairFromBase58PrivateKey(privateKeyB58);
  return Keypair.fromSecretKey(basic.secretKey);
}

export async function generateBase58Keypair(): Promise<{ publicKey: string; privateKeyB58: string }> {
  const base58 = await loadBase58();
  const nacl = toNacl(await loadNacl());
  const keypair = nacl.sign.keyPair();
  return {
    publicKey: base58.encode(keypair.publicKey),
    privateKeyB58: base58.encode(keypair.secretKey),
  };
}

export async function signEd25519MessageBase58(opts: {
  privateKeyB58: string;
  message: string;
}): Promise<string> {
  const base58 = await loadBase58();
  const nacl = toNacl(await loadNacl());
  const keypair = await keypairFromBase58PrivateKey(opts.privateKeyB58);

  const messageBytes = new TextEncoder().encode(opts.message);
  const sig = nacl.sign.detached(messageBytes, keypair.secretKey);
  return base58.encode(sig);
}
