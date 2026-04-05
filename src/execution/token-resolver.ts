/**
 * Token resolver — resolves auth_tokens bindings at execute time.
 *
 * Given an endpoint with auth_tokens, loads the trigger page via Kuri,
 * extracts fresh token values from HTML/JS sources, and returns headers
 * ready to inject into the outgoing request.
 *
 * This closes the gap for sites that rotate CSRF tokens per page-load,
 * keep bearer tokens in JS bundles, or hydrate tokens into inline scripts.
 */

import type { EndpointDescriptor, AuthTokenBinding } from "../types/index.js";
import { extractTokenFromHtml, extractTokenFromBundle } from "../reverse-engineer/token-sources.js";
import * as kuri from "../kuri/client.js";

const RESOLVE_TIMEOUT_MS = 12000;

/**
 * Resolve auth_tokens bindings by loading the trigger page and scraping
 * token values from their known source locations.
 *
 * Returns a map of header-name → resolved-value for all successfully
 * resolved header-type bindings. Returns empty map if no bindings or
 * all fail.
 */
export async function resolveAuthTokens(
  endpoint: EndpointDescriptor,
  cookies: Array<{ name: string; value: string; domain: string }>,
  existingAuthHeaders: Record<string, string>,
): Promise<Record<string, string>> {
  const bindings = endpoint.auth_tokens;
  if (!bindings || bindings.length === 0) return {};

  const triggerUrl = endpoint.trigger_url;
  if (!triggerUrl) return {};

  // Resolve ALL header bindings — DAG sources are authoritative over vault cache
  const headerBindings = bindings.filter((b) => b.param_location === "header");
  if (headerBindings.length === 0) return {};

  const resolved: Record<string, string> = {};

  try {
    // Open a tab, inject cookies, navigate to trigger page
    const tabId = await openResolverTab(triggerUrl, cookies);
    if (!tabId) return {};

    try {
      await waitForLoad(tabId);

      const html = await kuri.getPageHtml(tabId).catch(() => "");
      if (typeof html !== "string" || !html.startsWith("<")) {
        return {};
      }

      for (const binding of headerBindings) {
        const value = await resolveBinding(binding, html, cookies);
        if (value) {
          resolved[binding.param_name] = binding.param_name.toLowerCase() === "authorization"
            ? (value.startsWith("Bearer ") ? value : `Bearer ${value}`)
            : value;
        }
      }
    } finally {
      await kuri.closeTab(tabId).catch(() => {});
    }
  } catch {
    // Tab open/nav failed — return whatever we resolved so far
  }

  return resolved;
}

async function resolveBinding(
  binding: AuthTokenBinding,
  html: string,
  cookies: Array<{ name: string; value: string; domain: string }>,
): Promise<string | undefined> {
  for (const source of binding.sources) {
    let value: string | undefined;

    if (source.kind === "cookie" && source.cookie_names?.length) {
      // Resolve from cookies — CSRF tokens typically live here
      for (const name of source.cookie_names) {
        const cookie = cookies.find((c) => c.name === name);
        if (cookie?.value) { value = cookie.value; break; }
      }
    } else if (source.kind === "html-meta" || source.kind === "html-inline-script") {
      value = extractTokenFromHtml(source, html);
    } else if (source.kind === "js-bundle" && source.bundle_url_pattern) {
      try {
        const resp = await fetch(source.bundle_url_pattern);
        if (resp.ok) {
          const body = await resp.text();
          value = extractTokenFromBundle(source, body);
        }
      } catch { /* fetch failed — try next source */ }
    }

    if (value && value.length >= 8) return value;
  }
  return undefined;
}
async function openResolverTab(
  url: string,
  cookies: Array<{ name: string; value: string; domain: string }>,
): Promise<string | undefined> {
  try {
    const tab = await kuri.newTab(url);
    const tabId = typeof tab === "string" ? tab : (tab as { tab_id?: string })?.tab_id;
    if (!tabId) return undefined;

    if (cookies.length > 0) {
      for (const c of cookies) {
        await kuri.setCookie(tabId, c.name, c.value, c.domain).catch(() => {});
      }
      await kuri.navigate(tabId, url).catch(() => {});
    }

    return tabId;
  } catch {
    return undefined;
  }
}

async function waitForLoad(tabId: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < RESOLVE_TIMEOUT_MS) {
    try {
      const state = await kuri.evaluate(tabId, "document.readyState");
      if (state === "complete" || state === "interactive") return;
    } catch { /* page not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}
