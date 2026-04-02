import type { Env, OrchestrationTiming, PerfStats } from "../types.js";
import { statsKV } from "./kv.js";

const PERF_KEY = "perf:orchestration";
const PERF_WINDOW_KEY = "perf:recent";
const AGENT_PERF_INDEX_KEY = "perf:agents:index";
const MAX_RECENT = 200; // Keep last 200 timings for percentile calculations

export interface AgentPerfLedger {
  agent_id: string;
  event_count: number;
  time_saved_events: number;
  cost_saved_events: number;
  total_actual_ms: number;
  total_baseline_ms: number;
  total_time_saved_ms: number;
  total_actual_cost_uc: number;
  total_baseline_cost_uc: number;
  total_cost_saved_uc: number;
  total_paid_search_uc: number;
  total_paid_execution_uc: number;
  first_recorded_at: string;
  last_recorded_at: string;
}

export async function getPerf(env: Env): Promise<PerfStats> {
  const raw = await statsKV(env).get(PERF_KEY) as string | null;
  if (raw) {
    try { return JSON.parse(raw) as PerfStats; } catch { /* fall through */ }
  }
  return {
    total_resolves: 0,
    marketplace_hits: 0,
    cache_hits: 0,
    live_captures: 0,
    dom_fallbacks: 0,
    avg_total_ms: 0,
    avg_search_ms: 0,
    avg_execute_ms: 0,
    avg_marketplace_ms: 0,
    avg_cache_ms: 0,
    avg_live_capture_ms: 0,
    p95_total_ms: 0,
    total_tokens_saved: 0,
    total_response_bytes: 0,
    avg_time_saved_pct: 0,
    avg_tokens_saved_pct: 0,
    last_updated_at: new Date().toISOString(),
  };
}

async function getRecentTimings(env: Env): Promise<number[]> {
  const raw = await statsKV(env).get(PERF_WINDOW_KEY) as string | null;
  if (raw) {
    try { return JSON.parse(raw) as number[]; } catch { /* fall through */ }
  }
  return [];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function runningAvg(oldAvg: number, newVal: number, count: number): number {
  return count === 1 ? newVal : oldAvg + (newVal - oldAvg) / count;
}

function agentPerfKey(agentId: string): string {
  return `perf:agent:${agentId}`;
}

function emptyAgentPerfLedger(agentId: string, now: string): AgentPerfLedger {
  return {
    agent_id: agentId,
    event_count: 0,
    time_saved_events: 0,
    cost_saved_events: 0,
    total_actual_ms: 0,
    total_baseline_ms: 0,
    total_time_saved_ms: 0,
    total_actual_cost_uc: 0,
    total_baseline_cost_uc: 0,
    total_cost_saved_uc: 0,
    total_paid_search_uc: 0,
    total_paid_execution_uc: 0,
    first_recorded_at: now,
    last_recorded_at: now,
  };
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

async function addAgentPerfToIndex(kv: ReturnType<typeof statsKV>, agentId: string): Promise<void> {
  const raw = await kv.get(AGENT_PERF_INDEX_KEY) as string | null;
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  if (!ids.includes(agentId)) {
    ids.push(agentId);
    await kv.put(AGENT_PERF_INDEX_KEY, JSON.stringify(ids));
  }
}

export async function getAgentPerfLedger(env: Env, agentId: string): Promise<AgentPerfLedger | null> {
  const raw = await statsKV(env).get(agentPerfKey(agentId)) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw) as AgentPerfLedger; } catch { return null; }
}

