/**
 * Site priority for "what to unbrowse first" and resolve shortlist bias.
 *
 * Order (structural): cookies ≫ bookmarks ≫ history.
 * Pure scoring helpers live here so resolve/auth-inventory share one policy.
 * Never returns cookie values, full URLs, or paths — host/eTLD+1 + floats only.
 */

import { browserPreferences } from "./browser-preferences.js";

/** Weights: must match composeInventory in auth-inventory.ts. */
export const SITE_PRIORITY_WEIGHTS = {
  freshAuthCookie: 0.6,
  anyCookie: 0.15,
  bookmarked: 0.2,
  recentVisit: 0.05,
  highVisits: 0.05,
  cap: 0.95,
} as const;

export interface SitePrioritySignals {
  has_cookie?: boolean;
  fresh_cookie?: boolean;
  bookmarked?: boolean;
  visit_count?: number;
  last_visit_unix?: number;
  nowUnix?: number;
}

const THIRTY_DAYS_S = 30 * 24 * 3600;

/**
 * Pure score from inventory-shaped signals. Cookie ≫ bookmark ≫ history.
 */
export function scoreSitePriority(signals: SitePrioritySignals): number {
  const now = signals.nowUnix ?? Math.floor(Date.now() / 1000);
  let score = 0;
  if (signals.fresh_cookie) score += SITE_PRIORITY_WEIGHTS.freshAuthCookie;
  else if (signals.has_cookie) score += SITE_PRIORITY_WEIGHTS.anyCookie;
  if (signals.bookmarked) score += SITE_PRIORITY_WEIGHTS.bookmarked;
  if (
    signals.last_visit_unix &&
    signals.last_visit_unix > 0 &&
    now - signals.last_visit_unix <= THIRTY_DAYS_S
  ) {
    score += SITE_PRIORITY_WEIGHTS.recentVisit;
  }
  if ((signals.visit_count ?? 0) > 50) score += SITE_PRIORITY_WEIGHTS.highVisits;
  if (score > SITE_PRIORITY_WEIGHTS.cap) score = SITE_PRIORITY_WEIGHTS.cap;
  return Math.round(score * 100) / 100;
}

function normalizeHost(host: string): string {
  let h = (host || "").toLowerCase().trim();
  if (h.startsWith(".")) h = h.slice(1);
  if (h.startsWith("www.")) h = h.slice(4);
  try {
    if (h.includes("://")) h = new URL(h).hostname;
  } catch {
    /* keep h */
  }
  return h.replace(/^www\./, "");
}

/**
 * Cheap preference boost for a host from the daily-driver browser's
 * bookmarks + recent history (no cookie values). Used to bias resolve
 * shortlists when full auth-inventory is too heavy.
 *
 * Returns 0..0.25:
 *   bookmarked → 0.20
 *   recent history → 0.05
 */
export function preferenceBoostForHost(host: string): number {
  const h = normalizeHost(host);
  if (!h) return 0;
  try {
    const pref = browserPreferences({ sinceDaysAgo: 30 });
    const bookmarked = pref.bookmark_domains.some(
      (d) => d === h || h.endsWith(`.${d}`) || d.endsWith(`.${h}`),
    );
    const recent = pref.recent_domains.some(
      (d) => d === h || h.endsWith(`.${d}`) || d.endsWith(`.${h}`),
    );
    let score = 0;
    if (bookmarked) score += SITE_PRIORITY_WEIGHTS.bookmarked;
    if (recent) score += SITE_PRIORITY_WEIGHTS.recentVisit;
    return Math.round(score * 100) / 100;
  } catch {
    return 0;
  }
}

/**
 * Sort key for resolve shortlist entries: higher = prefer earlier.
 * Combines existing reliability_score with local preference boost.
 */
export function shortlistSortKey(entry: {
  reliability_score?: unknown;
  domain?: unknown;
  url?: unknown;
}): number {
  const rel = Number(entry.reliability_score) || 0;
  let host = "";
  if (typeof entry.domain === "string") host = entry.domain;
  else if (typeof entry.url === "string") {
    try {
      host = new URL(entry.url).hostname;
    } catch {
      host = "";
    }
  }
  const boost = host ? preferenceBoostForHost(host) : 0;
  // reliability is typically 0..1; boost 0..0.25. Prefer local personalization
  // as a secondary key without wiping server reliability.
  return rel + boost;
}
