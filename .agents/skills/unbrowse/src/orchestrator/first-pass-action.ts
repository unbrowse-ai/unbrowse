import * as kuri from "../kuri/client.js";
import type { KuriHarEntry } from "../kuri/client.js";
import { createHash } from "node:crypto";
import type { EndpointDescriptor, SkillManifest } from "../types/skill.js";

export type IntentClass = "search" | "navigate" | "click" | "submit" | "read" | "unknown";

export interface FirstPassResult {
  intentClass: IntentClass;
  actionTaken: string;
  hit: boolean;
  interceptedEntries: KuriHarEntry[];
  miniSkill?: SkillManifest;
  result?: unknown;
  timeMs: number;
  /** Tab ID kept alive on miss for Phase 4 agentic loop to reuse */
  tabId?: string;
}

interface FirstPassOptions {
  signal?: AbortSignal;
  clientScope?: string;
}

/** Classify an intent string into an action category. */
export function classifyIntent(intent: string): IntentClass {
  if (/\b(search|find|discover|look\s+for|browse)\b/i.test(intent)) return "search";
  if (/\b(go\s+to|open|visit|navigate)\b/i.test(intent)) return "navigate";
  if (/\b(click|tap|press|select)\b/i.test(intent)) return "click";
  if (/\b(submit|register|sign\s+up|rsvp|book|apply)\b/i.test(intent)) return "submit";
  if (/\b(read|get|fetch|show|list|view)\b/i.test(intent)) return "read";
  return "unknown";
}

/** Map an intent class to a browser action descriptor. */
export function classifyAction(
  intentClass: IntentClass,
  _url: string,
): { type: "search" | "click" | "navigate" | "wait"; selector?: string } {
  switch (intentClass) {
    case "search":
      return {
        type: "search",
        selector: "input[type=search],input[name=q],input[name=query],input[name=search]",
      };
    case "submit":
      return {
        type: "click",
        selector: "button[type=submit],input[type=submit],[role=button]",
      };
    case "click":
      return { type: "click", selector: "[role=button],button,a" };
    case "navigate":
    case "read":
    case "unknown":
    default:
      return { type: "navigate" };
  }
}

/** Filter HAR entries to only JSON API responses with 2xx status. */
function filterJsonApiEntries(entries: KuriHarEntry[]): KuriHarEntry[] {
  return entries.filter((entry) => {
    const status = entry.response?.status;
    if (!status || status < 200 || status > 299) return false;
    const ct =
      (entry.response.headers ?? []).find(
        (h) => h.name.toLowerCase() === "content-type",
      )?.value ?? "";
    return ct.includes("application/json") || ct.includes("+json");
  });
}

