export type LifecyclePhase = "discover" | "capture" | "resolve" | "execute" | "publish";

export interface LifecycleEvent {
  phase: LifecyclePhase;
  skill_id: string;
  timestamp: string;
  duration_ms: number;
  source: "cache" | "marketplace" | "live-capture";
}

export function attributeLifecycle(events: LifecycleEvent[]): Map<LifecyclePhase, number> {
  const totals = new Map<LifecyclePhase, number>();
  for (const e of events) {
    totals.set(e.phase, (totals.get(e.phase) ?? 0) + e.duration_ms);
  }
  return totals;
}
