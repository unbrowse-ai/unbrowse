import type { BrowseSession } from "./browse-session.js";
import { isRecoverableBrowseFailure } from "./browse-session.js";
import { MONTH_INDEX } from "./browse-submit-prereqs.js";

export interface BrowseSubmitOptions {
  formSelector?: string;
  submitSelector?: string;
  waitFor?: string;
  sameOriginFetchFallback?: boolean;
  timeoutMs?: number;
}

export interface BrowseSubmitClient {
  evaluate(tabId: string, expression: string): Promise<unknown>;
  getCurrentUrl(tabId: string): Promise<string>;
  getPageHtml(tabId: string): Promise<string>;
  waitForSelector(tabId: string, selector?: string, timeoutMs?: number): Promise<{ status?: string }>;
}

export interface BrowseSubmitDeps {
  client: BrowseSubmitClient;
  session: BrowseSession;
  flushCapture?: (session: BrowseSession) => Promise<BrowseSubmitCaptureSyncResult | null>;
  restartCapture: (session: BrowseSession) => Promise<void>;
  rehydratePlugins: (tabId: string) => Promise<unknown>;
}

export interface BrowseSubmitCaptureSyncResult {
  indexed: boolean;
  mode: "http" | "dom" | "none";
  skill_id?: string | null;
  endpoint_count: number;
  request_count?: number;
  background_publish_queued?: boolean;
}

export interface BrowseSubmitResult {
  ok: boolean;
  url: string;
  mode: "dom" | "same_origin_fetch" | "noop";
  fallback_used: boolean;
  same_origin_html_rehydrated: boolean;
  recoverable?: boolean;
  reason?: string;
  status?: number;
  wait_for?: string;
  submit_meta?: Record<string, unknown> | null;
  capture_sync?: BrowseSubmitCaptureSyncResult | null;
  rehydrate?: unknown;
}

const DEFAULT_SUBMIT_TIMEOUT_MS = 8_000;
const SUBMIT_POLL_INTERVAL_MS = 250;
const SUBMIT_SETTLE_WINDOW_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function isUrlWaitHint(value?: string): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value) || value.startsWith("/");
}

export function resolveSubmitWaitHint(baseUrl: string, value?: string): string | null {
  if (!isUrlWaitHint(value)) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).href;
    } catch {
      return null;
    }
  }

  try {
    const base = new URL(baseUrl);
    const rootResolved = new URL(trimmed, base.origin);
    const rootRelativePath = rootResolved.pathname.replace(/^\/+/, "");
    const isFilenameHint = rootRelativePath.length > 0
      && !rootRelativePath.includes("/")
      && /\.[a-z0-9]+$/i.test(rootRelativePath);

    if (isFilenameHint) {
      const baseDirectory = base.pathname.endsWith("/")
        ? base.pathname
        : base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
      return new URL(`${baseDirectory}${rootRelativePath}${rootResolved.search}${rootResolved.hash}`, base.origin).href;
    }

    return rootResolved.href;
  } catch {
    return null;
  }
}

export function hasMeaningfulPageChange(beforeHtml: string, afterHtml: string): boolean {
  const before = beforeHtml.trim();
  const after = afterHtml.trim();
  if (!after) return false;
  if (!before) return after.length > 64;
  if (before === after) return false;
  if (Math.abs(before.length - after.length) > 48) return true;

  const beforeBody = before.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i)?.[1] ?? before;
  const afterBody = after.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i)?.[1] ?? after;
  return beforeBody.trim() !== afterBody.trim();
}

