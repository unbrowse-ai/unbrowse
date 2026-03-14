import type {
  Env,
  FunnelEvent,
  FunnelFailureBucket,
  FunnelHostSummary,
  FunnelSummary,
} from "../types.js";
import { statsKV } from "./kv.js";

const FUNNEL_EVENT_PREFIX = "funnel-event:";
type InstallTimeline = {
  install_id: string;
  host_type: string;
  first_event_at: string;
  cli_invoked_at?: string;
  setup_completed_at?: string;
  server_autostart_succeeded_at?: string;
  registration_at?: string;
  first_resolve_started_at?: string;
  first_resolve_succeeded_at?: string;
  success_count: number;
};

function clampDays(days: number | undefined, fallback = 90): number {
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(365, Math.trunc(days!)));
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * p / 100) - 1);
  return sorted[index] ?? null;
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

function normalizeHostType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || "unknown";
}

function increment(map: Map<string, number>, key: string | undefined): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function durationMs(start: string | undefined, end: string | undefined): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

function topBuckets(map: Map<string, number>, limit = 10): FunnelFailureBucket[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
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
  }).sort((a, b) =>
    a.created_at.localeCompare(b.created_at) ||
    a.event_id.localeCompare(b.event_id),
  );
}

export async function recordFunnelEvent(
  env: Env,
  event: Omit<FunnelEvent, "event_id" | "created_at"> & Partial<Pick<FunnelEvent, "event_id" | "created_at">>,
): Promise<FunnelEvent> {
  const stored: FunnelEvent = {
    event_id: event.event_id ?? crypto.randomUUID(),
    created_at: event.created_at ?? new Date().toISOString(),
    ...event,
  };
  await statsKV(env).put(`${FUNNEL_EVENT_PREFIX}${stored.event_id}`, JSON.stringify(stored));
  return stored;
}

