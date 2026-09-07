/**
 * fdry-native — unbrowse's FDRY stake-layer constants and self-description.
 * USDC settles usage; FDRY bonds; route revenue tithes to the Voltr vault → stFDRY NAV.
 */
export const FDRY_MINT = "2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL";
// Production Voltr vault PDA is withheld from the public source tree (operational
// internal) and injected at deploy time via UNBROWSE_FDRY_VAULT.
export const FDRY_VAULT_PDA = process.env.UNBROWSE_FDRY_VAULT ?? "";
export const STFDRY_SYMBOL = "stFDRY";

export const FDRY_DEX_URL =
  "https://dexscreener.com/solana/2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL";

export interface FdryNativePortrait {
  stakeMint: string;
  vaultPda: string;
  lpSymbol: string;
  role: string;
  tithe: string;
  disclosure: string;
}

export function isFdryNativeEnabled(): boolean {
  const raw = process.env.UNBROWSE_FDRY_NATIVE?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

export function fdryNativePortrait(): FdryNativePortrait {
  return {
    stakeMint: FDRY_MINT,
    vaultPda: FDRY_VAULT_PDA,
    lpSymbol: STFDRY_SYMBOL,
    role: "bonds the stake/security layer; never settles everyday route usage",
    tithe: "usage revenue routes USDC → Jupiter FDRY buy → Voltr vault deposit → stFDRY NAV",
    disclosure: "https://getfoundry.app — ordinary route access stays USDC; FDRY is optional stake",
  };
}

export function fdryNativeHeaders(): Record<string, string> {
  if (!isFdryNativeEnabled()) return {};
  return {
    "x-unbrowse-fdry-native": "1",
    "x-unbrowse-fdry-mint": FDRY_MINT,
    "x-unbrowse-fdry-vault": FDRY_VAULT_PDA,
  };
}