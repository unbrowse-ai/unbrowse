/**
 * Token resolver — resolves auth_tokens bindings at execute time.
 *
 * Given an endpoint with auth_tokens, extracts fresh token values from
 * the trigger page HTML/JS. Uses plain HTTP fetch first (fast, no browser
 * dependency), falls back to Kuri browser tab only when fetch fails
 * AND the remaining bindings have sources that benefit from a browser.
 */

import type { EndpointDescriptor, AuthTokenBinding, AuthTokenSource } from "../types/index.js";
import { extractTokenFromHtml, extractTokenFromBundle } from "../reverse-engineer/token-sources.js";

const FETCH_TIMEOUT_MS = 8000;

export async function resolveAuthTokens(
  endpoint: EndpointDescriptor,
  cookies: Array<{ name: string; value: string; domain: string }>,
  existingAuthHeaders: Record<string, string>,
): Promise<Record<string, string>> {
  const bindings = endpoint.auth_tokens;
  if (!bindings || bindings.length === 0) return {};

  const triggerUrl = endpoint.trigger_url;
  if (!triggerUrl) return {};

  const headerBindings = bindings.filter(
    (b) => b.param_location === "header" && !existingAuthHeaders[b.param_name],
  );
  if (headerBindings.length === 0) return {};

  const resolved: Record<string, string> = {};

  // --- Step 0: resolve cookie-kind bindings immediately (no network) ---
  for (const binding of headerBindings) {
    const cookieSources = binding.sources.filter((s) => s.kind === "cookie");
    if (cookieSources.length === 0) continue;
    for (const source of cookieSources) {
      const names = source.cookie_names ?? [];
      for (const name of names) {
        const cookie = cookies.find((c) => c.name === name);
        if (cookie?.value && cookie.value.length >= 8) {
          resolved[binding.param_name] = cookie.value;
          break;
        }
      }
      if (resolved[binding.param_name]) break;
    }
  }

  // Remaining bindings that need HTML/JS
  const remaining = headerBindings.filter((b) => !resolved[b.param_name]);
  if (remaining.length === 0) return formatHeaders(resolved);

  // Skip fetch/browser if remaining bindings have no viable sources
  if (!hasResolvableSources(remaining)) return formatHeaders(resolved);

  // --- Step 1: plain HTTP fetch (fast, no browser) ---
  const html = await fetchHtml(triggerUrl, cookies);
  if (html) {
    const fromHtml = await resolveFromHtml(remaining, html);
    Object.assign(resolved, fromHtml);
    const stillMissing = remaining.filter((b) => !resolved[b.param_name]);
    if (stillMissing.length === 0) return formatHeaders(resolved);
    // Only try browser if the missing bindings have HTML-resolvable sources
    if (Object.keys(fromHtml).length > 0 && hasHtmlResolvableSources(stillMissing)) {
      const browserHtml = await fetchHtmlViaBrowser(triggerUrl, cookies);
      if (browserHtml) {
        Object.assign(resolved, await resolveFromHtml(stillMissing, browserHtml));
      }
    }
    return formatHeaders(resolved);
  }

  // --- Step 2: Kuri browser fallback — only if remaining bindings have HTML sources ---
  if (hasHtmlResolvableSources(remaining)) {
    const browserHtml = await fetchHtmlViaBrowser(triggerUrl, cookies);
    if (browserHtml) {
      Object.assign(resolved, await resolveFromHtml(remaining, browserHtml));
    }
  }

  return formatHeaders(resolved);
}

/** Check if any binding has sources that can produce a value */
function hasResolvableSources(bindings: AuthTokenBinding[]): boolean {
  for (const b of bindings) {
    for (const s of b.sources) {
      if (s.kind === "html-meta" || s.kind === "html-inline-script") return true;
      if (s.kind === "js-bundle" && s.bundle_url_pattern && s.bundle_regex) return true;
    }
  }
  return false;
}

/** Check if any binding has sources that need full HTML (not just bundle fetches) */
function hasHtmlResolvableSources(bindings: AuthTokenBinding[]): boolean {
  for (const b of bindings) {
    for (const s of b.sources) {
      if (s.kind === "html-meta" || s.kind === "html-inline-script") return true;
    }
  }
  return false;
}

/** Add Bearer prefix for authorization headers */
function formatHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.toLowerCase() === "authorization" && !v.startsWith("Bearer ")) {
      out[k] = `Bearer ${v}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function resolveFromHtml(
  bindings: AuthTokenBinding[],
  html: string,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const binding of bindings) {
    const value = await resolveBinding(binding, html);
    if (value) resolved[binding.param_name] = value;
  }
  return resolved;
}

async function resolveBinding(binding: AuthTokenBinding, html: string): Promise<string | undefined> {
  for (const source of binding.sources) {
    let value: string | undefined;
    if (source.kind === "html-meta" || source.kind === "html-inline-script") {
      value = extractTokenFromHtml(source, html);
    } else if (source.kind === "js-bundle" && source.bundle_url_pattern && source.bundle_regex) {
      value = await resolveJsBundle(source, html);
    }
    if (value && value.length >= 8) return value;
  }
  return undefined;
}

/** Find a JS bundle URL in the HTML matching the pattern, fetch it, extract the token */
async function resolveJsBundle(source: AuthTokenSource, html: string): Promise<string | undefined> {
  const pattern = source.bundle_url_pattern!;
  const scriptSrcRe = /<script[^>]+src=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptSrcRe.exec(html)) !== null) {
    const src = match[1];
    if (!src.includes(pattern)) continue;
    try {
      const url = src.startsWith("http") ? src : `https:${src}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const bundleContent = await res.text();
      const extracted = extractTokenFromBundle(source, bundleContent);
      if (extracted && extracted.length >= 8) return extracted;
    } catch {}
  }
  return undefined;
}

// ─── Fetch strategies ─────────────────────────────────────────────────────

async function fetchHtml(
  url: string,
  cookies: Array<{ name: string; value: string; domain: string }>,
): Promise<string | null> {
  try {
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      headers: {
        "Cookie": cookieHeader,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain") && !ct.includes("application/xhtml")) return null;

    const html = await res.text();
    if (!html || html.length < 200 || !html.includes("<")) return null;
    return html;
  } catch {
    return null;
  }
}

async function fetchHtmlViaBrowser(
  url: string,
  cookies: Array<{ name: string; value: string; domain: string }>,
): Promise<string | null> {
  let kuri: typeof import("../kuri/client.js");
  try {
    kuri = await import("../kuri/client.js");
  } catch {
    return null;
  }

  let tabId: string | undefined;
  try {
    const tab = await kuri.newTab(url);
    tabId = typeof tab === "string" ? tab : (tab as { tab_id?: string })?.tab_id;
    if (!tabId) return null;

    if (cookies.length > 0) {
      for (const c of cookies) {
        await kuri.setCookie(tabId, c.name, c.value, c.domain).catch(() => {});
      }
      await kuri.navigate(tabId, url).catch(() => {});
    }

    const start = Date.now();
    while (Date.now() - start < 12000) {
      try {
        const state = await kuri.evaluate(tabId, "document.readyState");
        if (state === "complete" || state === "interactive") break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }

    const html = await kuri.getPageHtml(tabId).catch(() => "");
    if (typeof html !== "string" || !html.startsWith("<")) return null;
    return html;
  } catch {
    return null;
  } finally {
    if (tabId) await kuri.closeTab(tabId).catch(() => {});
  }
}
