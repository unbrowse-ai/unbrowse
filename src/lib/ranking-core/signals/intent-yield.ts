/**
 * src/ranking/signals/intent-yield.ts — P1 Wave-3 cluster #2 (intent-yield).
 *
 * Pure-function semantic intent-yield demotion + named weight constants
 * extracted byte-identical from src/execution/index.ts:rankEndpoints.
 *
 * Origin: PAPER_PLAN.md §P1 names "intent-yield (51780d7e)" as one of 6
 * historical scoring fixes that must live as named functions inside
 * `src/ranking/`. This module is the named home.
 *
 * What lives here today (byte-identical relocation):
 *   - `semanticIntentAdjustment(endpoint, intent)` — was at
 *     src/execution/index.ts:3147-3189. Returns a numeric delta based on
 *     resource_kind / action_kind / negative_tags / UI-scaffold detection.
 *   - 4 named weight constants for inline call sites in rankEndpoints
 *     that previously used magic numerics. Keeps the paper's ranker
 *     "table" greppable.
 *
 * What stays in src/execution/index.ts (cluster discipline):
 *   - The 11-regex local block at L3573-3592 (CURRENCY_TIME_PATTERNS,
 *     COMMS_INTENT, COMMS_PATH, plus 8 siblings). Function-local scope;
 *     a future cluster sub-wedge can lift the whole block.
 *   - tokenize / expandQuery / endpointToTokens (cluster #3+ territory).
 *   - The setup pipeline + the call sites themselves.
 *
 * Parity contract: tests/ranking-parity.test.ts holds the byte-identical
 * baseline. Any change to this function MUST update the parity baseline
 * in the same commit, with a CHANGELOG entry naming what changed.
 *
 * Inoculation #2 binds: the magic 100/15/45/120 multipliers were
 * historically tuned values; do not adjust without a reproducible
 * benchmark.
 */

import type { EndpointDescriptor } from "../../../types/skill.js";
import { resolveEndpointSemantic } from "../../../lib/graph-core/index.js";
import {
  intentResourceKinds,
  intentActionKinds,
} from "../../../execution/index.js";

/** Bonus per token match when descriptionMeta.source === "agent". */
export const AGENT_DESC_DELTA_WEIGHT = 100;

/** Bonus when CURRENCY_TIME_PATTERNS matches the endpoint pathname. */
export const CURRENCY_TIME_DELTA_WEIGHT = 15;

/** Bonus when intent is comms-shaped AND path matches comms-shape. */
export const COMMS_PATH_DELTA_WEIGHT = 45;

/** Bonus for stock-intent + /chart path + price-field signal in haystack. */
export const CHART_PRICING_DELTA_WEIGHT = 120;

export type RouteIntentCompatibility = "compatible" | "unknown" | "incompatible";

/**
 * Fail-closed semantic constraint used by the degraded/local ranker.
 *
 * This deliberately covers only contradictions that are explicit in the
 * intent and route evidence.  A weak/absent semantic annotation remains
 * `unknown`; an endpoint is rejected only when its declared action/resource
 * or unmistakable path says it serves a different operation.
 */
