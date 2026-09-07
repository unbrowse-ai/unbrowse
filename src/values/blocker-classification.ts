/**
 * blocker-classification — is this response the ORIGIN, or a bot wall standing
 * in front of it?
 *
 * Moved here from src/execution/index.ts so that BOTH sides of the firmament can
 * ask the question through one definition. The capture engines could not reach
 * it before: `execution/index.ts` imports `capture/index.ts`, so a capture-side
 * import would have closed a cycle, and the alternative — a second detector next
 * to the capture path — is exactly the enumerated-filter debt the standing rule
 * forbids. One vocabulary, two callers.
 *
 * What it cost to not have this: obscura requested defillama's
 * `/api/public/protocol-rankings` and Cloudflare answered 403 with a 6,930-byte
 * "Just a moment..." interstitial (`cf-mitigated: challenge`). The capture path
 * admitted that row as an api-like request — `apiLikelyRequests` matches on URL
 * shape and never looks at status — so a challenge page was about to become the
 * evidence, and the response contract, for a real endpoint.
 *
 * Pure: status + headers + body in, classification out. No I/O, no clock.
 */

export function classifyExecuteFailure(input: {
  status: number;
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
}): { kind: "vendor_blocked" | "stale_credentials" | "transient"; vendor?: string; evidence?: string } {
  const { status, body, headers } = input;
  // Normalize body to a searchable string. JSON envelopes (already parsed)
  // get stringified; HTML/text bodies pass through; null/undefined → "".
  let bodyStr = "";
  if (typeof body === "string") bodyStr = body;
  else if (body != null) {
    try { bodyStr = JSON.stringify(body); } catch { bodyStr = String(body); }
  }
  const sample = bodyStr.length > 16384 ? bodyStr.slice(0, 16384) : bodyStr;
  const lower = sample.toLowerCase();
  const headerLines: string[] = [];
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      const val = Array.isArray(v) ? v.join("; ") : v;
      headerLines.push(`${k.toLowerCase()}: ${val.toLowerCase()}`);
    }
  }
  const headerStr = headerLines.join("\n");

  // Vendor markers — body OR headers can carry them. Order matters: more
  // specific vendors first so we don't tag a DataDome page as "captcha_vendor".
  // Patterns lifted from detectBrowserBlockSignals to keep one source of truth.
  if (
    /datadome|js\.datadome|dd\.datadome|_dd\.s|ddjskey|captcha-delivery|"action_message":"please[^"]+enable|x-dd-b|'rt':'c'/i.test(sample) ||
    /\bdatadome=|x-datadome|x-dd-b/.test(headerStr)
  ) return { kind: "vendor_blocked", vendor: "datadome", evidence: "body_or_header_marker" };
  if (
    /perimeterx|px-cloud|px-cdn|pxhd\.net|_pxhd|_pxvid|"appId":"px"/i.test(sample) ||
    /\bpx_=|_pxhd=/.test(headerStr)
  ) return { kind: "vendor_blocked", vendor: "perimeterx", evidence: "body_or_header_marker" };
  if (
    /akam\.net|bot-defender|\/_bm\/|sensor[-_]data|bm\.nuid|_abck/i.test(sample) ||
    /\b_abck=|akam-/.test(headerStr)
  ) return { kind: "vendor_blocked", vendor: "akamai_bot_manager", evidence: "body_or_header_marker" };
  if (
    /cf-challenge|__cf_chl_|cf_clearance|turnstile|cdn-cgi\/challenge|challenges\.cloudflare/i.test(sample) ||
    /\bcf-mitigated|server: cloudflare/.test(headerStr) && status === 403
  ) return { kind: "vendor_blocked", vendor: "cloudflare", evidence: "body_or_header_marker" };
  if (/_incapsula|incapsula|reese84|imperva/i.test(sample)) {
    return { kind: "vendor_blocked", vendor: "imperva_incapsula", evidence: "body_marker" };
  }
  if (/\/_fs-ch-[a-z0-9]+\//i.test(sample)) {
    return { kind: "vendor_blocked", vendor: "fastly_bot_management", evidence: "body_marker" };
  }
  if (/kasada|client\.kasada|ips\.kasada|x-kpsdk-/i.test(sample) || /\bx-kpsdk-/i.test(headerStr)) {
    return { kind: "vendor_blocked", vendor: "kasada", evidence: "body_or_header_marker" };
  }
  if (/shape\.security|f5\.com\/shape|shapesecurity/i.test(sample)) {
    return { kind: "vendor_blocked", vendor: "shape_security", evidence: "body_marker" };
  }
  // captcha_vendor: require an ACTIVE challenge marker — widget container,
  // iframe, or solved-response form field. A bare script reference to
  // hcaptcha/recaptcha is common on normal pages that protect a sign-up or
  // search form (observed false-positive on pubmed.ncbi.nlm.nih.gov where
  // the page is unrestricted but the search form has reCAPTCHA spam guard).
  // Substrate-faithful: structural primitive (widget shape), no per-host.
  if (
    /<div[^>]+(?:class\s*=\s*"[^"]*(?:g-recaptcha|h-captcha)[^"]*"|data-sitekey\s*=)/i.test(sample) ||
    /<iframe[^>]+src\s*=\s*"[^"]*(?:hcaptcha|recaptcha|funcaptcha|arkoselabs)/i.test(sample) ||
    /name\s*=\s*"g-recaptcha-response"|"g-recaptcha-response"\s*:/.test(sample)
  ) {
    return { kind: "vendor_blocked", vendor: "captcha_vendor", evidence: "challenge_widget" };
  }

  // W6: Akamai bot management interstitial detection on JSON-extracted bodies.
  // The title-tag check below catches the same phrases when they sit inside
  // <title>...</title> HTML markup. When an upstream extractor pulls the
  // title into a JSON shape (e.g. {"title":"Pardon Our Interruption..."})
  // the HTML markup is gone but the phrase remains, so we check the raw
  // sample string for the specific Akamai interstitial phrases. Anchored
  // on highly specific phrases (low false-positive risk on legitimate APIs).
  // Plan: drive-every-bug-class-surfaced-by-the-mcp-gate-r W6 (probe 032 ebay).
  if (/pardon our interruption|checking your browser before you access/i.test(sample)) {
    return { kind: "vendor_blocked", vendor: "akamai_bot_manager", evidence: "interstitial_phrase" };
  }

  // Title-of-an-HTML-error-page check — catches cases where the body is a
  // generic challenge page without a vendor-specific marker.
  const titleMatch = sample.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
  if (titleMatch) {
    const t = titleMatch[1].toLowerCase();
    if (/just a moment|attention required|access denied|pardon our interruption|verifying you are human|are you a robot|bot check|press and hold|unusual traffic|security check|client challenge|checking your browser|captcha|accès bloqué|acceso denegado|zugriff verweigert|アクセス拒否|访问被拒绝|доступ запрещ|blocked|access blocked|forbidden/i.test(t)) {
      return { kind: "vendor_blocked", vendor: "generic_challenge", evidence: `title:${t.slice(0, 80)}` };
    }
  }

  // Reserved for future 5xx work — not used this iteration.
  if (status >= 500) return { kind: "transient", evidence: `http_${status}` };

  // Default: preserve prior behavior — caller's stale_credentials path.
  return { kind: "stale_credentials" };
}