export async function recordAgentPerf(
  env: Env,
  agentId: string,
  timing: OrchestrationTiming,
): Promise<AgentPerfLedger> {
  const kv = statsKV(env);
  const now = new Date().toISOString();
  const raw = await kv.get(agentPerfKey(agentId)) as string | null;
  let ledger: AgentPerfLedger;

  if (raw) {
    try { ledger = JSON.parse(raw) as AgentPerfLedger; } catch {
      ledger = emptyAgentPerfLedger(agentId, now);
    }
  } else {
    ledger = emptyAgentPerfLedger(agentId, now);
    await addAgentPerfToIndex(kv, agentId);
  }

  ledger.event_count++;
  ledger.last_recorded_at = now;
  ledger.total_actual_ms += asNonNegativeInt(timing.actual_total_ms) ?? timing.total_ms;

  const baselineMs = asNonNegativeInt(timing.baseline_total_ms);
  if (baselineMs != null) ledger.total_baseline_ms += baselineMs;

  const timeSavedMs = asNonNegativeInt(timing.time_saved_ms);
  if (timeSavedMs != null) {
    ledger.total_time_saved_ms += timeSavedMs;
    ledger.time_saved_events++;
  }

  const actualCostUc = asNonNegativeInt(timing.actual_cost_uc);
  if (actualCostUc != null) ledger.total_actual_cost_uc += actualCostUc;

  const baselineCostUc = asNonNegativeInt(timing.baseline_cost_uc);
  if (baselineCostUc != null) ledger.total_baseline_cost_uc += baselineCostUc;

  const costSavedUc = asNonNegativeInt(timing.cost_saved_uc);
  if (costSavedUc != null) {
    ledger.total_cost_saved_uc += costSavedUc;
    ledger.cost_saved_events++;
  }

  ledger.total_paid_search_uc += asNonNegativeInt(timing.paid_search_uc) ?? 0;
  ledger.total_paid_execution_uc += asNonNegativeInt(timing.paid_execution_uc) ?? 0;

  await kv.put(agentPerfKey(agentId), JSON.stringify(ledger));
  return ledger;
}

export async function recordPerf(env: Env, timing: OrchestrationTiming): Promise<void> {
  const stats = await getPerf(env);

  stats.total_resolves++;
  stats.avg_total_ms = runningAvg(stats.avg_total_ms, timing.total_ms, stats.total_resolves);
  stats.avg_search_ms = runningAvg(stats.avg_search_ms, timing.search_ms, stats.total_resolves);
  stats.avg_execute_ms = runningAvg(stats.avg_execute_ms, timing.execute_ms, stats.total_resolves);

  switch (timing.source) {
    case "marketplace":
      stats.marketplace_hits++;
      stats.avg_marketplace_ms = runningAvg(stats.avg_marketplace_ms, timing.total_ms, stats.marketplace_hits);
      break;
    case "route-cache":
      stats.cache_hits++;
      stats.avg_cache_ms = runningAvg(stats.avg_cache_ms, timing.total_ms, stats.cache_hits);
      break;
    case "live-capture":
      stats.live_captures++;
      stats.avg_live_capture_ms = runningAvg(stats.avg_live_capture_ms, timing.total_ms, stats.live_captures);
      break;
    case "dom-fallback":
      stats.dom_fallbacks++;
      break;
  }

  // Cumulative token savings and data transfer
  stats.total_tokens_saved += timing.tokens_saved ?? 0;
  stats.total_response_bytes += timing.response_bytes ?? 0;

  // Running average of percentage savings
  stats.avg_time_saved_pct = runningAvg(stats.avg_time_saved_pct, timing.time_saved_pct ?? 0, stats.total_resolves);
  stats.avg_tokens_saved_pct = runningAvg(stats.avg_tokens_saved_pct, timing.tokens_saved_pct ?? 0, stats.total_resolves);

  // Update sliding window for percentile calculation
  const recent = await getRecentTimings(env);
  recent.push(timing.total_ms);
  if (recent.length > MAX_RECENT) recent.shift();
  const sorted = [...recent].sort((a, b) => a - b);
  stats.p95_total_ms = percentile(sorted, 95);

  stats.last_updated_at = new Date().toISOString();

  // Batch write: stats + recent window
  await statsKV(env).putBatch([
    { key: PERF_KEY, value: JSON.stringify(stats) },
    { key: PERF_WINDOW_KEY, value: JSON.stringify(recent) },
  ]);
}
