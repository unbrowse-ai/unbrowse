export const RECENT_WALLETS_STORAGE_KEY = "unbrowse_recent_wallets";

export function normalizeWalletAddress(value: string): string {
  return value.trim();
}

export function readRecentWallets(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(RECENT_WALLETS_STORAGE_KEY);
    return stored ? JSON.parse(stored) as string[] : [];
  } catch {
    return [];
  }
}

export function storeRecentWallet(walletAddress: string): string[] {
  if (typeof window === "undefined") return [];
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return readRecentWallets();

  const next = [normalized, ...readRecentWallets().filter((entry) => entry !== normalized)].slice(0, 6);
  localStorage.setItem(RECENT_WALLETS_STORAGE_KEY, JSON.stringify(next));
  return next;
}
