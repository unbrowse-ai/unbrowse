// What an event may hold: the same lists the node checks against (unbrowse-node/app/src/telemetry.rs), kept in
// ../schema.json. Both sides' tests read that file, so neither list can drift from it.

export const FIELDS = ["event", "version", "os", "install_id", "tool", "outcome", "duration_ms", "error_class", "from"];
/** `from`, the source tag a node was first started with (`unbrowse start --from <tag>`), rides on this event alone. */
export const FROM_EVENT = "node_start";
export const FROM_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const REQUIRED = ["event", "version", "os", "install_id", "outcome"];
export const EVENTS = ["node_start", "tool_call", "route_failed", "fetch_failed"];
export const TOOLS = [
  "unbrowse_search",
  "unbrowse_do",
  "unbrowse_browse",
  "unbrowse_call",
  "/v1/routes",
  "/v1/do",
  "/v1/browse",
  "/v1/routes/{id}/call",
  "/v1/remote/call/{id}",
];
export const OUTCOMES = ["ok", "failed", "error"];
export const ERROR_CLASSES = [
  "bad_request",
  "unauthorized",
  "payment_required",
  "forbidden",
  "not_found",
  "conflict",
  "unavailable",
  "internal",
  "site",
  "other",
  // How a route use failed: a failed route call or paid fetch's variant, by name alone (the node's \`failure_class\`).
  "step_status",
  "door",
  "not_an_answer",
  "needs_browser",
  "source_missing",
  "unsupported_body",
  "breaks_body",
  "missing_input",
  "missing_minted",
  "shape_mismatch",
  "http",
  "transport",
  "bad_url",
  "refused",
  "refused_hop",
  "file",
  "socket",
  "no_body",
];
export const OSES = ["macos", "linux", "windows", "other"];
export const MAX_DURATION_MS = 86_400_000;
export const MAX_EVENTS = 100;
export const MAX_BODY_BYTES = 65_536;

const LISTS = { event: EVENTS, tool: TOOLS, outcome: OUTCOMES, error_class: ERROR_CLASSES, os: OSES };

/** Whether a value looks like an address of any kind: a URL, a host, a host and port, an email or an IP address. */
export function urlLike(s) {
  if (/[:@?#\\\s]/.test(s)) return true;
  const labels = s.split(".");
  for (let i = 1; i < labels.length; i++) {
    if (/[A-Za-z0-9]$/.test(labels[i - 1]) && /^[A-Za-z]{2,}/.test(labels[i])) return true;
  }
  return labels.length === 4 && labels.every((l) => /^[0-9]+$/.test(l));
}

export function isVersion(s) {
  return s.length <= 32 && /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(s);
}

/** Checks one event: only the allowed fields, every required one, each value from its list or of its shape. */
export function check(e) {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return "an event is an object";
  for (const k of Object.keys(e)) {
    if (!FIELDS.includes(k)) return `field not allowed: ${k}`;
  }
  for (const k of REQUIRED) {
    if (!(k in e)) return `missing field: ${k}`;
  }
  if ("from" in e && e.event !== FROM_EVENT) return `from goes on ${FROM_EVENT} only`;
  for (const [k, v] of Object.entries(e)) {
    if (k === "duration_ms") {
      if (!Number.isSafeInteger(v) || v < 0 || v > MAX_DURATION_MS) {
        return "duration_ms is a whole number of milliseconds up to a day";
      }
      continue;
    }
    if (typeof v !== "string") return `${k} is a string`;
    if (urlLike(v)) return `${k} looks like an address`;
    const fits =
      k in LISTS
        ? LISTS[k].includes(v)
        : k === "version"
          ? isVersion(v)
          : k === "install_id"
            ? /^[0-9a-f]{32}$/.test(v)
            : k === "from"
              ? FROM_PATTERN.test(v)
              : false;
    if (!fits) return `${k} is not an allowed value`;
  }
  return null;
}

/** Checks a whole batch, `{"events": [...]}`: one bad event refuses the batch. Returns the events, or the reason. */
export function checkBatch(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { error: "the body is an object" };
  for (const k of Object.keys(body)) {
    if (k !== "events") return { error: `field not allowed: ${k}` };
  }
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) return { error: "events is a list of at least one event" };
  if (events.length > MAX_EVENTS) return { error: `at most ${MAX_EVENTS} events a batch` };
  for (let i = 0; i < events.length; i++) {
    const why = check(events[i]);
    if (why) return { error: `event ${i}: ${why}` };
  }
  return { events };
}