function buildDomSubmitExpression(options: BrowseSubmitOptions): string {
  const monthIndex = JSON.stringify(MONTH_INDEX);
  return `(function() {
    var MONTH_INDEX = ${monthIndex};
    function findForm(selector) {
      if (selector) return document.querySelector(selector);
      var active = document.activeElement;
      if (active && active.closest) {
        var fromActive = active.closest("form");
        if (fromActive) return fromActive;
      }
      return document.querySelector("form");
    }
    function findSubmitter(form, selector) {
      if (!form) return null;
      if (selector) return document.querySelector(selector);
      var active = document.activeElement;
      if (active && form.contains(active) && /^(submit|image)$/i.test(active.getAttribute("type") || "")) return active;
      return form.querySelector('button[type="submit"], input[type="submit"], input[type="image"], button:not([type])');
    }
    function isDisabled(node) {
      if (!node) return false;
      if (node.disabled) return true;
      if (typeof node.getAttribute === "function") {
        var ariaDisabled = node.getAttribute("aria-disabled");
        if (ariaDisabled && ariaDisabled.toLowerCase() === "true") return true;
      }
      return !!(node.classList && node.classList.contains("disabled"));
    }
    function textValue(node) {
      if (!node) return "";
      if (typeof node.value === "string" && node.value.trim()) return node.value.trim();
      return (node.textContent || "").trim();
    }
    function pushUnique(list, value) {
      if (!value) return;
      if (!list.includes(value)) list.push(value);
    }
    function inferIsoDate() {
      var existing = document.querySelector("[data-input-date], input[name='selectedDate']");
      var existingValue = textValue(existing);
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(existingValue)) return existingValue;

      var dayNode = document.querySelector(
        ".day.active, .day.current, .calendar-day.active, .calendar-day.selected, .calendar-day.current, [data-day].active, [data-day].current, [data-day].selected, [data-date].active, [data-date].selected, [aria-selected='true'][data-day], [aria-selected='true'][data-date], .ui-state-active"
      );
      var dayValue = dayNode
        ? (dayNode.getAttribute("data-day") || dayNode.getAttribute("data-date") || dayNode.getAttribute("data-value") || textValue(dayNode))
        : "";
      var dayMatch = dayValue.match(/\\b(\\d{1,2})\\b/);
      if (!dayMatch) return null;

      var monthNode = document.querySelector(
        "[data-calendar-title], .ui-datepicker-title, .calendar-month-year, .month-year, .datepicker-switch, .calendar-header .title"
      );
      var monthLabel = monthNode
        ? (monthNode.getAttribute("data-calendar-title") || monthNode.getAttribute("data-current-month") || textValue(monthNode))
        : "";
      var yearMatch = monthLabel.match(/\\b(\\d{4})\\b/);
      var tokens = monthLabel
        .toLowerCase()
        .replace(/[^a-z0-9\\s]+/g, " ")
        .split(/\\s+/)
        .map(function(token) { return token.trim(); })
        .filter(Boolean);
      var monthValue = null;
      for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i];
        monthValue = MONTH_INDEX[token] || MONTH_INDEX[token.slice(0, 3)];
        if (monthValue) break;
      }
      if (!monthValue || !yearMatch) return null;

      return yearMatch[1] + "-" + monthValue + "-" + String(dayMatch[1]).padStart(2, "0");
    }
    function dispatchValue(node, value) {
      if (!node) return;
      if ("value" in node) {
        node.value = value;
      } else {
        node.textContent = value;
      }
      try {
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    }
    function prepareSubmitState(submitter, selector) {
      var prereqState = { patched: [], missing: [] };
      var isoDate = inferIsoDate();
      if (isoDate) {
        Array.from(document.querySelectorAll("[data-input-date], input[name='selectedDate'], [data-summary-date], input[name='summaryDate']")).forEach(function(node) {
          var before = textValue(node);
          if (before !== isoDate) {
            dispatchValue(node, isoDate);
            pushUnique(prereqState.patched, node.matches ? node.matches("[data-input-date]") ? "[data-input-date]" : node.matches("input[name='selectedDate']") ? "input[name='selectedDate']" : node.matches("[data-summary-date]") ? "[data-summary-date]" : "input[name='summaryDate']" : "date_target");
          }
        });
      } else {
        var emptyDateInput = document.querySelector("[data-input-date], input[name='selectedDate']");
        if (emptyDateInput && !textValue(emptyDateInput)) {
          pushUnique(prereqState.missing, "selectedDate");
        }
      }

      if (!submitter) {
        pushUnique(prereqState.missing, selector || "submitter");
      } else if (isDisabled(submitter)) {
        pushUnique(prereqState.missing, selector || "[data-submit-next]:not(.disabled)");
      }

      return prereqState;
    }

    var form = findForm(${JSON.stringify(options.formSelector ?? "")});
    if (!form) {
      return JSON.stringify({ ok: false, reason: "form_not_found" });
    }

    var submitter = findSubmitter(form, ${JSON.stringify(options.submitSelector ?? "")});
    var prereqState = prepareSubmitState(submitter, ${JSON.stringify(options.submitSelector ?? null)});
    submitter = findSubmitter(form, ${JSON.stringify(options.submitSelector ?? "")});
    var meta = {
      ok: true,
      form_action: form.getAttribute("action") || "",
      form_method: (form.getAttribute("method") || "GET").toUpperCase(),
      submitter: submitter ? (submitter.getAttribute("name") || submitter.id || submitter.textContent || submitter.tagName || "").trim() : null,
      submit_selector_used: ${JSON.stringify(options.submitSelector ?? null)},
      form_selector_used: ${JSON.stringify(options.formSelector ?? null)},
      prereq_state: prereqState,
    };

    if (prereqState.missing.length > 0) {
      return JSON.stringify({ ...meta, ok: false, reason: "prereq_state_incomplete" });
    }

    if (submitter && typeof submitter.click === "function") {
      submitter.click();
      return JSON.stringify({ ...meta, submit_kind: "click" });
    }
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return JSON.stringify({ ...meta, submit_kind: "requestSubmit" });
    }
    if (typeof form.submit === "function") {
      form.submit();
      return JSON.stringify({ ...meta, submit_kind: "submit" });
    }
    return JSON.stringify({ ok: false, reason: "submit_unavailable" });
  })()`;
}

