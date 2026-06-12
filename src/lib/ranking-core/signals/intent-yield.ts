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
import { resolveEndpointSemantic } from "../../../graph/index.js";
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

export function semanticIntentAdjustment(endpoint: EndpointDescriptor, intent?: string): number {
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
