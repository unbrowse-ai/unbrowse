// Unbrowse run semantics, kept honest: a run is reported as done only when the server says it succeeded;
// input_required asks the user for the named fields; no_capability falls back to the cloud browser when a URL is known.
import type { IAgentRuntime } from "@elizaos/core";
import { callTool, describeError, resultText, setting, type ErrorInfo, type McpToolResult } from "./client.ts";
import { clip, pretty } from "./text.ts";

export type Requirement = {
  id?: string;
  affectedAction?: string;
  reason?: string;
  kind?: string;
  state?: string;
  sensitivity?: string;
  options?: { id?: string; label?: string; value?: unknown }[];
  interactionUrl?: string;
};

export type RunView = {
  runId?: string;
  status?: string;
  phase?: string;
  capabilityId?: string | null;
  result?: unknown;
  error?: { code?: string; message?: string } | null;
  requirements?: Requirement[];
  verified?: boolean;
  signIn?: { url?: string; message?: string };
  truncated?: boolean;
};

/** Outcome of any plugin operation, ready to become an ActionResult. */
export type Outcome = {
  success: boolean;
  text: string;
  kind: string;
  data: Record<string, unknown>;
  error?: ErrorInfo;
};

const TERMINAL = new Set(["succeeded", "failed", "input_required", "outcome_unknown", "cancelled", "canceled", "expired"]);

export function maxChars(runtime: IAgentRuntime): number {
  const n = Number(setting(runtime, "UNBROWSE_MAX_CHARS"));
  return Number.isFinite(n) && n > 200 ? n : 8000;
}

