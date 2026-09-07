export const AGENT_PATH = Object.freeze({
  cli: Object.freeze({
    primary: "unbrowse \"<task>\" --url <url>",
    auth: "unbrowse auth <login_url>",
    capture: 'unbrowse capture --url <url> --intent "<task>"',
  }),
  mcp: Object.freeze({
    primary: "unbrowse_breath_get(intent, url)",
    auth: "unbrowse_breath_auth_capture",
    capture: "unbrowse_breath_capture",
  }),
});

export const DEFAULT_AGENT_MCP_TOOLS = Object.freeze([
  "unbrowse_breath_get",
  "unbrowse_breath_auth_capture",
  "unbrowse_breath_capture",
  "unbrowse_eval_feedback",
  "unbrowse_eval_status",
  "unbrowse_diagnose",
] as const);

export function agentPathHelpLines(): string[] {
  return [
    "Agent path (three moves only):",
    `  1. Any read/search/list/get  → ${AGENT_PATH.cli.primary}`,
    `  2. auth_required            → run next_step once (or ${AGENT_PATH.cli.auth}), then retry #1 once`,
    `  3. miss/empty/capture        → run next_step once (or ${AGENT_PATH.cli.capture}), then retry #1 once`,
  ];
}

export function agentMcpPolicy(): string {
  return [
    `PRIMARY website tool: ${AGENT_PATH.mcp.primary}. Do not use curl/WebFetch/browser loops.`,
    `On failure: run the response next_step once (or ${AGENT_PATH.mcp.auth} on auth_required, ${AGENT_PATH.mcp.capture} on miss), then get again once.`,
    "Do not pick browsers, profiles, or env flags. Do not hand-drive resolve/navigate for ordinary reads.",
    "After showing results to the user: unbrowse_eval_feedback. Mutations: dry_run first.",
    "Persistent failures (auth broken after sign-in, repeated misses, wrong data): file a GitHub issue via the gh CLI — gh issue create --repo unbrowse-ai/unbrowse.",
  ].join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function commandFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^unbrowse(?:\s|$)/.test(trimmed) ? trimmed : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.command === "string" && /^unbrowse(?:\s|$)/.test(record.command.trim())) {
    return record.command.trim();
  }
  if (Array.isArray(record.suggested_commands)) {
    for (const candidate of record.suggested_commands) {
      if (typeof candidate !== "string") continue;
      const trimmed = candidate.trim();
      if (/^unbrowse(?:\s|$)/.test(trimmed)) return trimmed;
    }
  }
  return undefined;
}

function textFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstString(records: Array<Record<string, unknown> | undefined>, key: string): string | undefined {
  for (const record of records) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function cleanRecoveryAlternatives(record: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...record };
  delete cleaned.next_step;
  delete cleaned.next_action;
  delete cleaned.next_actions;
  delete cleaned.suggested_commands;
  return cleaned;
}

