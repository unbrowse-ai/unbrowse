/**
 * Keychain Wallet — Stores Solana private key in OS keychain with file fallback.
 *
 * macOS: Uses `security` CLI (Keychain Services)
 * Linux/CI: Falls back to wallet.json with chmod 600
 *
 * The public wallet address (creatorWallet) stays in wallet.json since it's not sensitive.
 * Only the private key (solanaPrivateKey) is promoted to keychain storage.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const KEYCHAIN_SERVICE = "unbrowse-solana";
const WALLET_DIR = join(homedir(), ".openclaw", "unbrowse");
const WALLET_FILE = join(WALLET_DIR, "wallet.json");

export interface WalletConfig {
  creatorWallet?: string;
  solanaPrivateKey?: string;
}

interface WalletFileData {
  creatorWallet?: string;
  solanaPrivateKey?: string;
  keychain?: boolean;
}

/** Escape a shell argument for safe use in shell commands. */
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** Check if macOS Keychain is available. */
export function isKeychainAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execSync("which security", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function readKeychainKey(): string | null {
  if (!isKeychainAvailable()) return null;
  const user = process.env.USER || "unbrowse";
  try {
    return execSync(
      `security find-generic-password -s ${shellEscape(KEYCHAIN_SERVICE)} -a ${shellEscape(user)} -w 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim() || null;
  } catch {
    return null;
  }
}

function writeKeychainKey(privateKey: string): boolean {
  if (!isKeychainAvailable()) return false;
  const user = process.env.USER || "unbrowse";
  try {
    execSync(
      `security add-generic-password -s ${shellEscape(KEYCHAIN_SERVICE)} -a ${shellEscape(user)} -w ${shellEscape(privateKey)} -U`,
      { encoding: "utf-8", timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

export function deleteKeychainKey(): boolean {
  if (!isKeychainAvailable()) return false;
  const user = process.env.USER || "unbrowse";
  try {
    execSync(
      `security delete-generic-password -s ${shellEscape(KEYCHAIN_SERVICE)} -a ${shellEscape(user)} 2>/dev/null`,
      { stdio: "ignore", timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

// ── File helpers ──────────────────────────────────────────────────────────

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

// ── Public API ────────────────────────────────────────────────────────────

/** Load wallet config: private key from keychain (preferred) or file fallback. */
export function loadWallet(): WalletConfig {
  const file = readWalletFile();

  // Fix overly permissive file permissions on load
  if (existsSync(WALLET_FILE)) {
    try {
      const mode = statSync(WALLET_FILE).mode & 0o777;
      if (mode & 0o077) {
        chmodSync(WALLET_FILE, 0o600);
      }
    } catch { /* stat failed */ }
  }

  // Try keychain first for private key
  const keychainKey = readKeychainKey();
  if (keychainKey) {
    return { creatorWallet: file.creatorWallet, solanaPrivateKey: keychainKey };
  }

  // Fall back to file (Linux, CI, pre-migration)
  return { creatorWallet: file.creatorWallet, solanaPrivateKey: file.solanaPrivateKey };
}

/** Save wallet config: private key to keychain (preferred), public address to file. */
export function saveWallet(data: { creatorWallet?: string; solanaPrivateKey?: string }): void {
  const existing = readWalletFile();

  if (data.solanaPrivateKey) {
    const stored = writeKeychainKey(data.solanaPrivateKey);
    if (stored) {
      // Key is in keychain — don't write it to file
      const fileData: WalletFileData = {
        creatorWallet: data.creatorWallet ?? existing.creatorWallet,
        keychain: true,
      };
      writeWalletFile(fileData);
    } else {
      // Keychain unavailable — fall back to file with restricted permissions
      const fileData: WalletFileData = {
        creatorWallet: data.creatorWallet ?? existing.creatorWallet,
        solanaPrivateKey: data.solanaPrivateKey,
      };
      writeWalletFile(fileData);
    }
  } else if (data.creatorWallet) {
    // Only updating public address
    writeWalletFile({ ...existing, creatorWallet: data.creatorWallet });
  }
}

/**
 * Migrate existing plaintext key from wallet.json to OS keychain.
 * Returns true if migration occurred.
 */
export function migrateToKeychain(): boolean {
  if (!isKeychainAvailable()) return false;

  const file = readWalletFile();
  if (!file.solanaPrivateKey) return false;
  if (file.keychain) return false;

  // Already in keychain? Don't duplicate
  if (readKeychainKey()) return false;

  const stored = writeKeychainKey(file.solanaPrivateKey);
  if (!stored) return false;

  // Remove private key from file, mark as migrated
  writeWalletFile({
    creatorWallet: file.creatorWallet,
    keychain: true,
  });

  return true;
}
