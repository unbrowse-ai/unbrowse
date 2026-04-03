import type { BrowseSession } from "./browse-session.js";
import { isRecoverableBrowseFailure } from "./browse-session.js";
import { MONTH_INDEX } from "./browse-submit-prereqs.js";

export interface BrowseSubmitOptions {
  formSelector?: string;
  submitSelector?: string;
  waitFor?: string;
  sameOriginFetchFallback?: boolean;
  timeoutMs?: number;
  assistSiteState?: boolean;
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

interface BrowseSubmitPageProbe {
  action?: string;
  step?: string;
  ticketingType?: string;
  hasActiveParkCard?: boolean;
  hasResidentGate?: boolean;
  hasQuantityControls?: boolean;
}

const DEFAULT_SUBMIT_TIMEOUT_MS = 8_000;
const SUBMIT_POLL_INTERVAL_MS = 250;
const SUBMIT_SETTLE_WINDOW_MS = 1_000;
const TRACE_SUBMIT_DEBUG = process.env.UNBROWSE_TRACE_DEBUG === "1";
const ENABLE_TRAVERSAL_FETCH_FALLBACK = process.env.UNBROWSE_ENABLE_TRAVERSAL_FETCH_FALLBACK === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function traceSubmit(event: string, payload: Record<string, unknown>): void {
  if (!TRACE_SUBMIT_DEBUG) return;
  try {
    console.log(`[browse-submit] ${event} ${JSON.stringify(payload)}`);
  } catch {
    console.log(`[browse-submit] ${event}`);
  }
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
  const normalizeVisibleText = (html: string) => html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  const beforeText = normalizeVisibleText(beforeBody);
  const afterText = normalizeVisibleText(afterBody);
  if (beforeText || afterText) return beforeText !== afterText;
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
    function dispatchCheck(node, checked) {
      if (!node) return;
      if ("checked" in node) node.checked = checked;
      try {
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        if (typeof node.click === "function") node.click();
      } catch {}
      if ("checked" in node && node.checked !== checked) node.checked = checked;
    }
    function prepareMandaiResidentGate(form, prereqState) {
      if (!form) return;
      var action = form.getAttribute("action") || "";
      var step = String(form.getAttribute("data-step") || "");
      if (!/\\/bin\\/wrs\\/ticket-selection/i.test(action) || step !== "2") return;

      var residentRadio = form.querySelector("input.booking-selection--btn[type='radio'][value='resident'], input[name='booking-selection'][value='resident']");
      var residentCheckbox = form.querySelector("#checkSingapore, input[name='isSingaporean'][type='checkbox']");
      var quantityControls = form.querySelector("[data-number-ticket], .number-ticket, .qty-ticket, input[name='quantityTicket']");
      var needsResidentGate = !!(residentRadio || residentCheckbox) && !quantityControls;
      if (!needsResidentGate) return;

      if (residentRadio && !residentRadio.checked) {
        dispatchCheck(residentRadio, true);
        pushUnique(prereqState.patched, "input[name='booking-selection'][value='resident']");
      }
      if (residentCheckbox && !residentCheckbox.checked) {
        dispatchCheck(residentCheckbox, true);
        pushUnique(prereqState.patched, "#checkSingapore");
      }

      pushUnique(prereqState.missing, "[data-number-ticket], input[name='quantityTicket']");
    }
    function findMandaiActiveParkCard(form) {
      if (!form) return null;
      var action = form.getAttribute("action") || "";
      var step = String(form.getAttribute("data-step") || "");
      var ticketingType = textValue(form.querySelector("input[name='type-ticketing']"));
      if (!/\\/bin\\/wrs\\/product-selection/i.test(action)) return null;
      if (step && step !== "1") return null;
      if (ticketingType && ticketingType !== "park") return null;
      return form.querySelector(".thumbnail-ticket-item.active");
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

      prepareMandaiResidentGate(form, prereqState);
      var parkCard = findMandaiActiveParkCard(form);
      if (form && /\\/bin\\/wrs\\/product-selection/i.test(form.getAttribute("action") || "") && !parkCard) {
        pushUnique(prereqState.missing, ".thumbnail-ticket-item.active");
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

    var parkCard = findMandaiActiveParkCard(form);
    if (parkCard && typeof parkCard.click === "function") {
      parkCard.click();
      return JSON.stringify({ ...meta, submit_kind: "park_card_click" });
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

function buildSubmitPageProbeExpression(options: BrowseSubmitOptions): string {
  return `(function() {
    function findForm(selector) {
      if (selector) return document.querySelector(selector);
      var active = document.activeElement;
      if (active && active.closest) {
        var fromActive = active.closest("form");
        if (fromActive) return fromActive;
      }
      return document.querySelector("form");
    }
    var form = findForm(${JSON.stringify(options.formSelector ?? "")});
    if (!form) return JSON.stringify({ ok: false, reason: "form_not_found" });
    var typeInput = form.querySelector("input[name='type-ticketing']");
    return JSON.stringify({
      ok: true,
      action: form.getAttribute("action") || "",
      step: String(form.getAttribute("data-step") || ""),
      ticketingType: typeInput && typeof typeInput.value === "string" ? typeInput.value : "",
      hasActiveParkCard: !!form.querySelector(".thumbnail-ticket-item.active"),
      hasResidentGate: !!form.querySelector("input[name='booking-selection'][value='resident'], #checkSingapore"),
      hasQuantityControls: !!form.querySelector("[data-number-ticket], input[name='quantityTicket']"),
    });
  })()`;
}

function buildMandaiParkSubmitExpression(options: BrowseSubmitOptions): string {
  return `(function() {
    function findForm(selector) {
      if (selector) return document.querySelector(selector);
      return document.querySelector("form");
    }
    function isDisabled(node) {
      if (!node) return false;
      return !!(node.disabled || (node.classList && node.classList.contains("disabled")) || node.getAttribute("aria-disabled") === "true");
    }
    var form = findForm(${JSON.stringify(options.formSelector ?? "")});
    if (!form) return JSON.stringify({ ok: false, reason: "form_not_found" });
    var card = form.querySelector(".thumbnail-ticket-item.active");
    var submitter = ${JSON.stringify(options.submitSelector ?? "")} ? document.querySelector(${JSON.stringify(options.submitSelector ?? "")}) : form.querySelector("[data-submit-next], .btn-proceed, button[type='submit'], input[type='submit']");
    var meta = {
      ok: true,
      form_action: form.getAttribute("action") || "",
      form_method: (form.getAttribute("method") || "GET").toUpperCase(),
      submitter: submitter ? (submitter.getAttribute("name") || submitter.id || submitter.textContent || submitter.tagName || "").trim() : ".thumbnail-ticket-item.active",
      submit_selector_used: ${JSON.stringify(options.submitSelector ?? null)},
      form_selector_used: ${JSON.stringify(options.formSelector ?? null)},
      prereq_state: { patched: [], missing: [] },
    };
    if (!card) {
      meta.ok = false;
      meta.reason = "prereq_state_incomplete";
      meta.prereq_state.missing.push(".thumbnail-ticket-item.active");
      return JSON.stringify(meta);
    }
    var cardPane = card.closest(".tab-pane");
    if (cardPane && cardPane.id) {
      Array.from(document.querySelectorAll("li[data-block-content]")).forEach(function(node) {
        node.classList.remove("active");
      });
      Array.from(document.querySelectorAll(".tab-pane")).forEach(function(node) {
        node.classList.remove("active");
      });
      var matchingTab = document.querySelector("li[data-block-content='#" + cardPane.id + "']");
      if (matchingTab) matchingTab.classList.add("active");
      cardPane.classList.add("active");
      meta.prereq_state.patched.push("#" + cardPane.id);
    }
    var input = card.querySelector("input[name='ticket']");
    if (input) {
      input.checked = true;
      input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    card.click();
    submitter = ${JSON.stringify(options.submitSelector ?? "")} ? document.querySelector(${JSON.stringify(options.submitSelector ?? "")}) : form.querySelector("[data-submit-next], .btn-proceed, button[type='submit'], input[type='submit']");
    if (submitter && !isDisabled(submitter) && typeof submitter.click === "function") {
      submitter.click();
      meta.submit_kind = "park_card_click_then_submit";
      return JSON.stringify(meta);
    }
    if (submitter && typeof submitter.click === "function") {
      setTimeout(function() {
        try {
          if (!isDisabled(submitter)) submitter.click();
        } catch {}
      }, 150);
      meta.submit_kind = "park_card_click_then_submit";
      return JSON.stringify(meta);
    }
    meta.submit_kind = "park_card_click";
    return JSON.stringify(meta);
  })()`;
}

function buildMandaiResidentGateSubmitExpression(options: BrowseSubmitOptions): string {
  return `(function() {
    function findForm(selector) {
      if (selector) return document.querySelector(selector);
      return document.querySelector("form");
    }
    function dispatch(node, checked) {
      if (!node) return;
      if ("checked" in node) node.checked = checked;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      if ("checked" in node) node.checked = checked;
    }
    function isDisabled(node) {
      if (!node) return false;
      return !!(node.disabled || (node.classList && node.classList.contains("disabled")) || node.getAttribute("aria-disabled") === "true");
    }
    var form = findForm(${JSON.stringify(options.formSelector ?? "")});
    if (!form) return JSON.stringify({ ok: false, reason: "form_not_found" });
    var submitter = ${JSON.stringify(options.submitSelector ?? "")}
      ? document.querySelector(${JSON.stringify(options.submitSelector ?? "")})
      : document.querySelector("[data-submit-next], a.btn-proceed, .btn-proceed, button[type='submit'], input[type='submit']");
    var residentRadio = form.querySelector("input.booking-selection--btn[type='radio'][value='resident'], input[name='booking-selection'][value='resident']");
    var residentCheckbox = form.querySelector("#checkSingapore, input[name='isSingaporean'][type='checkbox']");
    var patched = [];
    if (residentRadio && !residentRadio.checked) {
      dispatch(residentRadio, true);
      patched.push("input[name='booking-selection'][value='resident']");
    }
    if (residentCheckbox && !residentCheckbox.checked) {
      dispatch(residentCheckbox, true);
      patched.push("#checkSingapore");
    }
    var quantityControls = form.querySelector("[data-number-ticket], input[name='quantityTicket']");
    var meta = {
      ok: true,
      form_action: form.getAttribute("action") || "",
      form_method: (form.getAttribute("method") || "GET").toUpperCase(),
      submitter: submitter ? (submitter.getAttribute("name") || submitter.id || submitter.textContent || submitter.tagName || "").trim() : null,
      submit_selector_used: ${JSON.stringify(options.submitSelector ?? null)},
      form_selector_used: ${JSON.stringify(options.formSelector ?? null)},
      prereq_state: { patched: patched, missing: [] },
    };
    if (!quantityControls) {
      meta.ok = false;
      meta.reason = "prereq_state_incomplete";
      meta.prereq_state.missing.push("[data-number-ticket], input[name='quantityTicket']");
      return JSON.stringify(meta);
    }
    if (!submitter) {
      form.submit();
      meta.submit_kind = "native_submit";
      return JSON.stringify(meta);
    }
    if (isDisabled(submitter)) {
      form.submit();
      meta.submit_kind = "native_submit";
      return JSON.stringify(meta);
    }
    submitter.click();
    meta.submit_kind = "click";
    return JSON.stringify(meta);
  })()`;
}

function buildMandaiTicketQuantitySubmitExpression(options: BrowseSubmitOptions): string {
  return `(function() {
    function findForm(selector) {
      if (selector) return document.querySelector(selector);
      return document.querySelector("form");
    }
    function dispatch(node, checked) {
      if (!node) return;
      if ("checked" in node) node.checked = checked;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      if ("checked" in node) node.checked = checked;
    }
    function isDisabled(node) {
      if (!node) return false;
      return !!(node.disabled || (node.classList && node.classList.contains("disabled")) || node.getAttribute("aria-disabled") === "true");
    }
    function isLocalResidentQuantity(node) {
      if (!node) return false;
      var name = (node.getAttribute("name") || "").toLowerCase();
      if (name.includes("_local_")) return true;
      var residentsOnly = node.closest(".residents-only, [data-residents-only='true']");
      return !!residentsOnly;
    }
    function setQuantity(node, value) {
      if (!node) return;
      node.disabled = false;
      node.removeAttribute("disabled");
      node.value = String(value);
      node.setAttribute("data-number-ticket", String(value));
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
    var form = findForm(${JSON.stringify(options.formSelector ?? "")});
    if (!form) return JSON.stringify({ ok: false, reason: "form_not_found" });
    var residentRadio = form.querySelector("input.booking-selection--btn[type='radio'][value='resident'], input[name='booking-selection'][value='resident']");
    var residentCheckbox = form.querySelector("#checkSingapore, input[name='isSingaporean'][type='checkbox']");
    var patched = [];
    if (residentRadio && !residentRadio.checked) {
      dispatch(residentRadio, true);
      patched.push("input[name='booking-selection'][value='resident']");
    }
    if (residentCheckbox && !residentCheckbox.checked) {
      dispatch(residentCheckbox, true);
      patched.push("#checkSingapore");
    }
    var submitter = ${JSON.stringify(options.submitSelector ?? "")}
      ? document.querySelector(${JSON.stringify(options.submitSelector ?? "")})
      : document.querySelector("[data-submit-next], a.btn-proceed, .btn-proceed, button[type='submit'], input[type='submit']");
    var quantities = Array.from(form.querySelectorAll("[data-number-ticket], input[name='quantityTicket']"));
    var residentQuantities = quantities.filter(function(node) {
      return isLocalResidentQuantity(node);
    });
    var residentPositives = residentQuantities.filter(function(node) {
      return Number.parseInt(node.value || "0", 10) > 0;
    });
    if (residentPositives.length > 0) {
      residentPositives.forEach(function(node) {
        if (node.disabled || !node.getAttribute("data-number-ticket")) {
          setQuantity(node, Number.parseInt(node.value || "0", 10));
          if (node.id) patched.push("#" + node.id);
        }
      });
    }
    var positives = quantities.filter(function(node) {
      return Number.parseInt(node.value || "0", 10) > 0;
    });
    var meta = {
      ok: true,
      form_action: form.getAttribute("action") || "",
      form_method: (form.getAttribute("method") || "GET").toUpperCase(),
      submitter: submitter ? (submitter.getAttribute("name") || submitter.id || submitter.textContent || submitter.tagName || "").trim() : null,
      submit_selector_used: ${JSON.stringify(options.submitSelector ?? null)},
      form_selector_used: ${JSON.stringify(options.formSelector ?? null)},
      prereq_state: { patched: patched, missing: [] },
    };
    if (positives.length === 0) {
      meta.ok = false;
      meta.reason = "prereq_state_incomplete";
      meta.prereq_state.missing.push("[data-number-ticket]>0");
      return JSON.stringify(meta);
    }
    if (!submitter) {
      form.submit();
      meta.submit_kind = "native_submit";
      return JSON.stringify(meta);
    }
    if (isDisabled(submitter)) {
      form.submit();
      meta.submit_kind = "native_submit";
      return JSON.stringify(meta);
    }
    submitter.click();
    meta.submit_kind = "click";
    return JSON.stringify(meta);
  })()`;
}

function buildMandaiDateSubmitExpression(options: BrowseSubmitOptions): string {
  return `(function() {
    function findForm(selector) {
      if (selector) return document.querySelector(selector);
      return document.querySelector("form");
    }
    function isDisabled(node) {
      if (!node) return false;
      return !!(node.disabled || (node.classList && node.classList.contains("disabled")) || node.getAttribute("aria-disabled") === "true");
    }
    var form = findForm(${JSON.stringify(options.formSelector ?? "")});
    if (!form) return JSON.stringify({ ok: false, reason: "form_not_found" });
    var submitter = ${JSON.stringify(options.submitSelector ?? "")}
      ? document.querySelector(${JSON.stringify(options.submitSelector ?? "")})
      : document.querySelector("[data-submit-next], a.btn-proceed, .btn-proceed, button[type='submit'], input[type='submit']");
    var selectedDateCandidates = Array.from(document.querySelectorAll("input[name='selectedDate'], [data-input-date]"));
    var summaryDateCandidates = Array.from(document.querySelectorAll("[data-summary-date], input[name='summaryDate']"));
    var selectedDate = selectedDateCandidates.find(function(node) {
      return typeof node.value === "string" && node.value.trim().length > 0;
    }) || selectedDateCandidates[0] || null;
    var summaryDate = summaryDateCandidates.find(function(node) {
      return typeof node.value === "string" && node.value.trim().length > 0;
    }) || summaryDateCandidates[0] || null;
    var selectedValue = selectedDate && typeof selectedDate.value === "string" ? selectedDate.value.trim() : "";
    var summaryValue = summaryDate && typeof summaryDate.value === "string" ? summaryDate.value.trim() : "";
    var patched = [];
    var meta = {
      ok: true,
      form_action: form.getAttribute("action") || "",
      form_method: (form.getAttribute("method") || "GET").toUpperCase(),
      submitter: submitter ? (submitter.getAttribute("name") || submitter.id || submitter.textContent || submitter.tagName || "").trim() : null,
      submit_selector_used: ${JSON.stringify(options.submitSelector ?? null)},
      form_selector_used: ${JSON.stringify(options.formSelector ?? null)},
      prereq_state: { patched: patched, missing: [] },
    };
    if (!selectedValue && summaryValue && selectedDate && "value" in selectedDate) {
      selectedDate.value = summaryValue;
      selectedDate.dispatchEvent(new Event("input", { bubbles: true }));
      selectedDate.dispatchEvent(new Event("change", { bubbles: true }));
      selectedValue = summaryValue;
      patched.push("input[name='selectedDate']");
    }
    if (!selectedValue) {
      meta.ok = false;
      meta.reason = "prereq_state_incomplete";
      meta.prereq_state.missing.push("selectedDate");
      return JSON.stringify(meta);
    }
    if (!submitter) {
      form.submit();
      meta.submit_kind = "native_submit";
      return JSON.stringify(meta);
    }
    if (isDisabled(submitter)) {
      form.submit();
      meta.submit_kind = "native_submit";
      return JSON.stringify(meta);
    }
    submitter.click();
    meta.submit_kind = "click";
    return JSON.stringify(meta);
  })()`;
}

function buildMandaiAddonSubmitExpression(options: BrowseSubmitOptions): string {
  return `(function() {
    function findForm(selector) {
      if (selector) return document.querySelector(selector);
      return document.querySelector("form");
    }
    function isDisabled(node) {
      if (!node) return false;
      return !!(node.disabled || (node.classList && node.classList.contains("disabled")) || node.getAttribute("aria-disabled") === "true");
    }
    var form = findForm(${JSON.stringify(options.formSelector ?? "")});
    if (!form) return JSON.stringify({ ok: false, reason: "form_not_found" });
    var submitter = ${JSON.stringify(options.submitSelector ?? "")} ? document.querySelector(${JSON.stringify(options.submitSelector ?? "")}) : form.querySelector("[data-submit-next], .btn-proceed, button[type='submit'], input[type='submit']");
    var meta = {
      ok: true,
      form_action: form.getAttribute("action") || "",
      form_method: (form.getAttribute("method") || "GET").toUpperCase(),
      submitter: submitter ? (submitter.getAttribute("name") || submitter.id || submitter.textContent || submitter.tagName || "").trim() : null,
      submit_selector_used: ${JSON.stringify(options.submitSelector ?? null)},
      form_selector_used: ${JSON.stringify(options.formSelector ?? null)},
      prereq_state: { patched: [], missing: [] },
    };
    if (!submitter || isDisabled(submitter)) {
      meta.ok = false;
      meta.reason = "prereq_state_incomplete";
      meta.prereq_state.missing.push(${JSON.stringify(options.submitSelector ?? "[data-submit-next]:not(.disabled)")});
      return JSON.stringify(meta);
    }
    submitter.click();
    meta.submit_kind = "click";
    return JSON.stringify(meta);
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
  options: { preferUrlOnly?: boolean } = {},
): Promise<{ url: string; html: string }> {
  let settledUrl = url;
  let settledHtml = html;
  const deadline = Date.now() + SUBMIT_SETTLE_WINDOW_MS;

  while (Date.now() < deadline) {
    await sleep(Math.min(SUBMIT_POLL_INTERVAL_MS, Math.max(50, deadline - Date.now())));
    const nextUrl = await client.getCurrentUrl(tabId).catch(() => "");
    if (nextUrl && !nextUrl.startsWith("about:blank")) settledUrl = nextUrl;
    if (!options.preferUrlOnly) {
      const nextHtml = await client.getPageHtml(tabId).catch(() => "");
      if (nextHtml) settledHtml = nextHtml;
    }
  }

  if (options.preferUrlOnly) {
    const finalHtml = await client.getPageHtml(tabId).catch(() => "");
    if (finalHtml) settledHtml = finalHtml;
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
  let lastHtml = beforeHtml;
  let lastHtmlPollAt = 0;

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

    if (waitFor && isUrlWaitHint(waitFor) && url.includes(waitFor)) {
      return {
        ok: true,
        ...await settleSubmitDestination(client, tabId, url, lastHtml, { preferUrlOnly: true }),
      };
    }
    if (url && url !== beforeUrl && !url.startsWith("about:blank")) {
      return {
        ok: true,
        ...await settleSubmitDestination(client, tabId, url, lastHtml, { preferUrlOnly: requireUrlTransition }),
      };
    }
    if (requireUrlTransition) {
      await sleep(SUBMIT_POLL_INTERVAL_MS);
      continue;
    }
    const now = Date.now();
    let html = lastHtml;
    if (now - lastHtmlPollAt >= SUBMIT_POLL_INTERVAL_MS * 2) {
      const nextHtml = await client.getPageHtml(tabId).catch(() => "");
      if (nextHtml) html = nextHtml;
      lastHtml = html;
      lastHtmlPollAt = now;
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
  const sameOriginFetchFallback = options.sameOriginFetchFallback ?? ENABLE_TRAVERSAL_FETCH_FALLBACK;
  const beforeUrl = await client.getCurrentUrl(session.tabId).catch(() => session.url);
  const beforeHtml = await client.getPageHtml(session.tabId).catch(() => "");
  let pageProbe: BrowseSubmitPageProbe | null = null;
  try {
    pageProbe = parseJsonString(await client.evaluate(session.tabId, buildSubmitPageProbeExpression(options))) as BrowseSubmitPageProbe | null;
  } catch {
    pageProbe = null;
  }

  let domExpression = buildDomSubmitExpression(options);
  if (options.assistSiteState) {
    if (pageProbe?.action && /\/bin\/wrs\/product-selection/i.test(pageProbe.action) && pageProbe.ticketingType === "park") {
      domExpression = buildMandaiParkSubmitExpression(options);
    } else if (
      pageProbe?.action
      && /\/bin\/wrs\/datestep\.json/i.test(pageProbe.action)
      && pageProbe.step === "3"
    ) {
      domExpression = buildMandaiDateSubmitExpression(options);
    } else if (
      pageProbe?.action
      && /\/bin\/wrs\/addon-selection/i.test(pageProbe.action)
      && pageProbe.step === "5"
    ) {
      domExpression = buildMandaiAddonSubmitExpression(options);
    } else if (
      pageProbe?.action
      && /\/bin\/wrs\/ticket-selection/i.test(pageProbe.action)
      && pageProbe.step === "2"
      && pageProbe.hasQuantityControls
    ) {
      domExpression = buildMandaiTicketQuantitySubmitExpression(options);
    } else if (
      pageProbe?.action
      && /\/bin\/wrs\/ticket-selection/i.test(pageProbe.action)
      && pageProbe.step === "2"
      && pageProbe.hasResidentGate
      && !pageProbe.hasQuantityControls
    ) {
      domExpression = buildMandaiResidentGateSubmitExpression(options);
    }
  }
  traceSubmit("page-probe", {
    before_url: beforeUrl || session.url,
    page_probe: pageProbe,
  });

  let submitMeta: Record<string, unknown> | null = null;
  let submitError: unknown = null;
  let submitMetaRaw: unknown = null;
  try {
    submitMetaRaw = await client.evaluate(session.tabId, domExpression);
    submitMeta = parseJsonString(submitMetaRaw);
  } catch (error) {
    submitError = error;
  }
  traceSubmit("dom-meta", {
    before_url: beforeUrl || session.url,
    submit_meta: submitMeta,
    submit_meta_raw_type: submitMetaRaw === null ? "null" : typeof submitMetaRaw,
    submit_meta_raw_preview: typeof submitMetaRaw === "string" && !submitMeta
      ? submitMetaRaw.slice(0, 240)
      : undefined,
    submit_error: submitError instanceof Error ? submitError.message : String(submitError ?? ""),
  });

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
  traceSubmit("dom-outcome", {
    before_url: beforeUrl || session.url,
    dom_ok: domOutcome.ok,
    dom_url: domOutcome.url,
    wait_for: options.waitFor ?? null,
  });
  if (domOutcome.ok) {
    const sameUrl = (domOutcome.url || beforeUrl || session.url) === (beforeUrl || session.url);
    if (submitMeta == null && sameUrl) {
      // Unknown submit state + no navigation usually means hidden DOM churn, not a real step transition.
    } else {
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

  let fallbackPayload: Record<string, unknown> | null = null;
  let fallbackError: unknown = null;
  try {
    fallbackPayload = parseJsonString(await client.evaluate(session.tabId, buildSameOriginFetchExpression(options)));
  } catch (error) {
    fallbackError = error;
  }
  traceSubmit("fallback", {
    before_url: beforeUrl || session.url,
    fallback_payload: fallbackPayload,
    fallback_error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError ?? ""),
  });
  if (fallbackError) {
    return {
      ok: false,
      url: beforeUrl || session.url,
      mode: "same_origin_fetch",
      fallback_used: true,
      same_origin_html_rehydrated: false,
      recoverable: isRecoverableBrowseFailure(fallbackError),
      reason: fallbackError instanceof Error ? fallbackError.message : "same_origin_fetch_failed",
      submit_meta: submitMeta,
    };
  }
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
