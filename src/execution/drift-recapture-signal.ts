// AC3 lane-04: surface a re_capture_after_drift signal when execution
// observes response-schema drift on a previously successful capture.
// The signal tells the calling agent to invoke unbrowse_go in headful
// mode against the contextUrl so the substrate can re-learn the new
// shape, then return to headless replay on the next call. Headful is
// the LEARNING path, not the serving path.
//
// Pure function. No I/O. The substrate emits the signal; the agent
// decides whether and when to act on it. No per-domain heuristic.

import type { DriftResult } from "../types/skill.js";

export interface DriftRecaptureSignal {
  kind: "re_capture_after_drift";
  url: string;
  intent?: string;
  reason: "type_changes_detected" | "fields_added_or_removed";
  drift_summary: {
    added_fields: string[];
    removed_fields: string[];
    type_changes: Array<{ path: string; was: string; now: string }>;
  };
  next_action: {
    tool: "unbrowse_go";
    args: {
      url: string;
      headless: boolean;
    };
  };
}

interface EndpointShape {
  endpoint_id?: string;
  url_template?: string;
  method?: string;
}

export function buildDriftRecaptureSignal(
  drift: DriftResult,
  endpoint: EndpointShape,
  contextUrl: string | undefined,
  intent?: string,
): DriftRecaptureSignal | null {
  if (!drift.drifted) return null;

  const url = (contextUrl && contextUrl.trim().length > 0)
    ? contextUrl
    : (endpoint.url_template && endpoint.url_template.trim().length > 0 ? endpoint.url_template : null);

  if (!url) return null;

  const reason: DriftRecaptureSignal["reason"] = drift.type_changes.length > 0
    ? "type_changes_detected"
    : "fields_added_or_removed";

  const visibleBrowserHeadless = Boolean(0);
  const signal: DriftRecaptureSignal = {
    kind: "re_capture_after_drift",
    url,
    reason,
    drift_summary: {
      added_fields: drift.added_fields.slice(),
      removed_fields: drift.removed_fields.slice(),
      type_changes: drift.type_changes.slice(),
    },
    next_action: {
      tool: "unbrowse_go",
      args: {
        url,
        headless: visibleBrowserHeadless,
      },
    },
  };
  if (intent && intent.length > 0) signal.intent = intent;
  return signal;
}
