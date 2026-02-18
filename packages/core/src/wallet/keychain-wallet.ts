/**
 * Wallet storage
 *
 * Security-hardened build: no OS shell/keychain calls from the plugin package.
 * Wallet data is stored in ~/.openclaw/unbrowse/wallet.json with 0600 permissions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WALLET_DIR = join(homedir(), ".openclaw", "unbrowse");
const WALLET_FILE = join(WALLET_DIR, "wallet.json");
const ALLOW_FILE_PRIVATE_KEY = true;

export interface WalletConfig {
  creatorWallet?: string;
  solanaPrivateKey?: string;
}

interface WalletFileData {
  creatorWallet?: string;
  solanaPrivateKey?: string;
  keychain?: boolean;
}

export function isWalletFileFallbackEnabled(): boolean {
  return ALLOW_FILE_PRIVATE_KEY;
}

export function isKeychainAvailable(): boolean {
  return false;
}

export function deleteKeychainKey(): boolean {
  return false;
}

function readWalletFile(): WalletFileData {
  try {
    return JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeWalletFile(data: WalletFileData): void {
  mkdirSync(WALLET_DIR, { recursive: true });
  writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(WALLET_FILE, 0o600);
}

export function loadWallet(): WalletConfig {
  const file = readWalletFile();

  if (existsSync(WALLET_FILE)) {
    try {
      const mode = statSync(WALLET_FILE).mode & 0o777;
      if (mode & 0o077) {
        chmodSync(WALLET_FILE, 0o600);
      }
    } catch {
      // ignore
    }
  }

  return {
    creatorWallet: file.creatorWallet,
    solanaPrivateKey: file.solanaPrivateKey,
  };
}

export function saveWallet(data: { creatorWallet?: string; solanaPrivateKey?: string }): void {
  const existing = readWalletFile();
  const next: WalletFileData = {
    creatorWallet: data.creatorWallet ?? existing.creatorWallet,
    solanaPrivateKey: data.solanaPrivateKey ?? existing.solanaPrivateKey,
    keychain: false,
  };
  writeWalletFile(next);
}

export function migrateToKeychain(): boolean {
  return false;
}
