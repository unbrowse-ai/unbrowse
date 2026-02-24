import type { Env, OrchestrationTiming, PerfStats } from "../types.js";
import { statsKV } from "./kv.js";

const PERF_KEY = "perf:orchestration";
const PERF_WINDOW_KEY = "perf:recent";
const MAX_RECENT = 200; // Keep last 200 timings for percentile calculations

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