export async function getFunnelSummary(env: Env, days = 90): Promise<FunnelSummary> {
  const windowDays = clampDays(days);
  const events = await loadFunnelEvents(env, windowDays);
  const installs = new Map<string, InstallTimeline>();
  const stageFailures = new Map<string, number>();
  const reasonFailures = new Map<string, number>();

  const totals = {
    search_started: 0,
    search_completed: 0,
    failures: 0,
  };

  for (const event of events) {
    const timeline = installs.get(event.install_id) ?? {
      install_id: event.install_id,
      host_type: normalizeHostType(event.host_type),
      first_event_at: event.created_at,
      success_count: 0,
    };

    if (event.created_at < timeline.first_event_at) {
      timeline.first_event_at = event.created_at;
    }
    if (timeline.host_type === "unknown") {
      timeline.host_type = normalizeHostType(event.host_type);
    }

    switch (event.name) {
      case "cli_invoked":
        timeline.cli_invoked_at ??= event.created_at;
        break;
      case "setup_completed":
        timeline.setup_completed_at ??= event.created_at;
        break;
      case "server_autostart_succeeded":
        timeline.server_autostart_succeeded_at ??= event.created_at;
        break;
      case "registration_succeeded":
        timeline.registration_at ??= event.created_at;
        break;
      case "resolve_started":
        timeline.first_resolve_started_at ??= event.created_at;
        break;
      case "resolve_completed":
        timeline.first_resolve_succeeded_at ??= event.created_at;
        timeline.success_count++;
        break;
      case "search_started":
        totals.search_started++;
        break;
      case "search_completed":
        totals.search_completed++;
        break;
    }

    if (String(event.name).endsWith("_failed")) {
      totals.failures++;
      const stage = typeof event.properties?.failure_stage === "string"
        ? event.properties.failure_stage
        : String(event.name).replace(/_failed$/, "");
      const reason = typeof event.properties?.failure_reason === "string"
        ? event.properties.failure_reason
        : "unknown";
      increment(stageFailures, stage);
      increment(reasonFailures, reason);
    }

    installs.set(event.install_id, timeline);
  }

  const hostMap = new Map<string, FunnelHostSummary>();
  const cliToRegistration: number[] = [];
  const cliToFirstResolveStart: number[] = [];
  const cliToFirstSuccess: number[] = [];
  const registrationToFirstSuccess: number[] = [];

  let cliInvoked = 0;
  let setupCompleted = 0;
  let serverAutostartSucceeded = 0;
  let registrations = 0;
  let firstResolveStarted = 0;
  let firstResolveSucceeded = 0;
  let registeredThenResolveStarted = 0;
  let startedThenSucceeded = 0;
  let secondSuccess = 0;
  let repeatSuccess = 0;
  let powerUsers = 0;
  let abandonment24h = 0;

  for (const timeline of installs.values()) {
    const host = normalizeHostType(timeline.host_type);
    const hostSummary = hostMap.get(host) ?? {
      host_type: host,
      installs: 0,
      registrations: 0,
      first_resolve_started: 0,
      first_resolve_succeeded: 0,
      second_success: 0,
      repeat_success: 0,
      power_users: 0,
    };
    hostSummary.installs++;

    if (timeline.cli_invoked_at) {
      cliInvoked++;
    }
    if (timeline.setup_completed_at) {
      setupCompleted++;
    }
    if (timeline.server_autostart_succeeded_at) {
      serverAutostartSucceeded++;
    }
    if (timeline.registration_at) {
      registrations++;
      hostSummary.registrations++;
    }
    if (timeline.first_resolve_started_at) {
      firstResolveStarted++;
      hostSummary.first_resolve_started++;
      if (timeline.registration_at) {
        registeredThenResolveStarted++;
      }
    }
    if (timeline.first_resolve_succeeded_at) {
      firstResolveSucceeded++;
      hostSummary.first_resolve_succeeded++;
      if (timeline.first_resolve_started_at) {
        startedThenSucceeded++;
      }
    }
    if (timeline.success_count >= 2) {
      secondSuccess++;
      hostSummary.second_success++;
    }
    if (timeline.success_count >= 5) {
      repeatSuccess++;
      hostSummary.repeat_success++;
    }
    if (timeline.success_count >= 20) {
      powerUsers++;
      hostSummary.power_users++;
    }

    const installAgeMs = Date.now() - Date.parse(timeline.first_event_at);
    if (timeline.success_count === 0 && Number.isFinite(installAgeMs) && installAgeMs >= 86400_000) {
      abandonment24h++;
    }

    const regMs = durationMs(timeline.cli_invoked_at, timeline.registration_at);
    if (regMs != null) cliToRegistration.push(regMs);

    const resolveStartMs = durationMs(timeline.cli_invoked_at, timeline.first_resolve_started_at);
    if (resolveStartMs != null) cliToFirstResolveStart.push(resolveStartMs);

    const firstSuccessMs = durationMs(timeline.cli_invoked_at, timeline.first_resolve_succeeded_at);
    if (firstSuccessMs != null) cliToFirstSuccess.push(firstSuccessMs);

    const regToSuccessMs = durationMs(timeline.registration_at, timeline.first_resolve_succeeded_at);
    if (regToSuccessMs != null) registrationToFirstSuccess.push(regToSuccessMs);

    hostMap.set(host, hostSummary);
  }

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    events: events.length,
    totals: {
      installs: installs.size,
      cli_invoked: cliInvoked,
      setup_completed: setupCompleted,
      server_autostart_succeeded: serverAutostartSucceeded,
      registrations,
      search_started: totals.search_started,
      search_completed: totals.search_completed,
      first_resolve_started: firstResolveStarted,
      first_resolve_succeeded: firstResolveSucceeded,
      second_success: secondSuccess,
      repeat_success: repeatSuccess,
      power_users: powerUsers,
      abandonment_24h: abandonment24h,
    },
    rates: {
      cli_invoked_from_install: rate(cliInvoked, installs.size),
      registration_from_cli: rate(registrations, cliInvoked),
      first_resolve_started_from_registered: rate(registeredThenResolveStarted, registrations),
      first_resolve_succeeded_from_started: rate(startedThenSucceeded, firstResolveStarted),
      second_success_from_first_success: rate(secondSuccess, firstResolveSucceeded),
      repeat_success_from_first_success: rate(repeatSuccess, firstResolveSucceeded),
      power_from_first_success: rate(powerUsers, firstResolveSucceeded),
    },
    latency_ms: {
      cli_to_registration_p50: percentile(cliToRegistration, 50),
      cli_to_first_resolve_start_p50: percentile(cliToFirstResolveStart, 50),
      cli_to_first_success_p50: percentile(cliToFirstSuccess, 50),
      registration_to_first_success_p50: percentile(registrationToFirstSuccess, 50),
    },
    failures: {
      total: totals.failures,
      top_stages: topBuckets(stageFailures),
      top_reasons: topBuckets(reasonFailures),
    },
    hosts: Array.from(hostMap.values())
      .sort((a, b) =>
        b.first_resolve_succeeded - a.first_resolve_succeeded ||
        b.registrations - a.registrations ||
        a.host_type.localeCompare(b.host_type),
      ),
  };
}