function buildSameOriginFetchExpression(options: BrowseSubmitOptions): string {
  return `(async function() {
    function splitPlugins(value) {
      return String(value || "")
        .split(/[\\s,;]+/)
        .map(function(part) { return part.trim(); })
        .filter(Boolean);
    }
    function pluginPath(name) {
      if (/^https?:\\/\\//i.test(name) || name.startsWith("/")) return name;
      return "/etc/designs/wrs/footLibs/js/plugins/" + (name.endsWith(".js") ? name : name + ".js");
    }
    async function bestEffortRehydrate() {
      var modules = Array.from(new Set(
        Array.from(document.querySelectorAll("[data-load-plugins]"))
          .flatMap(function(node) { return splitPlugins(node.getAttribute("data-load-plugins")); })
      ));
      if (modules.length === 0) {
        return { attempted: false, loaded: false, nooped: true, reason: "no_plugins", modules: [] };
      }
      if (!window.WRS || typeof window.WRS.require !== "function") {
        return { attempted: false, loaded: false, nooped: true, reason: "missing_wrs_require", modules: modules };
      }
      var requireWrs = window.WRS.require.bind(window.WRS);
      async function loadModules(paths) {
        return await new Promise(function(resolve) {
          var done = false;
          var timer = setTimeout(function() {
            if (done) return;
            done = true;
            resolve({ ok: false, reason: "timeout" });
          }, 1500);
          try {
            requireWrs(paths, function() {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve({ ok: true });
            });
          } catch (error) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ ok: false, reason: error && error.message ? error.message : String(error) });
          }
        });
      }

      var configResult = await loadModules(["/etc/designs/wrs/footLibs/js/config.js"]);
      var pluginResult = await loadModules(modules.map(pluginPath));
      for (var i = 0; i < 6; i++) {
        await new Promise(function(resolve) { return setTimeout(resolve, 100); });
      }
      return {
        attempted: true,
        loaded: !!pluginResult.ok,
        nooped: false,
        reason: pluginResult.ok ? undefined : pluginResult.reason,
        config_loaded: !!configResult.ok,
        modules: modules,
      };
    }
    function findForm(selector) {
      if (selector) return document.querySelector(selector);
      var active = document.activeElement;
      if (active && active.closest) {
        var fromActive = active.closest("form");
        if (fromActive) return fromActive;
      }
      return document.querySelector("form");
    }
    function findSubmitter(form, selector) {
      if (!form) return null;
      if (selector) return document.querySelector(selector);
      var active = document.activeElement;
      if (active && form.contains(active) && /^(submit|image)$/i.test(active.getAttribute("type") || "")) return active;
      return form.querySelector('button[type="submit"], input[type="submit"], input[type="image"], button:not([type])');
    }

    var form = findForm(${JSON.stringify(options.formSelector ?? "")});
    if (!form) return JSON.stringify({ ok: false, reason: "form_not_found" });

    var submitter = findSubmitter(form, ${JSON.stringify(options.submitSelector ?? "")});
    var method = (form.getAttribute("method") || "GET").toUpperCase();
    var action = form.getAttribute("action") || window.location.href;
    var targetUrl = new URL(action, window.location.href);
    if (targetUrl.origin !== window.location.origin) {
      return JSON.stringify({ ok: false, reason: "cross_origin", url: targetUrl.href });
    }

    var formData = new FormData(form);
    if (submitter && submitter.name) {
      var submitValue = submitter.value != null ? submitter.value : "";
      if (!formData.has(submitter.name)) formData.append(submitter.name, submitValue);
    }

    var headers = {};
    var requestUrl = targetUrl.href;
    var body;
    if (method === "GET") {
      var params = new URLSearchParams();
      Array.from(formData.entries()).forEach(function(entry) {
        var value = entry[1];
        if (typeof value === "string") params.append(entry[0], value);
      });
      var query = params.toString();
      if (query) requestUrl += (requestUrl.includes("?") ? "&" : "?") + query;
    } else if ((form.enctype || "").includes("application/x-www-form-urlencoded")) {
      var encoded = new URLSearchParams();
      Array.from(formData.entries()).forEach(function(entry) {
        var value = entry[1];
        if (typeof value === "string") encoded.append(entry[0], value);
      });
      body = encoded.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    } else {
      body = formData;
    }

    try {
      var response = await fetch(requestUrl, {
        method: method,
        body: method === "GET" ? undefined : body,
        headers: headers,
        credentials: "include",
        redirect: "follow",
      });
      var contentType = response.headers.get("content-type") || "";
      var text = await response.text();
      var finalUrl = response.url || requestUrl;
      if (!/text\\/html|application\\/xhtml\\+xml/i.test(contentType)) {
        return JSON.stringify({
          ok: false,
          reason: "non_html_response",
          status: response.status,
          url: finalUrl,
          content_type: contentType,
        });
      }

      document.open();
      document.write(text);
      document.close();
      if (finalUrl && finalUrl !== window.location.href) {
        history.replaceState({}, "", finalUrl);
      }
      await new Promise(function(resolve) { return setTimeout(resolve, 50); });
      var rehydrate = await bestEffortRehydrate();
      return JSON.stringify({
        ok: true,
        status: response.status,
        url: finalUrl,
        same_origin_html_rehydrated: true,
        rehydrate: rehydrate,
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        reason: error && error.message ? error.message : String(error),
      });
    }
  })()`;
}

