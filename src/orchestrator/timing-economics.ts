import type { SkillManifest } from "../types/index.js";

export const DEFAULT_CAPTURE_MS = 22_000;
export const DEFAULT_CAPTURE_TOKENS = 30_000;
export const CHARS_PER_TOKEN = 4;
export const TOKEN_COST_PER_MILLION_USD = 3;
export const TOKEN_COST_UC = Math.round(TOKEN_COST_PER_MILLION_USD);

const SAVINGS_SOURCES = new Set([
  "marketplace",
  "route-cache",
  "first-pass",
  "direct-fetch",
  "browser-action",
]);

export interface TimingEconomics {
  response_bytes: number;
  response_tokens: number;
  tokens_saved: number;
  tokens_saved_pct: number;
  time_saved_pct: number;
  baseline_total_ms?: number;
  time_saved_ms?: number;
  baseline_cost_uc?: number;
  actual_cost_uc: number;
  cost_saved_uc?: number;
  baseline_source?: "real" | "estimated";
}

export function computeTimingEconomics({
  source,
  totalMs,
  result,
  skill,
  paidSearchUc = 0,
  paidExecutionUc = 0,
}: {
  source: string;
  totalMs: number;
  result: unknown;
  skill?: Pick<SkillManifest, "discovery_cost">;
  paidSearchUc?: number;
  paidExecutionUc?: number;
}): TimingEconomics {
  const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
  const responseBytes = resultStr.length;
  const responseTokens = Math.ceil(responseBytes / CHARS_PER_TOKEN);
  const actualCostUc = (responseTokens * TOKEN_COST_UC) + paidSearchUc + paidExecutionUc;

  const economics: TimingEconomics = {
    response_bytes: responseBytes,
    response_tokens: responseTokens,
    tokens_saved: 0,
    tokens_saved_pct: 0,
    time_saved_pct: 0,
    actual_cost_uc: actualCostUc,
  };

  if (!SAVINGS_SOURCES.has(source)) return economics;

  const baselineTokens = skill?.discovery_cost?.capture_tokens ?? DEFAULT_CAPTURE_TOKENS;
  const baselineMs = skill?.discovery_cost?.capture_ms ?? DEFAULT_CAPTURE_MS;
  const baselineCostUc = baselineTokens * TOKEN_COST_UC;

  economics.tokens_saved = Math.max(0, baselineTokens - responseTokens);
  economics.tokens_saved_pct = baselineTokens > 0
    ? Math.round((economics.tokens_saved / baselineTokens) * 100)
    : 0;
  economics.time_saved_pct = baselineMs > 0
    ? Math.round((Math.max(0, baselineMs - totalMs) / baselineMs) * 100)
    : 0;
  economics.baseline_total_ms = baselineMs;
  economics.time_saved_ms = Math.max(0, baselineMs - totalMs);
  economics.baseline_cost_uc = baselineCostUc;
  economics.cost_saved_uc = Math.max(0, baselineCostUc - actualCostUc);
  economics.baseline_source = skill?.discovery_cost ? "real" : "estimated";

  return economics;
}
