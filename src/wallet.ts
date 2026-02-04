/**
 * Wallet — Ed25519 keypair management for marketplace signing.
 *
 * Uses Node.js built-in crypto (Ed25519 support since Node 16).
 * Wallet stored in ~/.openclaw/unbrowse/wallet.json.
 */

import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WALLET_DIR = join(homedir(), ".openclaw", "unbrowse");
const WALLET_FILE = join(WALLET_DIR, "wallet.json");

export interface Wallet {
  pubkey: string;
  createdAt: string;
}

interface StoredWallet {
  pubkey: string;
  privateKey: string;
  createdAt: string;
}

/** Create a new Ed25519 wallet and store it. */
export function walletCreate(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const pubkeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const privkeyHex = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("hex");
  const createdAt = new Date().toISOString();

  if (!existsSync(WALLET_DIR)) {
    mkdirSync(WALLET_DIR, { recursive: true });
  }

  const stored: StoredWallet = {
    pubkey: pubkeyHex,
    privateKey: privkeyHex,
    createdAt,
  };

  writeFileSync(WALLET_FILE, JSON.stringify(stored, null, 2), "utf-8");

  return { pubkey: pubkeyHex, createdAt };
}

/** Get existing wallet, or null if none exists. */
export function walletGet(): Wallet | null {
  if (!existsSync(WALLET_FILE)) return null;
  try {
    const stored: StoredWallet = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
    return { pubkey: stored.pubkey, createdAt: stored.createdAt };
  } catch {
    return null;
  }
}

/** Get existing wallet or create a new one. */
export function walletGetOrCreate(): Wallet {
  const existing = walletGet();
  if (existing) return existing;
  return walletCreate();
}

/** Load the stored private key as a Node.js KeyObject. */
function loadPrivateKey(): ReturnType<typeof createPrivateKey> {
  if (!existsSync(WALLET_FILE)) {
    throw new Error("No wallet found. Create one first.");
  }
  const stored: StoredWallet = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  const privkeyBytes = Buffer.from(stored.privateKey, "hex");

  // Build PKCS8 DER for Ed25519: fixed prefix + 32-byte key
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const pkcs8Der = Buffer.concat([pkcs8Prefix, privkeyBytes]);

  return createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
}

/** Load public key from hex as a Node.js KeyObject. */
function loadPublicKey(pubkeyHex: string): ReturnType<typeof createPublicKey> {
  const pubkeyBytes = Buffer.from(pubkeyHex, "hex");

  // Build SPKI DER for Ed25519: fixed prefix + 32-byte key
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const spkiDer = Buffer.concat([spkiPrefix, pubkeyBytes]);

  return createPublicKey({ key: spkiDer, format: "der", type: "spki" });
}

/** Sign a message with the wallet's private key. Returns hex-encoded signature. */
export function walletSign(message: string): string {
  const privateKey = loadPrivateKey();
  const signature = sign(null, Buffer.from(message, "utf-8"), privateKey);
  return signature.toString("hex");
}

/** Sign a payment message for skill download. Returns hex-encoded signature. */
export function walletSignPayment(skillId: string, priceUsdc: number, recipient: string): string {
  const message = JSON.stringify({ skillId, priceUsdc, recipient, timestamp: Date.now() });
  return walletSign(message);
}

/** Verify a signature against a message and public key. */
export function walletVerify(message: string, signatureHex: string, pubkeyHex: string): boolean {
  try {
    const publicKey = loadPublicKey(pubkeyHex);
    const signature = Buffer.from(signatureHex, "hex");
    return verify(null, Buffer.from(message, "utf-8"), publicKey, signature);
  } catch {
    return false;
  }
}

/** Get wallet public key hex, or null if no wallet. */
export function walletPubkey(): string | null {
  const wallet = walletGet();
  return wallet?.pubkey ?? null;
}

/** Delete the wallet. */
export function walletDelete(): boolean {
  if (!existsSync(WALLET_FILE)) return false;
  try {
    unlinkSync(WALLET_FILE);
    return true;
  } catch {
    return false;
  }
}