export function convergeAgentFrontDoorResult(
  payload: Record<string, unknown>,
  input: { intent: string; url: string },
): Record<string, unknown> {
  const nested = asRecord(payload.result);
  const trace = asRecord(payload.trace);
  const records = [payload, nested];
  const errors = records
    .flatMap((record) => [record?.error, record?.blocker])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  const statuses = records
    .map((record) => record?.status)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  const failureStatuses = new Set([
    "auth_required",
    "session_expired",
    "no_match",
    "no_cached_match",
    "not_found",
    "empty",
    "empty_result",
    "payment_required",
    "needs_browser",
    "browse_required",
  ]);
  const deferred = payload.result == null && (
    payload.next_step !== undefined
    || payload.next_action !== undefined
    || payload.next_actions !== undefined
    || Array.isArray(payload.available_endpoints)
  );
  const failed = payload.ok === false
    || trace?.success === false
    || errors.length > 0
    || statuses.some((status) => failureStatuses.has(status))
    || deferred;

  if (!failed) {
    const cleaned = cleanRecoveryAlternatives(payload);
    // compulsory hints: every success still tells the agent how to get MORE (capture/scroll) — never a dead end
    const _hints = (() => {
      if (process.env.UNBROWSE_NO_HINTS === "1") return [];
      const _url = input.url, _intent = input.intent;
      const _res = (payload.result as Record<string, unknown>) ?? payload;
      const _source = typeof payload.source === "string" ? payload.source as string : "direct-document";
      const _md = typeof _res.markdown === "string" ? _res.markdown as string : typeof _res.text === "string" ? _res.text as string : "";
      const _links: string[] = Array.isArray(_res.links) ? _res.links as string[] : [];
      const _raw = JSON.stringify(_res);
      const _actions: Array<{ command: string; why: string }> = [];
      const _sq = (s: string) => JSON.stringify(s);
      if (_raw.length >= 65536) _actions.push({ command: `unbrowse --path <jsonPath> --limit 25 ${_sq(_intent)} --url ${_sq(_url)}`, why: "Response >64KB truncated; filter with --path/--extract/--limit or --schema, or --raw for full envelope." });
      if (_source === "direct-document" && _url) _actions.push({ command: `unbrowse capture --url ${_sq(_url)} --intent ${_sq(_intent)}`, why: "No local-skill yet; capturing indexes the listing XHR so next call is a sub-ms API replay instead of re-scraped HTML." });
      const _listLike = /\b(list|top|recent|search|find|browse|show|feed)\b/i.test(_intent);
      const _hasPag = /(more|next|load more|show more|page\s*\d|pagination)/i.test([_md, ..._links].join("\n"));
      if (_listLike && _hasPag) {
        _actions.push({ command: "unbrowse scroll", why: "List intent with pagination/truncation signal — more items may lie below fold; scroll then re-read." });
        const _nextLink = _links.find((l) => /page=\d+|next|more/i.test(l));
        if (_nextLink) _actions.push({ command: `unbrowse go --url ${_sq(_nextLink)}`, why: "Discovered next-page link; navigating it surfaces the next slice of the listing." });
      }
      if (_res.rejected === true && !_actions.some((a) => a.command.startsWith("unbrowse capture"))) {
        _actions.push({ command: `unbrowse capture --url ${_sq(_url)} --intent ${_sq(_intent)}`, why: "Direct document was an interstitial/JS challenge; capturing via browser may yield the real XHR/API." });
      }
      if (_actions.length === 0) _actions.push({ command: `unbrowse capture --url ${_sq(_url)} --intent ${_sq(_intent)}`, why: "If the current answer is incomplete (e.g. fewer items than expected), capturing teaches the engine the real listing API for next call." });
      return _actions;
    })();
    return {
      ...cleaned,
      ...(nested ? { result: cleanRecoveryAlternatives(nested) } : {}),
      suggested_next_actions: _hints,
      agent_path: { step: 1, status: "complete", primary: AGENT_PATH.cli.primary },
    };
  }

  const candidates = [payload.next_step, nested?.next_step, payload.next_action, nested?.next_action];
  const existingCommand = candidates.map(commandFrom).find(Boolean);
  const existingText = candidates.map(textFrom).find(Boolean);
  const allCodes = [...errors, ...statuses];
  const authRequired = allCodes.some((code) => code === "auth_required" || code === "session_expired");
  const captureRequired = allCodes.some((code) => ["no_match", "no_cached_match", "not_found", "empty", "empty_result"].includes(code));
  const paymentRequired = allCodes.includes("payment_required");
  const loginUrl = firstString(records, "login_url") ?? input.url;
  const retry = `unbrowse ${JSON.stringify(input.intent)} --url ${JSON.stringify(input.url)}`;

  const nextStep = existingCommand
    ?? (authRequired
      ? `unbrowse auth ${JSON.stringify(loginUrl)}`
      : captureRequired
        ? `unbrowse capture --url ${JSON.stringify(input.url)} --intent ${JSON.stringify(input.intent)}`
        : undefined);
  const step = authRequired ? 2 : captureRequired ? 3 : existingCommand ? "next_step" : "hold";
  const gateReason = paymentRequired
    ? "Payment authorization is required; do not capture around the payment gate."
    : existingText ?? "Stop here and inspect the returned error; do not try a different route blindly.";
  const cleaned = cleanRecoveryAlternatives(payload);

  return {
    ...cleaned,
    ...(nested ? { result: cleanRecoveryAlternatives(nested) } : {}),
    ...(nextStep ? { next_step: nextStep } : {
      gate: {
        decision: paymentRequired ? "ask" : "deny",
        reason: gateReason,
      },
    }),
    agent_path: {
      step,
      status: step === "hold" ? "blocked" : "recovery",
      action: nextStep ?? gateReason,
      ...(step === "hold" ? {} : { then_retry_once: retry }),
    },
  };
}


