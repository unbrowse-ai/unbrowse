/**
 * Token source discovery - finds where a captured token value lives in HTML / JS
 * so the value can be re-scraped fresh at replay time.
 *
 * Input:  a concrete token value we saw in a captured request header
 * Output: an ordered list of AuthTokenSource locators (meta tag, inline script regex,
 *         or JS bundle regex) that will re-produce the same value when re-evaluated
 *
 * The resolver (src/execution/token-resolver.ts) walks these sources in order at
 * replay time and injects the freshest value into the outgoing request. This closes
 * the gap for sites that rotate CSRF tokens per page-load, keep bearer tokens in JS
 * bundles (Twitter public API), or hydrate tokens into window.__INITIAL_STATE__.
 */

import type { AuthTokenSource } from "../types/index.js";

// Minimum token length to consider - below this, false-positive matches dominate
// (common 8-char hex substrings appear in every page).
const MIN_TOKEN_LENGTH = 16;

// Maximum sources to return per token - higher values make resolution slower
// without meaningfully improving robustness.
const MAX_SOURCES = 5;

/**
 * Find all deterministic locators that currently produce the given token value
 * from the supplied HTML and JS bundle contents. The locators are captured in a
 * form that allows re-evaluation at replay time against freshly-fetched page
 * state - if the site rotates the token each page-load, the same locator will
 * return the new value.
 */
export function findTokenSources(
  tokenValue: string,
  html: string | undefined,
  jsBundles?: Map<string, string>,
): AuthTokenSource[] {
  if (!tokenValue || tokenValue.length < MIN_TOKEN_LENGTH) return [];

  const sources: AuthTokenSource[] = [];

  if (html) {
    sources.push(...findHtmlMetaSources(tokenValue, html));
    sources.push(...findInlineScriptSources(tokenValue, html));
  }

  if (jsBundles && jsBundles.size > 0) {
    sources.push(...findJsBundleSources(tokenValue, jsBundles));
  }

  // Dedupe and cap
  const seen = new Set<string>();
  const out: AuthTokenSource[] = [];
  for (const src of sources) {
    const key = JSON.stringify(src);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

// HTML <meta> scanner
// Matches patterns like:
//   <meta name="csrf-token" content="ABC123...">
//   <meta name="csrfToken" value="ABC123..." />
//   <meta property="csrf" content="ABC123...">

const META_TAG_PATTERN = /<meta\s+([^>]+?)\s*\/?>/gi;

function findHtmlMetaSources(tokenValue: string, html: string): AuthTokenSource[] {
  const out: AuthTokenSource[] = [];
  META_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = META_TAG_PATTERN.exec(html)) !== null) {
    const attrs = match[1];
    if (!attrs.includes(tokenValue)) continue;

    const name =
      extractAttr(attrs, "name") ??
      extractAttr(attrs, "property") ??
      extractAttr(attrs, "itemprop");
    if (!name) continue;

    for (const attrName of ["content", "value"] as const) {
      const attrValue = extractAttr(attrs, attrName);
      if (attrValue === tokenValue) {
        out.push({
          kind: "html-meta",
          meta_name: name,
          meta_attr: attrName,
        });
        break;
      }
    }
  }
  return out;
}

function extractAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrs.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

// Inline <script> scanner

const INLINE_SCRIPT_PATTERN = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
const CONTEXT_WINDOW = 48;

function findInlineScriptSources(tokenValue: string, html: string): AuthTokenSource[] {
  const out: AuthTokenSource[] = [];
  INLINE_SCRIPT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_SCRIPT_PATTERN.exec(html)) !== null) {
    const scriptBody = match[1];
    const idx = scriptBody.indexOf(tokenValue);
    if (idx < 0) continue;

    const regex = buildContextRegex(scriptBody, idx, tokenValue);
    if (!regex) continue;

    out.push({
      kind: "html-inline-script",
      inline_script_regex: regex,
    });
  }
  return out;
}

// JS bundle scanner

function findJsBundleSources(
  tokenValue: string,
  bundles: Map<string, string>,
): AuthTokenSource[] {
  const out: AuthTokenSource[] = [];
  for (const [bundleUrl, content] of bundles) {
    const idx = content.indexOf(tokenValue);
    if (idx < 0) continue;

    const regex = buildContextRegex(content, idx, tokenValue);
    if (!regex) continue;

    out.push({
      kind: "js-bundle",
      bundle_url_pattern: bundleUrlPattern(bundleUrl),
      bundle_regex: regex,
    });
  }
  return out;
}

