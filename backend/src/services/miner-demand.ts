import type { Env, FunnelEvent } from "../types.js";
import { statsKV } from "./kv.js";
import { buildMinerDemandBoardFromEvents, type DomainCoverageSnapshot } from "./miner-demand-derive.js";

const FUNNEL_EVENT_PREFIX = "funnel-event:";
const DEMAND_WINDOW_DAYS = 30;

function clampDays(days: number | undefined, fallback = DEMAND_WINDOW_DAYS): number {
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(365, Math.trunc(days!)));
}

async function loadFunnelEvents(env: Env, days: number): Promise<FunnelEvent[]> {
  const cutoffMs = Date.now() - clampDays(days) * 86400_000;
  const entries = await statsKV(env).listWithValues(FUNNEL_EVENT_PREFIX);
  return entries.map((entry) => {
    try {
      return JSON.parse(entry.value) as FunnelEvent;
    } catch {
      return null;
    }
  }).filter((event): event is FunnelEvent => {
    if (!event?.install_id || !event?.name || !event?.created_at) return false;
    const eventMs = Date.parse(event.created_at);
    return Number.isFinite(eventMs) && eventMs >= cutoffMs;
  });
}

export async function buildMinerDemandBoard(
  env: Env,
  domainCoverage: Map<string, DomainCoverageSnapshot>,
  days = DEMAND_WINDOW_DAYS,
) {
  const events = await loadFunnelEvents(env, days);
  return buildMinerDemandBoardFromEvents(events, domainCoverage);
}