/** Default one-hole stdout budget. Operators can request the full envelope with --raw. */
export const AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES = 16_384;

function boundedValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 25).map(boundedValue);
  if (!asRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["raw", "diagnostic", "decision_trace", "workflow_dag", "available_endpoints", "skill"].includes(key)) continue;
    if ((key === "text" || key === "markdown") && Object.keys(value as Record<string, unknown>).some((k) => ["data", "items", "results", "answer"].includes(k))) continue;
    out[key] = boundedValue(child);
  }
  return out;
}

/**
 * Project the operator/debug envelope into the task-shaped default promised by
 * the one-hole CLI. The full byte-for-byte envelope remains available via
 * `--raw`; this projection carries the answer/items, minimal provenance, and
 * the single recovery instruction only.
 */
export function compactAgentFrontDoorResult(
  payload: Record<string, unknown>,
  input: { intent: string; url: string },
): Record<string, unknown> {
  const nested = asRecord(payload.result);
  const trace = asRecord(payload.trace);
  const source = typeof payload.source === "string" ? payload.source
    : typeof nested?.source === "string" ? nested.source
      : undefined;
  const selected: Record<string, unknown> = {};
  const taskKeys = [
    "error", "status", "message", "answer", "items", "results", "data",
    "available_operations", "missing_bindings", "next_step", "next_action", "suggested_next_actions", "next_actions", "gate",
  ];
  for (const key of taskKeys) {
    const value = nested?.[key] ?? payload[key];
    if (value !== undefined) selected[key] = boundedValue(value);
  }
  // direct-document: the markdown/text IS the answer even when data/items stubs exist — lift it explicitly so reddit/HN compact shows posts
  // Only for direct-document/dom-fallback sources; route-cache with items should stay compact (the test expects text dropped)
  const _compactSource = typeof payload.source === "string" ? payload.source as string : typeof (nested as Record<string, unknown> | undefined)?.source === "string" ? (nested as Record<string, unknown>).source as string : undefined;
  if (_compactSource === "direct-document" || _compactSource === "dom-fallback") {
    const liftedMarkdown = nested?.markdown ?? payload.markdown;
    if (typeof liftedMarkdown === "string" && liftedMarkdown.length > 0 && selected.markdown === undefined) {
      selected.markdown = boundedValue(liftedMarkdown);
    }
    const liftedText = nested?.text_excerpt ?? nested?.text ?? payload.text_excerpt ?? payload.text;
    if (typeof liftedText === "string" && liftedText.length > 0 && selected.text_excerpt === undefined && selected.text === undefined) {
      selected.text_excerpt = boundedValue(liftedText);
    }
  }
  // Some execution paths return the useful collection directly as `result`.
  // Recovery hints/status metadata must not make that task value disappear.
  const selectedHasTaskValue = ["answer", "items", "results", "data", "available_operations"]
    .some((key) => selected[key] !== undefined);
  if (!selectedHasTaskValue && payload.result !== undefined) {
    selected.result = boundedValue(payload.result);
  }

  const provenance: Record<string, unknown> = {};
  for (const key of ["trace_id", "skill_id", "endpoint_id"]) {
    if (typeof trace?.[key] === "string" && trace[key]) provenance[key] = trace[key];
  }
  if (typeof payload.cache_hit === "boolean") provenance.cache_hit = payload.cache_hit;
  const timing = asRecord(payload.timing);
  if (typeof timing?.cache_hit === "boolean") provenance.cache_hit = timing.cache_hit;
  if (typeof timing?.browser_opened === "boolean") provenance.browser_opened = timing.browser_opened;

  const compact: Record<string, unknown> = {
    ok: payload.ok !== false && trace?.success !== false && selected.error === undefined,
    intent: input.intent,
    url: input.url,
    ...selected,
    ...(source ? { source } : {}),
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
    ...(payload.agent_path ? { agent_path: boundedValue(payload.agent_path) } : {}),
  };

  const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (byteLength(compact) > AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES) {
    const shrink = (value: unknown, depth = 0): unknown => {
      if (typeof value === "string") return value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value;
      if (Array.isArray(value)) return value.slice(0, depth === 0 ? 10 : 5).map((item) => shrink(item, depth + 1));
      if (!asRecord(value)) return value;
      if (depth >= 4) return "[truncated object]";
      return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, child]) => [key, shrink(child, depth + 1)]));
    };
    for (const [key, value] of Object.entries(compact)) compact[key] = shrink(value);
    compact.truncated = true;
    compact.full_output = "Re-run with --raw for the complete operator envelope.";

    if (byteLength(compact) > AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES) {
      const taskValue = compact.answer ?? compact.items ?? compact.results ?? compact.data ?? compact.result;
      const minimal: Record<string, unknown> = {
        ok: compact.ok,
        intent: typeof compact.intent === "string" ? compact.intent.slice(0, 1_000) : compact.intent,
        url: typeof compact.url === "string" ? compact.url.slice(0, 1_000) : compact.url,
        ...(["error", "status", "message", "next_step", "gate", "agent_path", "source"]
          .reduce<Record<string, unknown>>((out, key) => {
            if (compact[key] !== undefined) out[key] = shrink(compact[key], 1);
            return out;
          }, {})),
        ...(taskValue === undefined ? {} : { preview: shrink(taskValue, 1) }),
        truncated: true,
        full_output: "Re-run with --raw for the complete operator envelope.",
      };
      if (byteLength(minimal) > AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES) delete minimal.preview;
      if (byteLength(minimal) > AGENT_FRONT_DOOR_OUTPUT_BUDGET_BYTES) {
        const short = (value: unknown, limit: number) => typeof value === "string"
          ? (value.length > limit ? `${value.slice(0, limit)}…` : value)
          : undefined;
        return {
          ok: compact.ok,
          intent: short(compact.intent, 512),
          url: short(compact.url, 1_024),
          error: short(compact.error, 512),
          status: short(compact.status, 128),
          message: short(compact.message, 512),
          next_step: short(compact.next_step, 1_024),
          truncated: true,
          full_output: "Re-run with --raw for the complete operator envelope.",
        };
      }
      return minimal;
    }
  }
  return compact;
}

