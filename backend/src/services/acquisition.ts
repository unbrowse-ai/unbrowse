import type { AcquisitionReferrerSummary, AcquisitionSummary, Env, WebTelemetryEvent } from "../types.js";
import { statsKV } from "./kv.js";

const WEB_EVENT_PREFIX = "web-event:";

type SessionState = {
  visitor_id: string;
  session_id: string;
  referrer: string;
  landing_viewed: boolean;
  install_section_viewed: boolean;
  first_task_section_viewed: boolean;
  install_command_copied: boolean;
  first_task_command_copied: boolean;
};

function clampDays(days: number | undefined, fallback = 30): number {
  if (!Number.isFinite(days)) return fallback;
  return Math.max(1, Math.min(365, Math.trunc(days!)));
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundRate(numerator / denominator) : 0;
}

function normalizeReferrer(value: string | null | undefined): string {
  if (!value) return "direct";
  try {
    return new URL(value).hostname || "direct";
  } catch {
    return "direct";
  }
}

async function loadWebEvents(env: Env, days: number): Promise<WebTelemetryEvent[]> {
  const cutoffMs = Date.now() - clampDays(days) * 86400_000;
  const entries = await statsKV(env).listWithValues(WEB_EVENT_PREFIX);
  return entries.map((entry) => {
    try {
      return JSON.parse(entry.value) as WebTelemetryEvent;
    } catch {
      return null;
    }
  }).filter((event): event is WebTelemetryEvent => {
    if (!event?.visitor_id || !event?.session_id || !event?.created_at) return false;
    const eventMs = Date.parse(event.created_at);
    return Number.isFinite(eventMs) && eventMs >= cutoffMs;
  });
}

export async function recordWebTelemetry(
  env: Env,
  event: Omit<WebTelemetryEvent, "event_id" | "created_at"> & Partial<Pick<WebTelemetryEvent, "event_id" | "created_at">>,
): Promise<WebTelemetryEvent> {
  const stored: WebTelemetryEvent = {
    event_id: event.event_id ?? crypto.randomUUID(),
    created_at: event.created_at ?? new Date().toISOString(),
    ...event,
  };
  await statsKV(env).put(`${WEB_EVENT_PREFIX}${stored.event_id}`, JSON.stringify(stored));
  return stored;
}

export async function getAcquisitionSummary(env: Env, days = 30): Promise<AcquisitionSummary> {
  const windowDays = clampDays(days);
  const events = await loadWebEvents(env, windowDays);
  const visitors = new Set<string>();
  const sessions = new Map<string, SessionState>();
  const referrers = new Map<string, Set<string>>();
  let landingViews = 0;
  let installSectionViews = 0;
  let firstTaskSectionViews = 0;
  let installCommandCopies = 0;
  let firstTaskCommandCopies = 0;

  for (const event of events) {
    visitors.add(event.visitor_id);
    const key = `${event.visitor_id}:${event.session_id}`;
    const state = sessions.get(key) ?? {
      visitor_id: event.visitor_id,
      session_id: event.session_id,
      referrer: normalizeReferrer(event.referrer),
      landing_viewed: false,
      install_section_viewed: false,
      first_task_section_viewed: false,
      install_command_copied: false,
      first_task_command_copied: false,
    };
    state.referrer = state.referrer === "direct" ? normalizeReferrer(event.referrer) : state.referrer;
    switch (event.name) {
      case "landing_page_viewed":
        state.landing_viewed = true;
        landingViews++;
        break;
      case "install_section_viewed":
        state.install_section_viewed = true;
        installSectionViews++;
        break;
      case "first_task_section_viewed":
        state.first_task_section_viewed = true;
        firstTaskSectionViews++;
        break;
      case "install_command_copied":
        state.install_command_copied = true;
        installCommandCopies++;
        break;
      case "first_task_command_copied":
        state.first_task_command_copied = true;
        firstTaskCommandCopies++;
        break;
    }
    sessions.set(key, state);
  }

  let landingWithoutInstallView = 0;
  let installViewWithoutCopy = 0;
  let firstTaskViewWithoutCopy = 0;
  let installCopyWithoutFirstTask = 0;
  let landingSessions = 0;
  let installViewSessions = 0;
  let firstTaskViewSessions = 0;
  let copySessions = 0;
  let firstTaskCopySessions = 0;
  let landingToCopySessions = 0;
  let installViewToCopySessions = 0;
  let installCopyToFirstTaskViewSessions = 0;
  let firstTaskViewToCopySessions = 0;
  let installCopyToFirstTaskSessions = 0;

  for (const state of sessions.values()) {
    if (state.landing_viewed) landingSessions++;
    if (state.install_section_viewed) installViewSessions++;
    if (state.first_task_section_viewed) firstTaskViewSessions++;
    if (state.install_command_copied) copySessions++;
    if (state.first_task_command_copied) firstTaskCopySessions++;
    if (state.landing_viewed && state.install_command_copied) landingToCopySessions++;
    if (state.install_section_viewed && state.install_command_copied) installViewToCopySessions++;
    if (state.install_command_copied && state.first_task_section_viewed) installCopyToFirstTaskViewSessions++;
    if (state.first_task_section_viewed && state.first_task_command_copied) firstTaskViewToCopySessions++;
    if (state.install_command_copied && state.first_task_command_copied) installCopyToFirstTaskSessions++;
    if (state.landing_viewed && !state.install_section_viewed) landingWithoutInstallView++;
    if (state.install_section_viewed && !state.install_command_copied) installViewWithoutCopy++;
    if (state.first_task_section_viewed && !state.first_task_command_copied) firstTaskViewWithoutCopy++;
    if (state.install_command_copied && !state.first_task_command_copied) installCopyWithoutFirstTask++;
    const bucket = referrers.get(state.referrer) ?? new Set<string>();
    bucket.add(state.session_id);
    referrers.set(state.referrer, bucket);
  }

  const topReferrers: AcquisitionReferrerSummary[] = Array.from(referrers.entries())
    .map(([referrer, sessionIds]) => ({
      referrer,
      sessions: sessionIds.size,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.referrer.localeCompare(b.referrer))
    .slice(0, 10);

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    events: events.length,
    totals: {
      visitors: visitors.size,
      sessions: sessions.size,
      landing_views: landingViews,
      install_section_views: installSectionViews,
      first_task_section_views: firstTaskSectionViews,
      install_command_copies: installCommandCopies,
      first_task_command_copies: firstTaskCommandCopies,
      landing_without_install_view: landingWithoutInstallView,
      install_view_without_copy: installViewWithoutCopy,
      first_task_view_without_copy: firstTaskViewWithoutCopy,
      install_copy_without_first_task: installCopyWithoutFirstTask,
    },
    rates: {
      install_section_view_from_landing: rate(installViewSessions, landingSessions),
      install_copy_from_landing: rate(landingToCopySessions, landingSessions),
      install_copy_from_install_view: rate(installViewToCopySessions, installViewSessions),
      first_task_view_from_install_copy: rate(installCopyToFirstTaskViewSessions, copySessions),
      first_task_copy_from_first_task_view: rate(firstTaskViewToCopySessions, firstTaskViewSessions),
      first_task_copy_from_install_copy: rate(installCopyToFirstTaskSessions, copySessions),
    },
    top_referrers: topReferrers,
  };
}