function num(runtime: IAgentRuntime, key: string, fallback: number): number {
  const n = Number(setting(runtime, key));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function runView(r: McpToolResult): RunView {
  const s = r.structuredContent;
  if (s && typeof s === "object" && !Array.isArray(s)) return s as RunView;
  try {
    return JSON.parse(resultText(r)) as RunView;
  } catch {
    return {};
  }
}

export function openRequirements(view: RunView): Requirement[] {
  return (view.requirements ?? []).filter((r) => !r.state || r.state === "open");
}

// ---- pending runs (input_required), per runtime and room, so a follow-up message can answer them ----

type Pending = { runId: string; requirements: Requirement[]; at: number };
const pendingByRuntime = new WeakMap<object, Map<string, Pending>>();

function pendingMap(runtime: IAgentRuntime): Map<string, Pending> {
  let m = pendingByRuntime.get(runtime);
  if (!m) pendingByRuntime.set(runtime, (m = new Map()));
  return m;
}
export function getPending(runtime: IAgentRuntime, roomId: string | undefined): Pending | undefined {
  const p = pendingMap(runtime).get(roomId ?? "");
  return p && Date.now() - p.at < 60 * 60 * 1000 ? p : undefined;
}
export function setPending(runtime: IAgentRuntime, roomId: string | undefined, p: Pending | undefined) {
  if (p) pendingMap(runtime).set(roomId ?? "", p);
  else pendingMap(runtime).delete(roomId ?? "");
}

// ---- formatting ----

function describeRequirement(r: Requirement): string {
  const field = r.affectedAction ?? r.id ?? "input";
  const opts = r.options?.length ? ` Options: ${r.options.slice(0, 10).map((o) => o.label ?? pretty(o.value)).join(" | ")}` : "";
  const link = r.interactionUrl ? ` Open: ${r.interactionUrl}` : "";
  const secret = r.sensitivity === "secret" ? " (sensitive: use the link, do not type it in chat)" : "";
  return `- ${field}: ${r.reason ?? "required"}${secret}${opts}${link}`;
}

/** Turn a run view into an outcome. Only `succeeded` is success. */
export function runOutcome(runtime: IAgentRuntime, view: RunView, roomId?: string): Outcome {
  const base = { runId: view.runId, status: view.status, capabilityId: view.capabilityId ?? null };
  const max = maxChars(runtime);
  switch (view.status) {
    case "succeeded": {
      setPending(runtime, roomId, undefined);
      const via = view.capabilityId ? ` via ${view.capabilityId}` : "";
      return {
        success: true,
        kind: "succeeded",
        text: `Unbrowse run ${view.runId ?? ""} succeeded${via}${view.verified === false ? " (not verified)" : ""}.\n${clip(pretty(view.result), max)}`,
        data: { ...base, result: view.result, verified: view.verified },
      };
    }
    case "input_required": {
      const reqs = openRequirements(view);
      if (view.runId) setPending(runtime, roomId, { runId: view.runId, requirements: reqs, at: Date.now() });
      const signIn = view.signIn?.url ? `\nSign in first: ${view.signIn.url}` : "";
      const fields = reqs.map((r) => r.affectedAction ?? r.id ?? "input");
      return {
        // The run is paused, not failed: the action did its job by surfacing the question.
        success: true,
        kind: "input_required",
        text: `Unbrowse needs more information to continue (run ${view.runId}):\n${reqs.map(describeRequirement).join("\n") || "- (see run)"}${signIn}\nReply with the values, e.g. "${fields[0] ?? "field"}: …".`,
        data: { ...base, requirements: reqs, fields, signIn: view.signIn },
      };
    }
    case "outcome_unknown":
      return {
        success: false,
        kind: "outcome_unknown",
        text: `Unbrowse could not confirm whether run ${view.runId} took effect. Check the destination before retrying.`,
        data: { ...base, result: view.result },
        error: { code: "outcome_unknown", message: "outcome unknown", text: "outcome unknown" },
      };
    default: {
      const code = view.error?.code ?? view.status ?? "failed";
      const message = view.error?.message ?? `Run ended with status ${view.status ?? "unknown"}.`;
      if (view.signIn?.url) {
        return { success: false, kind: "login_required", text: `This site needs a saved login: ${view.signIn.url}`, data: { ...base, signIn: view.signIn }, error: { code: "login_required", message, url: view.signIn.url, text: message } };
      }
      return {
        success: false,
        kind: code,
        text: code === "no_capability" ? "Unbrowse has no reusable route for this task yet." : `Unbrowse run failed (${code}): ${message}`,
        data: { ...base, result: view.result, error: view.error },
        error: { code, message, text: message },
      };
    }
  }
}

export function errorOutcome(err: unknown, kind = "error"): Outcome {
  const e = describeError(err);
  return { success: false, kind: e.code || kind, text: e.text, data: { error: { code: e.code, message: e.message, retryAfter: e.retryAfter, url: e.url } }, error: e };
}

/** Poll a still-running run with unbrowse.inspect until it is terminal or the budget runs out. */
async function settle(runtime: IAgentRuntime, view: RunView): Promise<RunView> {
  const interval = num(runtime, "UNBROWSE_POLL_MS", 2000);
  const deadline = Date.now() + num(runtime, "UNBROWSE_RUN_TIMEOUT_MS", 90_000);
  while (view.runId && view.status && !TERMINAL.has(view.status) && Date.now() < deadline) {
    await sleep(interval);
    view = runView(await callTool(runtime, "unbrowse.inspect", { runId: view.runId }));
  }
  return view;
}

// ---- operations ----

/** A failure of the cloud-browser render itself (not of the site): plain HTTP may still have the content. */
const RENDER_FAILURE = /page\.goto|net::ERR_|browserType|Target page, context or browser has been closed|render_failed|No renderer could load/i;

function scrapeOutcome(runtime: IAgentRuntime, url: string, r: McpToolResult, renderFallback: boolean): Outcome {
  const s = (r.structuredContent ?? {}) as { markdown?: string; text?: string; metadata?: { title?: string; statusCode?: number }; finalUrl?: string; via?: string };
  const body = s.markdown ?? s.text ?? resultText(r);
  if (r.isError) return { success: false, kind: "scrape_failed", text: `Unbrowse could not read ${url}: ${clip(body, 500)}`, data: { url }, error: { code: "scrape_failed", message: body, text: body } };
  const title = s.metadata?.title;
  return {
    success: true,
    kind: "scraped",
    text: `${title ? `# ${title}\n` : ""}Source: ${s.finalUrl ?? url}\n\n${clip(body, maxChars(runtime))}`,
    data: { url, finalUrl: s.finalUrl ?? url, title, statusCode: s.metadata?.statusCode, via: s.via, markdown: body, ...(renderFallback ? { renderFallback: true } : {}) },
  };
}

export async function scrape(runtime: IAgentRuntime, url: string): Promise<Outcome> {
  let first: Outcome;
  try {
    first = scrapeOutcome(runtime, url, await callTool(runtime, "unbrowse.scrape", { url }), false);
    if (first.success || !RENDER_FAILURE.test(first.error?.message ?? "")) return first;
  } catch (err) {
    first = errorOutcome(err);
    if (!RENDER_FAILURE.test(first.error?.message ?? "") && first.error?.code !== "browser_capacity") return first;
  }
  // The render failed or no browser was free: read the server's HTML once without a browser. Report the original
  // failure if that does not work either.
  try {
    const retry = scrapeOutcome(runtime, url, await callTool(runtime, "unbrowse.scrape", { url, render: "never" }), true);
    return retry.success && (retry.data.markdown as string | undefined)?.trim() ? retry : first;
  } catch {
    return first;
  }
}

export async function discover(runtime: IAgentRuntime, query: string): Promise<Outcome> {
  try {
    const r = await callTool(runtime, "unbrowse.discover", { query });
    const s = (r.structuredContent ?? {}) as {
      recommended?: { id?: string; confidence?: number } | null;
      capabilities?: { id: string; title?: string; description?: string; origin?: string; inputs?: string[]; lifecycle?: string }[];
      abstained?: boolean;
    };
    const caps = s.capabilities ?? [];
    if (!caps.length) {
      return { success: true, kind: "none", text: `Unbrowse found no capability for "${query}". Give me the site's URL and I can open it in Unbrowse's cloud browser, which also teaches Unbrowse the site.`, data: { query, capabilities: [] } };
    }
    const top = caps.slice(0, 5).map((c) => `- ${c.id}${c.title ? `: ${c.title}` : ""}${c.origin ? ` (${c.origin})` : ""}${c.inputs?.length ? ` inputs: ${c.inputs.join(", ")}` : ""}`);
    const rec = s.recommended?.id ? `Recommended: ${s.recommended.id}${typeof s.recommended.confidence === "number" ? ` (confidence ${s.recommended.confidence})` : ""}\n` : "";
    return {
      success: true,
      kind: "found",
      text: `Unbrowse capabilities for "${query}":\n${rec}${top.join("\n")}`,
      data: { query, recommended: s.recommended ?? null, capabilities: caps.slice(0, 20).map(({ id, title, origin, inputs, lifecycle }) => ({ id, title, origin, inputs, lifecycle })) },
    };
  } catch (err) {
    return errorOutcome(err);
  }
}

/** Open the cloud browser on a URL with a task, read the page, then close the session (Unbrowse still learns from it). */
export async function browse(runtime: IAgentRuntime, url: string, task?: string): Promise<Outcome> {
  let sessionId: string | undefined;
  try {
    const r = await callTool(runtime, "unbrowse.browse.open", { url, ...(task ? { task } : {}) });
    const s = (r.structuredContent ?? {}) as { sessionId?: string; url?: string; title?: string; text?: string; elements?: unknown[] };
    sessionId = s.sessionId;
    if (r.isError) return { success: false, kind: "browse_failed", text: `Unbrowse's cloud browser could not open ${url}: ${clip(resultText(r), 500)}`, data: { url }, error: { code: "browse_failed", message: resultText(r), text: resultText(r) } };
    const body = s.text ?? resultText(r);
    return {
      success: true,
      kind: "browsed",
      text: `${s.title ? `# ${s.title}\n` : ""}Opened in Unbrowse's cloud browser: ${s.url ?? url}\n\n${clip(body, maxChars(runtime))}`,
      data: { url: s.url ?? url, title: s.title, sessionId, elements: Array.isArray(s.elements) ? s.elements.length : undefined, text: body },
    };
  } catch (err) {
    return errorOutcome(err);
  } finally {
    // Close so the session does not hold a browser; close still indexes the visit (passive learning).
    if (sessionId) await callTool(runtime, "unbrowse.browse.close", { sessionId }).catch(() => undefined);
  }
}

export type RunArgs = { task?: string; capability?: string; targetUrl?: string; input?: Record<string, unknown> };

export async function run(runtime: IAgentRuntime, args: RunArgs, roomId?: string, fallbackBrowse = true): Promise<Outcome> {
  let view: RunView;
  try {
    const call: Record<string, unknown> = {};
    if (args.capability) call.capability = args.capability;
    if (args.task) call.task = args.task;
    if (args.targetUrl) call.targetUrl = args.targetUrl;
    if (args.input && Object.keys(args.input).length) call.input = args.input;
    view = await settle(runtime, runView(await callTool(runtime, "unbrowse.run", call)));
  } catch (err) {
    const out = errorOutcome(err);
    if (out.error?.code !== "no_capability") return out;
    view = { status: "failed", error: { code: "no_capability", message: out.error.message } };
  }
  const out = runOutcome(runtime, view, roomId);
  if (out.kind !== "no_capability") return out;
  const next = (view.result as { next?: { url?: string } } | undefined)?.next?.url;
  const url = args.targetUrl ?? next;
  if (!url || !fallbackBrowse || setting(runtime, "UNBROWSE_BROWSE_FALLBACK") === "false") {
    return { ...out, text: `${out.text} Give me the site's URL and I can do it once in Unbrowse's cloud browser (UNBROWSE_BROWSE), which also teaches Unbrowse the site.`, data: { ...out.data, suggestion: "UNBROWSE_BROWSE" } };
  }
  const b = await browse(runtime, url, args.task);
  return {
    ...b,
    kind: b.success ? "browsed_after_no_capability" : b.kind,
    text: b.success ? `No reusable Unbrowse route fit yet, so I opened the site in Unbrowse's cloud browser (Unbrowse learns from the visit).\n${b.text}` : `${out.text} The cloud-browser fallback also failed: ${b.text}`,
    data: { ...b.data, runId: view.runId, fallbackFrom: "no_capability" },
  };
}

export async function resume(runtime: IAgentRuntime, runId: string, answers: Record<string, unknown>, roomId?: string): Promise<Outcome> {
  try {
    const view = await settle(runtime, runView(await callTool(runtime, "unbrowse.resume", { runId, answers })));
    return runOutcome(runtime, view, roomId);
  } catch (err) {
    return errorOutcome(err);
  }
}