/** Build a lightweight skill manifest from intercepted HAR entries. */
export function synthesizeSkillFromIntercepted(
  interceptedEntries: KuriHarEntry[],
  domain: string,
  intent: string,
): SkillManifest | undefined {
  if (interceptedEntries.length === 0) return undefined;

  const hash = createHash("sha1")
    .update(interceptedEntries.map((e) => e.request.url).join("|"))
    .digest("hex")
    .slice(0, 8);

  const endpoints: EndpointDescriptor[] = interceptedEntries.map((entry, i) => {
    const parsed = new URL(entry.request.url);
    return {
      endpoint_id: `fp-ep-${i}`,
      method: entry.request.method.toUpperCase() as EndpointDescriptor["method"],
      url_template: parsed.origin + parsed.pathname,
      idempotency: "safe" as const,
      verification_status: "unverified" as const,
      reliability_score: 0.5,
      description: `First-pass intercepted endpoint for intent: ${intent}`,
    };
  });

  return {
    skill_id: `first-pass-${domain}-${hash}`,
    version: "0.0.1",
    schema_version: "2",
    name: `First-pass: ${domain}`,
    intent_signature: intent,
    domain,
    description: "Lightweight first-pass skill synthesized from intercepted network requests",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    endpoints,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Lightweight first-pass browser action: navigate to contextUrl, optionally
 * perform an intent-driven action (search / click), collect intercepted
 * JSON API requests via HAR recording, and return them for passive indexing.
 *
 * Designed to complete within ~5-8s. On any error, returns hit:false
 * and never throws.
 */
export async function tryFirstPassBrowserAction(
  intent: string,
  params: Record<string, unknown>,
  contextUrl: string,
  options?: FirstPassOptions,
): Promise<FirstPassResult> {
  const t0 = Date.now();
  const intentClass = classifyIntent(intent);
  const action = classifyAction(intentClass, contextUrl);

  let domain = "";
  try {
    domain = new URL(contextUrl).hostname;
  } catch {
    domain = "unknown";
  }

  // Hard 8s timeout for the entire operation
  const timeoutMs = 8_000;
  const deadline = t0 + timeoutMs;
  const externalSignal = options?.signal;

  function isAborted(): boolean {
    if (externalSignal?.aborted) return true;
    return Date.now() >= deadline;
  }

  async function sleepMs(ms: number): Promise<void> {
    const remaining = deadline - Date.now();
    const actual = Math.min(ms, Math.max(0, remaining));
    if (actual <= 0) return;
    return new Promise<void>((resolve) => {
      const tid = setTimeout(resolve, actual);
      if (externalSignal) {
        const cleanup = () => {
          clearTimeout(tid);
          resolve();
        };
        externalSignal.addEventListener("abort", cleanup, { once: true });
      }
    });
  }

  let tabId: string | undefined;
  let createdFreshTab = false;

  try {
    if (isAborted()) {
      return miss("aborted-before-start", intentClass, t0);
    }

    // Ensure kuri is running
    await kuri.start();
    await kuri.discoverTabs();

    if (isAborted()) {
      return miss("aborted-after-start", intentClass, t0);
    }

    // Open a fresh tab (fall back to default)
    try {
      tabId = await kuri.newTab("about:blank");
      createdFreshTab = !!tabId;
      if (!tabId) tabId = await kuri.getDefaultTab();
    } catch {
      tabId = await kuri.getDefaultTab();
    }

    if (!tabId) {
      return miss("no-tab", intentClass, t0);
    }

    if (isAborted()) {
      await cleanupTab(tabId, createdFreshTab);
      return miss("aborted-before-navigate", intentClass, t0);
    }

    // Start HAR recording before navigation to capture all requests
    await kuri.harStart(tabId);

    // Navigate to the target URL
    await kuri.navigate(tabId, contextUrl);
    await sleepMs(1_500);

    if (isAborted()) {
      await safeHarStop(tabId);
      await cleanupTab(tabId, createdFreshTab);
      return miss("aborted-after-navigate", intentClass, t0);
    }

    // Perform intent-driven action
    let actionTaken = "navigate";
    if (action.type === "search" && action.selector) {
      const searchTerm =
        typeof params.query === "string"
          ? params.query
          : typeof params.q === "string"
            ? params.q
            : intent;
      try {
        const searchResult = await kuri.evaluate(
          tabId,
          `(function(){
            var sel = ${JSON.stringify(action.selector)};
            var el = document.querySelector(sel);
            if (!el) return 'not-found';
            el.focus();
            el.value = ${JSON.stringify(searchTerm)};
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            var form = el.closest('form');
            if (form) { form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); return 'form-submit'; }
            el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',keyCode:13,bubbles:true}));
            el.dispatchEvent(new KeyboardEvent('keypress', {key:'Enter',keyCode:13,bubbles:true}));
            el.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter',keyCode:13,bubbles:true}));
            return 'search-enter';
          })()`,
        );
        actionTaken =
          typeof searchResult === "string" ? searchResult : "search-attempted";
      } catch {
        actionTaken = "search-failed";
      }
    } else if (action.type === "click" && action.selector) {
      try {
        const clickResult = await kuri.evaluate(
          tabId,
          `(function(){
            var el = document.querySelector(${JSON.stringify(action.selector)});
            if (!el) return 'not-found';
            el.click();
            return 'clicked';
          })()`,
        );
        actionTaken =
          typeof clickResult === "string" ? clickResult : "click-attempted";
      } catch {
        actionTaken = "click-failed";
      }
    }

    // Wait for network activity to settle after the action
    await sleepMs(2_000);

    if (isAborted()) {
      await safeHarStop(tabId);
      await cleanupTab(tabId, createdFreshTab);
      return miss(actionTaken, intentClass, t0);
    }

    // Stop HAR recording and collect entries
    let harEntries: KuriHarEntry[] = [];
    try {
      const harResult = await kuri.harStop(tabId);
      harEntries = harResult.entries ?? [];
    } catch {
      // non-fatal — HAR collection failed
    }

    // On hit: cleanup tab. On miss: keep tab alive for Phase 4 agentic loop.
    if (filterJsonApiEntries(harEntries).length > 0) {
      await cleanupTab(tabId, createdFreshTab);
    }

    // Filter to JSON API responses only
    const jsonEntries = filterJsonApiEntries(harEntries);
    const hit = jsonEntries.length > 0;

    let result: unknown;
    let miniSkill: SkillManifest | undefined;

    if (hit) {
      try {
        const firstEntry = jsonEntries[0];
        const text = firstEntry?.response.content?.text;
        if (text) result = JSON.parse(text);
      } catch {
        result = undefined;
      }
      miniSkill = synthesizeSkillFromIntercepted(jsonEntries, domain, intent);
    }

    return {
      hit,
      result,
      interceptedEntries: jsonEntries,
      miniSkill,
      actionTaken,
      intentClass,
      timeMs: Date.now() - t0,
      tabId: hit ? undefined : tabId,  // keep tab alive on miss
    };
  } catch (err) {
    // On any error, cleanup and return miss — never throw
    if (tabId) {
      try {
        await safeHarStop(tabId);
      } catch {
        /* ignore */
      }
      try {
        await cleanupTab(tabId, createdFreshTab);
      } catch {
        /* ignore */
      }
    }
    const isAbortError =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      hit: false,
      interceptedEntries: [],
      actionTaken: isAbortError ? "aborted" : "error",
      intentClass,
      timeMs: Date.now() - t0,
    };
  }
}

async function safeHarStop(tabId: string): Promise<void> {
  try {
    await kuri.harStop(tabId);
  } catch {
    /* best-effort */
  }
}

async function cleanupTab(tabId: string, close: boolean): Promise<void> {
  try {
    if (close) {
      await kuri.closeTab(tabId);
    } else {
      await kuri.navigate(tabId, "about:blank");
    }
  } catch {
    /* best-effort */
  }
}