function bundleUrlPattern(bundleUrl: string): string {
  try {
    const u = new URL(bundleUrl);
    const path = u.pathname.replace(/[.-][a-f0-9]{6,}\./, ".");
    return path.replace(/\.(m?js)$/i, "");
  } catch {
    return bundleUrl.replace(/[.-][a-f0-9]{6,}\./, ".").replace(/\.(m?js)$/i, "");
  }
}

// Context regex builder

function buildContextRegex(
  content: string,
  tokenIdx: number,
  tokenValue: string,
): string | null {
  const start = Math.max(0, tokenIdx - CONTEXT_WINDOW);
  let context = content.slice(start, tokenIdx);

  const delimMatch = context.match(/([{,\[(]\s*["'`]?[\w$-]+\s*["'`]?\s*[:=]\s*["'`])[^{,\[(]*$/);
  if (delimMatch) {
    context = delimMatch[1];
  } else {
    context = context.trimStart();
    if (context.length < 6) return null;
  }

  const afterIdx = tokenIdx + tokenValue.length;
  const terminator = content.charAt(afterIdx);

  let terminatorPattern: string;
  if (terminator === '"') terminatorPattern = '"';
  else if (terminator === "'") terminatorPattern = "'";
  else if (terminator === "`") terminatorPattern = "`";
  else if (terminator === "," || terminator === "}" || terminator === "]" || terminator === ")") {
    terminatorPattern = `[${escapeRegExp(terminator)}]`;
  } else {
    return null;
  }

  const tokenCharset = inferTokenCharset(tokenValue);
  return `${escapeRegExp(context)}(${tokenCharset}+?)(?=${terminatorPattern})`;
}

function inferTokenCharset(tokenValue: string): string {
  if (/^[A-Za-z0-9+/=]+$/.test(tokenValue)) return "[A-Za-z0-9+/=]";
  if (/^[A-Za-z0-9._-]+$/.test(tokenValue)) return "[A-Za-z0-9._-]";
  if (/^[A-Fa-f0-9]+$/.test(tokenValue)) return "[A-Fa-f0-9]";
  if (/^[A-Za-z0-9]+$/.test(tokenValue)) return "[A-Za-z0-9]";
  return "[^\"'`,}\\]\\s)]";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolver-side helpers

export function extractTokenFromHtml(
  source: AuthTokenSource,
  html: string,
): string | undefined {
  if (source.kind === "html-meta" && source.meta_name) {
    const attr = source.meta_attr ?? "content";
    const re = new RegExp(
      `<meta\\s+[^>]*?(?:name|property|itemprop)\\s*=\\s*["']${escapeRegExp(source.meta_name)}["'][^>]*?${attr}\\s*=\\s*["']([^"']+)["'][^>]*>`,
      "i",
    );
    const m = html.match(re);
    if (m) return m[1];
    const re2 = new RegExp(
      `<meta\\s+[^>]*?${attr}\\s*=\\s*["']([^"']+)["'][^>]*?(?:name|property|itemprop)\\s*=\\s*["']${escapeRegExp(source.meta_name)}["'][^>]*>`,
      "i",
    );
    const m2 = html.match(re2);
    if (m2) return m2[1];
    return undefined;
  }

  if (source.kind === "html-inline-script" && source.inline_script_regex) {
    const scriptPattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    const inner = new RegExp(source.inline_script_regex);
    let m: RegExpExecArray | null;
    scriptPattern.lastIndex = 0;
    while ((m = scriptPattern.exec(html)) !== null) {
      const hit = m[1].match(inner);
      if (hit && hit[1]) return hit[1];
    }
    return undefined;
  }

  return undefined;
}

export function extractTokenFromBundle(
  source: AuthTokenSource,
  bundleContent: string,
): string | undefined {
  if (source.kind !== "js-bundle" || !source.bundle_regex) return undefined;
  const m = bundleContent.match(new RegExp(source.bundle_regex));
  return m?.[1];
}

// ─── Endpoint enrichment ──────────────────────────────────────────────────
//
// Walks captured requests, extracts auth-sensitive headers, runs findTokenSources
// for each, and attaches matching TokenBindings to the corresponding endpoints.
//
// This is the capture-side glue that wires HTML/JS token discovery into the DAG.

import type { EndpointDescriptor, AuthTokenBinding, AuthTokenSource as _TS } from "../types/index.js";

/** Header names that commonly carry site-computed tokens worth scanning for.
 *  Bearer auth, CSRF tokens, and transaction IDs are the prime targets. */
const TOKEN_HEADER_PATTERN =
  /^(authorization|x-csrf-token|x-xsrf-token|x-csrftoken|csrf-token|x-api-key|x-auth-token|x-access-token|x-session-token|x-shopify-storefront-access-token|x-twitter-auth-type|x-client-transaction-id|x-requested-with|x-client-version)$/i;

interface MinimalRequest {
  url: string;
  method: string;
  request_headers: Record<string, string>;
}

/**
 * For each captured request that uses a token-bearing header, find that token's
 * source locations in the captured HTML / JS bundles and attach AuthTokenBinding
 * entries to the endpoint that matches the request URL + method.
 *
 * Runs in-place: mutates endpoint.auth_tokens.
 */
export function enrichEndpointsWithTokenSources(
  endpoints: EndpointDescriptor[],
  requests: MinimalRequest[],
  html: string | undefined,
  jsBundles: Map<string, string> | undefined,
): number {
  let enriched = 0;
  for (const req of requests) {
    const matching = endpoints.filter((ep) => endpointMatchesRequest(ep, req));
    if (matching.length === 0) continue;

    for (const [headerName, headerValue] of Object.entries(req.request_headers)) {
      if (!TOKEN_HEADER_PATTERN.test(headerName)) continue;
      const tokenValue = extractTokenValue(headerName, headerValue);
      if (!tokenValue) continue;

      const sources = (html || (jsBundles && jsBundles.size > 0))
        ? findTokenSources(tokenValue, html, jsBundles)
        : [];

      const lowerName = headerName.toLowerCase();
      if (sources.length === 0) {
        if (/csrf|xsrf/i.test(lowerName)) {
          sources.push({ kind: "cookie", cookie_names: ["ct0", "csrf_token", "_csrf", "csrftoken", "XSRF-TOKEN"] });
        } else if (lowerName === "authorization") {
          if (html) {
            const scriptSrcRe = /<script[^>]+src=["']([^"']+\.js[^"']*?)["']/gi;
            let m: RegExpExecArray | null;
            while ((m = scriptSrcRe.exec(html)) !== null) {
              if (/main|app|client|bundle|vendor/i.test(m[1])) {
                sources.push({ kind: "js-bundle", bundle_url_pattern: m[1] });
                if (sources.length >= 3) break;
              }
            }
          }
        }
      }

      if (sources.length === 0) continue;

      const binding: AuthTokenBinding = {
        param_name: lowerName,
        param_location: "header",
        sources,
        refresh_on_401: true,
      };

      for (const ep of matching) {
        if (!ep.auth_tokens) ep.auth_tokens = [];
        // Always replace with fresh binding — stale sources from cached merges get overwritten
        const idx = ep.auth_tokens.findIndex((b) => b.param_name === binding.param_name);
        if (idx >= 0) {
          ep.auth_tokens[idx] = binding;
        } else {
          ep.auth_tokens.push(binding);
        }
        enriched++;
      }
    }
  }
  return enriched;
}

/** For Authorization: Bearer XYZ → returns "XYZ". For plain headers → returns value as-is. */
function extractTokenValue(headerName: string, headerValue: string): string | null {
  if (!headerValue) return null;
  if (headerName.toLowerCase() === "authorization") {
    const parts = headerValue.split(/\s+/, 2);
    if (parts.length === 2 && /^(bearer|token)$/i.test(parts[0])) return parts[1];
    return headerValue;
  }
  return headerValue;
}

/** Loose match: compare hostname + path prefix of the captured request against the endpoint's url_template. */
function endpointMatchesRequest(ep: EndpointDescriptor, req: MinimalRequest): boolean {
  if (ep.method !== req.method) return false;
  try {
    const reqUrl = new URL(req.url);
    const tplUrl = new URL(ep.url_template.replace(/\{[^}]+\}/g, "x"));
    if (reqUrl.hostname !== tplUrl.hostname) return false;
    // Compare path segment counts + non-template segments
    const reqSegs = reqUrl.pathname.split("/").filter(Boolean);
    const tplSegs = tplUrl.pathname.split("/").filter(Boolean);
    if (reqSegs.length !== tplSegs.length) return false;
    for (let i = 0; i < tplSegs.length; i++) {
      if (tplSegs[i] === "x") continue; // was a {template} placeholder
      if (tplSegs[i] !== reqSegs[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}
