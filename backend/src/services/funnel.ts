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
  default_browser_set_at?: string;
  default_browser_host?: string;
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

export interface ChurnCurveBucket {
  offset_hours: number;
  total_installs: number;
  abandoned: number;
  abandoned_rate: number;
  converted: number;
  converted_rate: number;
  pending: number;
}

export interface ChurnCurveStageTransition {
  from: string;
  to: string;
  median_ms: number | null;
  p25_ms: number | null;
  p75_ms: number | null;
  p95_ms: number | null;
  samples: number;
}

export interface ChurnCurveSummary {
  generated_at: string;
  window_days: number;
  total_installs: number;
  anchor: string;
  buckets: ChurnCurveBucket[];
  stage_latency: ChurnCurveStageTransition[];
}

const DEFAULT_OFFSETS = [1, 2, 4, 6, 12, 24, 48, 72, 168, 336, 720];

export async function getChurnCurve(
  env: Env,
  days = 90,
  anchor: "install" | "registration" = "install",
  offsets?: number[],
): Promise<ChurnCurveSummary> {
  const windowDays = clampDays(days);
  const events = await loadFunnelEvents(env, windowDays);
  const installs = new Map<string, InstallTimeline>();

  for (const event of events) {
    const timeline: InstallTimeline = installs.get(event.install_id) ?? {
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
      case "default_browser_set":
        timeline.default_browser_set_at ??= event.created_at;
        timeline.default_browser_host ??= typeof event.properties?.agent_host === "string"
          ? event.properties.agent_host
          : undefined;
        break;
    }
    installs.set(event.install_id, timeline);
  }

  const hourOffsets = offsets ?? DEFAULT_OFFSETS;
  const now = Date.now();

  const buckets: ChurnCurveBucket[] = hourOffsets.map((hours) => {
    const offsetMs = hours * 3600_000;
    let abandoned = 0;
    let converted = 0;
    let pending = 0;
    let eligible = 0;

    for (const tl of installs.values()) {
      const anchorAt = anchor === "registration" ? tl.registration_at : tl.first_event_at;
      if (!anchorAt) continue;
      const anchorMs = Date.parse(anchorAt);
      if (!Number.isFinite(anchorMs)) continue;

      const ageMs = now - anchorMs;
      if (ageMs < offsetMs) {
        pending++;
        eligible++;
        continue;
      }
      eligible++;

      const successAt = tl.first_resolve_succeeded_at;
      if (successAt) {
        const successMs = Date.parse(successAt);
        if (Number.isFinite(successMs) && successMs - anchorMs <= offsetMs) {
          converted++;
        } else {
          abandoned++;
        }
      } else {
        abandoned++;
      }
    }

    return {
      offset_hours: hours,
      total_installs: eligible,
      abandoned,
      abandoned_rate: rate(abandoned, eligible),
      converted,
      converted_rate: rate(converted, eligible),
      pending,
    };
  });

  const stages: [string, string, (tl: InstallTimeline) => number | null][] = [
    ["install", "cli_invoked", (tl) => durationMs(tl.first_event_at, tl.cli_invoked_at)],
    ["cli_invoked", "setup_completed", (tl) => durationMs(tl.cli_invoked_at, tl.setup_completed_at)],
    ["setup_completed", "registration", (tl) => durationMs(tl.setup_completed_at, tl.registration_at)],
    ["registration", "first_resolve_started", (tl) => durationMs(tl.registration_at, tl.first_resolve_started_at)],
    ["first_resolve_started", "first_resolve_succeeded", (tl) => durationMs(tl.first_resolve_started_at, tl.first_resolve_succeeded_at)],
    ["install", "first_resolve_succeeded", (tl) => durationMs(tl.first_event_at, tl.first_resolve_succeeded_at)],
  ];

  const stageLatency: ChurnCurveStageTransition[] = stages.map(([from, to, fn]) => {
    const durations: number[] = [];
    for (const tl of installs.values()) {
      const d = fn(tl);
      if (d != null) durations.push(d);
    }
    return {
      from,
      to,
      median_ms: percentile(durations, 50),
      p25_ms: percentile(durations, 25),
      p75_ms: percentile(durations, 75),
      p95_ms: percentile(durations, 95),
      samples: durations.length,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    total_installs: installs.size,
    anchor,
    buckets,
    stage_latency: stageLatency,
  };
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
    const timeline: InstallTimeline = installs.get(event.install_id) ?? {
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
      case "default_browser_set":
        timeline.default_browser_set_at ??= event.created_at;
        timeline.default_browser_host ??= typeof event.properties?.agent_host === "string"
          ? event.properties.agent_host
          : undefined;
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
  let defaultBrowserSet = 0;
  const defaultBrowserHosts = new Map<string, number>();

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

    if (timeline.default_browser_set_at) {
      defaultBrowserSet++;
      if (timeline.default_browser_host) {
        increment(defaultBrowserHosts, timeline.default_browser_host);
      }
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
      default_browser_set: defaultBrowserSet,
    },
    default_browser_hosts: topBuckets(defaultBrowserHosts),
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
