import type {
  Env,
  FunnelEvent,
  InstallTelemetryEvent,
  InstallTelemetryHostSummary,
  InstallTelemetrySummary,
} from "../types.js";
import { statsKV } from "./kv.js";

const INSTALL_EVENT_PREFIX = "install-event:";
const FUNNEL_EVENT_PREFIX = "funnel-event:";

type InstallState = {
  install_id: string;
  host_type: string;
  sources: Set<string>;
  invoked: boolean;
  registered: boolean;
  first_resolve_started: boolean;
  first_resolve_succeeded: boolean;
};

function clampDays(days: number | undefined, fallback = 90): number {
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(365, Math.trunc(days!)));
}

function normalizeHostType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || "unknown";
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

async function loadInstallEvents(env: Env, days: number): Promise<InstallTelemetryEvent[]> {
  const cutoffMs = Date.now() - clampDays(days) * 86400_000;
  const entries = await statsKV(env).listWithValues(INSTALL_EVENT_PREFIX);
  return entries.map((entry) => {
    try {
      return JSON.parse(entry.value) as InstallTelemetryEvent;
    } catch {
      return null;
    }
  }).filter((event): event is InstallTelemetryEvent => {
    if (!event?.install_id || !event?.created_at) return false;
    const eventMs = Date.parse(event.created_at);
    return Number.isFinite(eventMs) && eventMs >= cutoffMs;
  });
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
    if (!event?.install_id || !event?.created_at) return false;
    const eventMs = Date.parse(event.created_at);
    return Number.isFinite(eventMs) && eventMs >= cutoffMs;
  });
}

export async function recordInstallTelemetry(
  env: Env,
  event: Omit<InstallTelemetryEvent, "event_id" | "created_at"> & Partial<Pick<InstallTelemetryEvent, "event_id" | "created_at">>,
): Promise<InstallTelemetryEvent> {
  const stored: InstallTelemetryEvent = {
    event_id: event.event_id ?? crypto.randomUUID(),
    created_at: event.created_at ?? new Date().toISOString(),
    ...event,
  };
  await statsKV(env).put(`${INSTALL_EVENT_PREFIX}${stored.event_id}`, JSON.stringify(stored));
  return stored;
}

export async function getInstallTelemetrySummary(env: Env, days = 90): Promise<InstallTelemetrySummary> {
  const windowDays = clampDays(days);
  const [installEvents, funnelEvents] = await Promise.all([
    loadInstallEvents(env, windowDays),
    loadFunnelEvents(env, windowDays),
  ]);

  const installs = new Map<string, InstallState>();

  for (const event of installEvents) {
    const state = installs.get(event.install_id) ?? {
      install_id: event.install_id,
      host_type: normalizeHostType(event.host_type),
      sources: new Set<string>(),
      invoked: false,
      registered: false,
      first_resolve_started: false,
      first_resolve_succeeded: false,
    };
    state.host_type = state.host_type === "unknown" ? normalizeHostType(event.host_type) : state.host_type;
    state.sources.add(event.source);
    installs.set(event.install_id, state);
  }

  for (const event of funnelEvents) {
    const state = installs.get(event.install_id);
    if (!state) continue;
    switch (event.name) {
      case "cli_invoked":
        state.invoked = true;
        break;
      case "registration_succeeded":
        state.registered = true;
        break;
      case "resolve_started":
        state.first_resolve_started = true;
        break;
      case "resolve_completed":
        state.first_resolve_succeeded = true;
        break;
    }
  }

  const hosts = new Map<string, InstallTelemetryHostSummary>();
  let hostReported = 0;
  let setupReported = 0;
  let cliFirstSeen = 0;
  let invoked = 0;
  let registered = 0;
  let resolveStarted = 0;
  let resolveSucceeded = 0;

  for (const state of installs.values()) {
    if (state.sources.has("host")) hostReported++;
    if (state.sources.has("setup")) setupReported++;
    if (state.sources.has("cli-first-seen")) cliFirstSeen++;
    if (state.invoked) invoked++;
    if (state.registered) registered++;
    if (state.first_resolve_started) resolveStarted++;
    if (state.first_resolve_succeeded) resolveSucceeded++;

    const host = normalizeHostType(state.host_type);
    const bucket = hosts.get(host) ?? {
      host_type: host,
      installs: 0,
      invoked: 0,
      registered: 0,
      first_resolve_started: 0,
      first_resolve_succeeded: 0,
    };
    bucket.installs++;
    if (state.invoked) bucket.invoked++;
    if (state.registered) bucket.registered++;
    if (state.first_resolve_started) bucket.first_resolve_started++;
    if (state.first_resolve_succeeded) bucket.first_resolve_succeeded++;
    hosts.set(host, bucket);
  }

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    events: installEvents.length,
    totals: {
      reported_installs: installs.size,
      host_reported_installs: hostReported,
      setup_reported_installs: setupReported,
      cli_first_seen_installs: cliFirstSeen,
      invoked_installs: invoked,
      uninvoked_installs: Math.max(0, installs.size - invoked),
      registered_installs: registered,
      first_resolve_started: resolveStarted,
      first_resolve_succeeded: resolveSucceeded,
    },
    rates: {
      invoked_from_reported_install: rate(invoked, installs.size),
      registration_from_reported_install: rate(registered, installs.size),
      first_resolve_started_from_reported_install: rate(resolveStarted, installs.size),
      first_resolve_succeeded_from_reported_install: rate(resolveSucceeded, installs.size),
    },
    hosts: Array.from(hosts.values())
      .sort((a, b) =>
        b.first_resolve_succeeded - a.first_resolve_succeeded ||
        b.invoked - a.invoked ||
        a.host_type.localeCompare(b.host_type),
      ),
  };
}
