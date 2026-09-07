/**
 * no-match-next-step: pure helper that decides which retry command the
 * orchestrator should recommend when resolve falls through to status:no_match.
 *
 * Substrate principle (CLAUDE.md): "browser-open is failure mode, not
 * feature". When the probe winner already proved the URL is server-fetchable
 * (HTTP 200, text/html or json, body large enough to carry content), the
 * agent should be told to call `unbrowse fetch` first. `unbrowse capture`
 * spawns a Kuri tab (2+ seconds, multi-step) and is the right answer ONLY
 * when the page actually requires browser rendering (SPA shell, JS-rendered)
 * or when there is no probe evidence at all (budget-deadline race miss).
 *
 * This helper is the only place that owns that branching. It is called from
 * both no_match emit-sites in `orchestrator/index.ts` (probe-winner-no-exa
 * and budget-deadline-no-probe). The orchestrator itself never decides what
 * to recommend.
 */

export interface ProbeEvidenceInput {
  status: number;
  content_type?: string;
  byte_length?: number;
}

export interface BuildNoMatchNextStepArgs {
  contextUrl: string;
  intent: string;
  probeEvidence?: ProbeEvidenceInput;
}

export interface NoMatchNextStep {
  /** Which retry path the agent should try first. */
  recommended: "fetch" | "capture";
  /** Human-readable explanation; lands in decision_trace. */
  reason: string;
  /** Concrete shell commands the agent can copy-paste. Always non-empty for `capture`; only present for `fetch` when the probe says the URL is fetchable. */
  commands: {
    fetch?: string;
    capture: string;
  };
  /** Estimated wall-clock for the recommended path. */
  est_ms: number;
  /** True when running `commands.recommended` will publish a marketplace skill. */
  creates_skill: boolean;
}

const JSON_LIKE = /(application\/json|application\/[\w.+-]+\+json|text\/csv|application\/xml|text\/xml)/i;
const HTML_LIKE = /text\/html|application\/xhtml\+xml/i;

// Minimum body size (Content-Length) that argues "this server-rendered the
// content, not a SPA shell". Below this, the page probably needs JS to fill
// in the data, so a libcurl fetch returns an empty skeleton. The threshold
// matches the SMALL_HTML_BYTES gate in execution/probe.ts (5KB).
const SMALL_HTML_BYTES = 5_000;

export function buildNoMatchNextStep(args: BuildNoMatchNextStepArgs): NoMatchNextStep {
  const { contextUrl, intent, probeEvidence } = args;

  const captureCommand =
    `unbrowse capture --url ${JSON.stringify(contextUrl)} --intent ${JSON.stringify(intent)}`;
  const fetchCommand = `unbrowse fetch ${JSON.stringify(contextUrl)}`;

  // No probe ran (budget-deadline path) — capture is the only honest answer.
  if (!probeEvidence) {
    return {
      recommended: "capture",
      reason: "no probe evidence; capture is the safe default",
      commands: { capture: captureCommand },
      est_ms: 8000,
      creates_skill: true,
    };
  }

  const { status, content_type = "", byte_length } = probeEvidence;

  // Network error or non-2xx — capture (which can drive auth, follow redirects via Kuri, etc.).
  if (status < 200 || status >= 400 || status === 0) {
    return {
      recommended: "capture",
      reason: `probe status ${status}; capture handles auth + redirects`,
      commands: { capture: captureCommand },
      est_ms: 8000,
      creates_skill: true,
    };
  }

  const isHtml = HTML_LIKE.test(content_type);
  const isJson = JSON_LIKE.test(content_type);
  const bodyLarge = (byte_length ?? 0) >= SMALL_HTML_BYTES;

  // JSON probe wins — direct fetch is the cheap path. Always recommend fetch
  // regardless of body size (small JSON is still real data).
  if (isJson) {
    return {
      recommended: "fetch",
      reason: `probe ${status} + ${content_type} is directly fetchable`,
      commands: { fetch: fetchCommand, capture: captureCommand },
      est_ms: 800,
      creates_skill: false,
    };
  }

  // Server-rendered HTML page with enough body to carry the content —
  // libcurl-impersonate fetch returns the page in ~200ms. Browser open
  // would be 2+ seconds for the same bytes.
  if (isHtml && bodyLarge) {
    return {
      recommended: "fetch",
      reason: `probe ${status} + html ${byte_length}B server-rendered, fetch is cheaper than browser`,
      commands: { fetch: fetchCommand, capture: captureCommand },
      est_ms: 800,
      creates_skill: false,
    };
  }

  // Everything else (small HTML shell, unknown content-type, binary blobs,
  // video, etc.) — capture is the right answer.
  return {
    recommended: "capture",
    reason: `probe ${status} + ${content_type || "unknown"} ${byte_length ?? "?"}B; capture for full discovery`,
    commands: { capture: captureCommand },
    est_ms: 8000,
    creates_skill: true,
  };
}
