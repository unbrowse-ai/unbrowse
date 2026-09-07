/**
 * aiko-native — when the aiko substrate is present, unbrowse also binds to the
 * AIKO persona token (pump.fun launch mint in ~/.aiko/token.json or AIKO_MINT env).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAikoSubstratePresent } from "./aiko-identity.js";

export const AIKO_TOKEN_SYMBOL = "AIKO";
export const AIKO_TOKEN_CONFIG_PATH = join(homedir(), ".aiko", "token.json");
export const AIKO_TOKEN_HEADER = "x-unbrowse-aiko-mint";

export interface AikoTokenConfig {
  mint: string;
  symbol: typeof AIKO_TOKEN_SYMBOL;
  name?: string;
  launched_at?: string;
  pump_fun?: boolean;
  metadata_uri?: string;
}

function envMint(): string | null {
  const raw = process.env.AIKO_MINT?.trim();
  return raw && raw.length >= 32 ? raw : null;
}

/** Load the canonical AIKO token mint from env or ~/.aiko/token.json. */
export function loadAikoTokenConfig(): AikoTokenConfig | null {
  const fromEnv = envMint();
  if (fromEnv) {
    return { mint: fromEnv, symbol: AIKO_TOKEN_SYMBOL, pump_fun: true };
  }
  if (!existsSync(AIKO_TOKEN_CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(AIKO_TOKEN_CONFIG_PATH, "utf8")) as Partial<AikoTokenConfig>;
    if (typeof parsed.mint !== "string" || !parsed.mint.trim()) return null;
    return {
      mint: parsed.mint.trim(),
      symbol: AIKO_TOKEN_SYMBOL,
      name: parsed.name,
      launched_at: parsed.launched_at,
      pump_fun: parsed.pump_fun ?? true,
      metadata_uri: parsed.metadata_uri,
    };
  } catch {
    return null;
  }
}

export function loadAikoTokenMint(): string | null {
  return loadAikoTokenConfig()?.mint ?? null;
}

/** True when aiko substrate AND an AIKO mint are configured. */
export function isAikoTokenNative(): boolean {
  if (!isAikoSubstratePresent()) return false;
  const forced = process.env.UNBROWSE_AIKO_NATIVE?.trim().toLowerCase();
  if (forced === "0" || forced === "false" || forced === "off") return false;
  if (forced === "1" || forced === "true" || forced === "on") {
    return loadAikoTokenMint() !== null;
  }
  return loadAikoTokenMint() !== null;
}

export function aikoNativeHeaders(): Record<string, string> {
  if (!isAikoTokenNative()) return {};
  const mint = loadAikoTokenMint();
  if (!mint) return {};
  return {
    "x-unbrowse-aiko-native": "1",
    [AIKO_TOKEN_HEADER]: mint,
  };
}