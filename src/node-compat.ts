/**
 * Node.js Compatibility Layer
 * 
 * Handles compatibility issues with native bindings (especially @solana/web3.js)
 * across different Node.js versions. Node v24+ has breaking changes in the
 * N-API interface that affect Ed25519 native bindings.
 */

/** Get the current Node.js major version */
export function getNodeMajorVersion(): number {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  return major;
}

/** Check if we're running on a Node version with known native binding issues */
export function hasKnownNativeBindingIssues(): boolean {
  const major = getNodeMajorVersion();
  // Node v24+ has NAPI compatibility issues with @solana/web3.js
  return major >= 24;
}

/** Get a user-friendly error message for Node compatibility issues */
export function getCompatibilityErrorMessage(operation: string, originalError: Error): string {
  const major = getNodeMajorVersion();
  
  if (major >= 24) {
    return `Node.js v${major} compatibility issue during ${operation}.

The @solana/web3.js native bindings have known issues with Node.js v24+.
This affects wallet operations like signing transactions.

Workarounds:
1. Use Node.js v22 LTS (recommended): nvm use 22
2. Wait for an updated @solana/web3.js release

Original error: ${originalError.message}`;
  }
  
  // Generic native binding error
  if (originalError.message.includes('napi') || 
      originalError.message.includes('native') ||
      originalError.message.includes('rust type')) {
    return `Native binding error during ${operation}.

This is likely a Node.js version incompatibility with native Ed25519 bindings.
Current Node: v${process.versions.node}

Try:
1. Rebuild native modules: npm rebuild
2. Use a different Node version: nvm use 22

Original error: ${originalError.message}`;
  }
  
  return originalError.message;
}

/** Wrapper for Solana Keypair operations with better error handling */
export async function createKeypairSafe(privateKeyBase58: string): Promise<{
  publicKey: { toBase58(): string };
  secretKey: Uint8Array;
}> {
  try {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");
    return Keypair.fromSecretKey(bs58.default.decode(privateKeyBase58));
  } catch (error: any) {
    // Check if this is a native binding error
    if (error.message?.includes('napi') || 
        error.message?.includes('native') ||
        error.message?.includes('rust type') ||
        error.message?.includes('array')) {
      throw new Error(getCompatibilityErrorMessage('Keypair creation', error));
    }
    throw error;
  }
}

/** Check if wallet/marketplace operations are available */
export function isWalletOperationsAvailable(): { available: boolean; reason?: string } {
  const major = getNodeMajorVersion();
  
  if (major >= 24) {
    return {
      available: false,
      reason: `Wallet operations require Node.js v22 or earlier. Current: v${major}. Use \`nvm use 22\` to switch.`
    };
  }
  
  return { available: true };
}

/** Log a compatibility warning (once per session) */
const warnedOperations = new Set<string>();
export function warnCompatibilityOnce(operation: string): void {
  if (warnedOperations.has(operation)) return;
  warnedOperations.add(operation);
  
  const major = getNodeMajorVersion();
  if (major >= 24) {
    console.warn(`[unbrowse] ⚠️ Node.js v${major} detected. ${operation} may have issues. Consider using Node v22 LTS.`);
  }
}