export function routeIntentCompatibility(endpoint: EndpointDescriptor, intent?: string, contextUrl?: string): RouteIntentCompatibility {
  const requested = (intent ?? "").toLowerCase();
  if (!requested.trim()) return "unknown";

  // Only authored/captured semantic declarations are binding. Inferred
  // semantics are useful ranking hints, but are not strong enough to reject a
  // route (e.g. an API search URL may be heuristically labelled "detail").
  const semantic = endpoint.semantic;
  const action = (semantic?.action_kind ?? "").toLowerCase();
  const resource = (semantic?.resource_kind ?? "").toLowerCase();
  const haystack = [endpoint.url_template, endpoint.description ?? "", resource, action].join(" ").toLowerCase();

  const pathOf = (value?: string): string => {
    if (!value) return "";
    try { return new URL(value).pathname.toLowerCase(); } catch { return value.toLowerCase(); }
  };
  const requestedPath = pathOf(contextUrl);
  const endpointPath = pathOf(endpoint.url_template);
  // Protocol feeds only. Product concepts named "feed" (LinkedIn /feed/, a
  // timeline action_kind=feed) are ordinary list APIs, not RSS/Atom resources.
  const isFeedPath = (path: string) => /(?:\/feeds?\/.*\.(?:rss|xml|atom)$|\.(?:rss|atom)$|\/(?:rss|atom)(?:\/|$))/i.test(path);
  const isSearchPath = (path: string) => /\/(?:search|find|lookup)(?:\/|$)/i.test(path);
  const isDetailPath = (path: string) => /\/(?:package|packages|crate|crates)\/[^/{?#]+\/?$/i.test(path)
    || /\/(?:package|packages|crate|crates)\/\{[^}]+\}\/?$/i.test(path);

  // The concrete URL class is binding throughout marketplace and local ranking.
  // These constraints deliberately precede scoring so no historical score can
  // turn a search replay into a detail/feed response (or the inverse).
  const wantsFeedClass = isFeedPath(requestedPath) || /\b(rss|atom|xml feed)\b/.test(requested);
  const wantsSearchClass = isSearchPath(requestedPath) || /\b(search|find|lookup)\b/.test(requested);
  // An explicit action in the intent wins over a page-shaped context URL. An
  // agent may ask to search while standing on /packages/http; that does not
  // transform the requested search operation into package detail.
  const wantsDetailClass = !wantsSearchClass && (isDetailPath(requestedPath) || /\b(detail|metadata for|information about)\b/.test(requested));
  const endpointFeedClass = isFeedPath(endpointPath);
  const endpointSearchClass = isSearchPath(endpointPath) || /^(search|list|browse)$/.test(action);
  const endpointDetailClass = isDetailPath(endpointPath) || /^(detail|get|fetch|read|single)$/.test(action);
  if (wantsFeedClass && !endpointFeedClass) return "incompatible";
  if (wantsSearchClass && endpointDetailClass && !endpointSearchClass) return "incompatible";
  if (wantsDetailClass && endpointSearchClass && !endpointDetailClass) return "incompatible";
  if (!wantsFeedClass && endpointFeedClass && (wantsSearchClass || wantsDetailClass)) return "incompatible";

  // Resource constraints are binding.  These are intentionally generic noun
  // families, not host-specific exceptions.
  const wantsJobs = /\b(job|jobs|vacanc(?:y|ies)|position|positions|role|roles)\b/.test(requested);
  const isReviews = /\b(review|reviews|rating|ratings|salary|salaries)\b/.test(haystack);
  if (wantsJobs && isReviews && !/\b(job|jobs|vacanc(?:y|ies)|position|positions)\b/.test(haystack)) {
    return "incompatible";
  }

  const wantsSearch = /\b(search|find|lookup)\b/.test(requested);
  const wantsList = wantsSearch || /\b(list|browse|discover|top|latest)\b/.test(requested);
  const requestedTokens = requested.match(/[a-z0-9]+/g) ?? [];
  const declaredResourceRequested = !!resource && requestedTokens.some((token) =>
    token === resource || token.startsWith(resource) || resource.startsWith(token),
  );
  if (wantsSearch && declaredResourceRequested && /^(detail|get|fetch|read|single)$/.test(action)) {
    return "incompatible";
  }

  // RSS/Atom is a feed operation.  It must not silently substitute for a
  // search/list route unless the user actually requested a feed/news stream.
  const isFeedRoute = /(?:\.rss|\.atom|\/rss(?:[/?#]|$)|\/feed(?:[/?#]|$)|\brss\b|\batom\b)/i.test(haystack);
  const wantsFeed = /\b(feed|rss|atom|news|updates|recent)\b/.test(requested);
  if (wantsList && isFeedRoute && !wantsFeed) return "incompatible";

  if (resource || action) return "compatible";
  return "unknown";
}

export function semanticIntentAdjustment(endpoint: EndpointDescriptor, intent?: string): number {
  if (routeIntentCompatibility(endpoint, intent) === "incompatible") return -1_000;
  const semantic = resolveEndpointSemantic(endpoint);
  if (!semantic || !intent) return 0;
  const resourceKinds = intentResourceKinds(intent);
  const actionKinds = intentActionKinds(intent);
  let delta = 0;

  const resource = (semantic.resource_kind ?? "").toLowerCase();
  const action = (semantic.action_kind ?? "").toLowerCase();
  const negatives = new Set((semantic.negative_tags ?? []).map((tag) => tag.toLowerCase()));
  const haystack = [
    endpoint.url_template,
    endpoint.description ?? "",
    semantic.description_out ?? "",
    semantic.response_summary ?? "",
  ].join(" ").toLowerCase();
  const uiScaffold = /(sharebox|closedsharebox|mailbox|messaging|conversation|notification|notifications|alerts?|presence|badging|launchpad|previewbanner|main_feed|feedtype)/i.test(haystack);

  if (resourceKinds.length > 0) {
    if (resourceKinds.some((kind) => resource.includes(kind) || kind.includes(resource))) delta += 80;
    else if (resource) delta -= 90;
  }

  if (actionKinds.length > 0) {
    if (actionKinds.some((kind) => action.includes(kind) || kind.includes(action))) delta += 25;
    else if (action) delta -= 25;
  }

  if (negatives.has("config") || negatives.has("telemetry") || negatives.has("experiment") || negatives.has("auth")) {
    delta -= 60;
  }
  if (negatives.has("adjacent") || negatives.has("ads")) {
    delta -= 90;
  }
  if (uiScaffold && (resourceKinds.length > 0 || actionKinds.length > 0)) {
    delta -= 220;
  }

  return delta;
}