function parseJsonString(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

async function settleSubmitDestination(
  client: BrowseSubmitClient,
  tabId: string,
  url: string,
  html: string,
): Promise<{ url: string; html: string }> {
  let settledUrl = url;
  let settledHtml = html;
  const deadline = Date.now() + SUBMIT_SETTLE_WINDOW_MS;

  while (Date.now() < deadline) {
    await sleep(Math.min(SUBMIT_POLL_INTERVAL_MS, Math.max(50, deadline - Date.now())));
    const nextUrl = await client.getCurrentUrl(tabId).catch(() => "");
    const nextHtml = await client.getPageHtml(tabId).catch(() => "");
    if (nextUrl && !nextUrl.startsWith("about:blank")) settledUrl = nextUrl;
    if (nextHtml) settledHtml = nextHtml;
  }

  return { url: settledUrl, html: settledHtml };
}

async function waitForSubmitOutcome(
  client: BrowseSubmitClient,
  tabId: string,
  beforeUrl: string,
  beforeHtml: string,
  options: BrowseSubmitOptions,
): Promise<{ ok: boolean; url: string; html: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const waitFor = options.waitFor?.trim();
  const requireUrlTransition = !!waitFor && isUrlWaitHint(waitFor);

  if (waitFor && !isUrlWaitHint(waitFor)) {
    try {
      const waitResult = await client.waitForSelector(tabId, waitFor, timeoutMs);
      if (waitResult?.status === "found" || waitResult?.status === "ready") {
        const url = await client.getCurrentUrl(tabId).catch(() => beforeUrl);
        const html = await client.getPageHtml(tabId).catch(() => beforeHtml);
        return { ok: true, ...await settleSubmitDestination(client, tabId, url, html) };
      }
    } catch {
      // fall through to polling
    }
  }

  while (Date.now() < deadline) {
    const url = await client.getCurrentUrl(tabId).catch(() => "");
    const html = await client.getPageHtml(tabId).catch(() => "");

    if (waitFor && isUrlWaitHint(waitFor) && url.includes(waitFor)) {
      return { ok: true, ...await settleSubmitDestination(client, tabId, url, html) };
    }
    if (url && url !== beforeUrl && !url.startsWith("about:blank")) {
      return { ok: true, ...await settleSubmitDestination(client, tabId, url, html) };
    }
    if (requireUrlTransition) {
      await sleep(SUBMIT_POLL_INTERVAL_MS);
      continue;
    }
    if (hasMeaningfulPageChange(beforeHtml, html)) {
      return { ok: true, ...await settleSubmitDestination(client, tabId, url || beforeUrl, html) };
    }

    await sleep(SUBMIT_POLL_INTERVAL_MS);
  }

  return { ok: false, url: beforeUrl, html: beforeHtml };
}

export async function submitBrowseForm(
  deps: BrowseSubmitDeps,
  options: BrowseSubmitOptions = {},
): Promise<BrowseSubmitResult> {
  const { client, session, flushCapture, restartCapture, rehydratePlugins } = deps;
  const sameOriginFetchFallback = options.sameOriginFetchFallback !== false;
  const beforeUrl = await client.getCurrentUrl(session.tabId).catch(() => session.url);
  const beforeHtml = await client.getPageHtml(session.tabId).catch(() => "");

  let submitMeta: Record<string, unknown> | null = null;
  let submitError: unknown = null;
  try {
    submitMeta = parseJsonString(await client.evaluate(session.tabId, buildDomSubmitExpression(options)));
  } catch (error) {
    submitError = error;
  }

  if (!submitMeta?.ok && submitMeta?.reason === "form_not_found") {
    return {
      ok: false,
      url: beforeUrl || session.url,
      mode: "noop",
      fallback_used: false,
      same_origin_html_rehydrated: false,
      recoverable: false,
      reason: "form_not_found",
      submit_meta: submitMeta,
    };
  }

  if (!submitMeta?.ok && submitMeta?.reason === "prereq_state_incomplete") {
    return {
      ok: false,
      url: beforeUrl || session.url,
      mode: "noop",
      fallback_used: false,
      same_origin_html_rehydrated: false,
      recoverable: false,
      reason: "prereq_state_incomplete",
      wait_for: options.waitFor,
      submit_meta: submitMeta,
    };
  }

  const domOutcome = await waitForSubmitOutcome(client, session.tabId, beforeUrl, beforeHtml, options);
  if (domOutcome.ok) {
    session.url = domOutcome.url || beforeUrl || session.url;
    return {
      ok: true,
      url: session.url,
      mode: "dom",
      fallback_used: false,
      same_origin_html_rehydrated: false,
      wait_for: options.waitFor,
      submit_meta: submitMeta,
      capture_sync: null,
    };
  }

  if (submitError && !isRecoverableBrowseFailure(submitError) && !sameOriginFetchFallback) {
    throw submitError;
  }

  if (!sameOriginFetchFallback) {
    return {
      ok: false,
      url: beforeUrl || session.url,
      mode: "noop",
      fallback_used: false,
      same_origin_html_rehydrated: false,
      recoverable: !!submitError && isRecoverableBrowseFailure(submitError),
      reason: submitError instanceof Error ? submitError.message : "submit_failed",
      submit_meta: submitMeta,
    };
  }

  const fallbackPayload = parseJsonString(await client.evaluate(session.tabId, buildSameOriginFetchExpression(options)));
  if (!fallbackPayload?.ok) {
    return {
      ok: false,
      url: String(fallbackPayload?.url ?? beforeUrl ?? session.url),
      mode: "same_origin_fetch",
      fallback_used: true,
      same_origin_html_rehydrated: false,
      recoverable: !!submitError && isRecoverableBrowseFailure(submitError),
      reason: String(fallbackPayload?.reason ?? "same_origin_fetch_failed"),
      status: typeof fallbackPayload?.status === "number" ? fallbackPayload.status as number : undefined,
      submit_meta: submitMeta,
    };
  }

  const finalUrl = String(fallbackPayload.url ?? await client.getCurrentUrl(session.tabId).catch(() => beforeUrl));
  session.url = finalUrl || beforeUrl || session.url;

  let rehydrate = fallbackPayload.rehydrate;
  if (!rehydrate) {
    rehydrate = await rehydratePlugins(session.tabId).catch(() => null);
  }

  return {
    ok: true,
    url: session.url,
    mode: "same_origin_fetch",
    fallback_used: true,
    same_origin_html_rehydrated: fallbackPayload.same_origin_html_rehydrated === true,
    status: typeof fallbackPayload.status === "number" ? fallbackPayload.status as number : undefined,
    wait_for: options.waitFor,
    submit_meta: submitMeta,
    capture_sync: null,
    rehydrate,
  };
}