export async function recordHarnessLastRun(
  input: { intent: string; url: string },
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { writeLastRun: _writeLastRun, appendTranscript: _appendTranscript } = await import("./harness/memory.js");
    const nextStep = (() => {
      const v = (payload as Record<string, unknown>).next_step;
      if (typeof v === "string") return v;
      const nested = (payload.result as Record<string, unknown> | undefined)?.next_step;
      if (typeof nested === "string") return nested;
      if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).command === "string") {
        return (nested as Record<string, unknown>).command as string;
      }
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).command === "string") {
        return (v as Record<string, unknown>).command as string;
      }
      return undefined;
    })();
    const gate = (payload as Record<string, unknown>).gate ?? (payload.result as Record<string, unknown> | undefined)?.gate;
    const ok = (payload as Record<string, unknown>).ok !== false && (payload.trace as Record<string, unknown> | undefined)?.success !== false;
    const status = (() => {
      const a = (payload as Record<string, unknown>).status;
      if (typeof a === "string") return a;
      const b = (payload.result as Record<string, unknown> | undefined)?.status;
      if (typeof b === "string") return b;
      const c = (payload.result as Record<string, unknown> | undefined)?.error;
      if (typeof c === "string") return c;
      const d = (payload as Record<string, unknown>).error;
      if (typeof d === "string") return d;
      return undefined;
    })();
    const cmd = `unbrowse ${JSON.stringify(input.intent)} --url ${JSON.stringify(input.url)}`;
    _writeLastRun({ at: new Date().toISOString(), intent: input.intent, url: input.url, ok, status, next_step: nextStep, gate, agent_path: (payload as Record<string, unknown>).agent_path, command: cmd });
    _appendTranscript({ at: new Date().toISOString(), command: cmd, ok, status, next_step: nextStep });
  } catch {
    // harness memory is best-effort — never break the foreground result
  }
}

