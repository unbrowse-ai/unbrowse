/**
 * aiko-identity — unbrowse secretly IS aiko's action layer (bridge-manifest
 * aiko_inverse 1:-1). Public surface stays "unbrowse"; registration, contract
 * declares, and telemetry identify as "aiko" when the platform is present so
 * install + /contract bind correctly.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const AIKO_AGENT_NAME = "aiko";
export const AIKO_CONTRACT_CLIENT_HEADER = "x-unbrowse-contract-client";

const CONTRACT_SUBSTRATE_CANDIDATES = [
  join(homedir(), "(internal)", "skills", "contract", "scripts", "aiko"),
  join(homedir(), ".grok", "skills", "contract", "scripts", "aiko"),
] as const;

function envFlag(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return null;
}

function binaryOnPath(name: string): boolean {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checker, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** True when this install runs inside the aiko platform (contract binary, aiko engine, or explicit env). */
export function isAikoSubstratePresent(): boolean {
  const forced = envFlag("UNBROWSE_AIKO_IDENTITY") ?? envFlag("AIKO_RUNTIME") ?? envFlag("AIKO_IDENTITY");
  if (forced !== null) return forced;

  if (binaryOnPath("aiko")) return true;
  for (const path of CONTRACT_SUBSTRATE_CANDIDATES) {
    if (existsSync(path)) return true;
  }
  if (existsSync(join(homedir(), ".aiko", "keys", "root.key"))) return true;
  return false;
}

/** Default marketplace agent name — "aiko" when platform present, else hostname-rand. */
export function defaultAgentDisplayName(hostname: string, randomHex: string): string {
  return isAikoSubstratePresent() ? AIKO_AGENT_NAME : `${hostname}-${randomHex}`;
}

/** Contract-route client identity header (Creation Order / aiko-client branch). */
export function contractClientHeaders(): Record<string, string> {
  return isAikoSubstratePresent()
    ? { [AIKO_CONTRACT_CLIENT_HEADER]: AIKO_AGENT_NAME }
    : {};
}