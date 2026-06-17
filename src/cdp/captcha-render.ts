/**
 * Render-side captcha clearance: when a browse render lands on a captcha widget,
 * read the challenge, escalate the SOLVE to the backend paid tier
 * (src/execution/captcha-clear.ts → /v1/solve — the key is server-side), then
 * inject the returned token into the page's response field and fire the widget
 * callback so the page proceeds. The unbrowse CLI does the LOCAL render + inject;
 * only the solve is the metered backend call.
 *
 * Best-effort + honest: returns {cleared:false} when there is no captcha widget,
 * no sitekey, or the solve degrades (no payment / server down) — the caller keeps
 * its blocked page. Never fabricates a clear.
 */
import type { CDPConnection } from "./types.js";
import { solveCaptchaClear } from "../execution/captcha-clear.js";

interface RenderTarget {
  sessionId: string;
}

// Vendor markers in the rendered HTML → the solver's vendor tag.
const VENDOR_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["cloudflare", /cf-turnstile|challenges\.cloudflare\.com|turnstile/i],
  ["recaptcha", /g-recaptcha|recaptcha\/api\.js|grecaptcha/i],
  ["hcaptcha", /\bh-captcha\b|hcaptcha\.com/i],
  ["funcaptcha", /funcaptcha|arkoselabs/i],
];

function detectVendor(html: string): string | null {
  for (const [vendor, re] of VENDOR_MARKERS) if (re.test(html)) return vendor;
  return null;
}

export interface CaptchaRenderResult {
  cleared: boolean;
  vendor?: string;
  /** Which tier solved it (always "server" — the key is backend-only). */
  source?: string;
  cost_usd?: number;
  reason?: string;
}

/**
 * Detect + clear a captcha on the currently-rendered page of `target`.
 * `url` is the page URL (websiteURL for the solver).
 */
export async function clearCaptchaInRender(
  conn: CDPConnection,
  target: RenderTarget,
  url: string,
): Promise<CaptchaRenderResult> {
  // 1. Wait for the page to load + a short settle, THEN read the DOM — captcha
  //    widgets (reCAPTCHA/Turnstile) inject asynchronously after navigate, so an
  //    immediate read misses them. Poll document.readyState (bounded), then settle.
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      const rs = (await conn.call(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        target.sessionId,
      )) as { result?: { value?: string } };
      if (rs?.result?.value === "complete" || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 1500)); // settle for async widget injection
  } catch {
    /* best-effort; fall through to the read */
  }

  // Read the rendered DOM.
  let html = "";
  try {
    const res = (await conn.call(
      "Runtime.evaluate",
      { expression: "document.documentElement.outerHTML", returnByValue: true },
      target.sessionId,
    )) as { result?: { value?: string } };
    html = res?.result?.value ?? "";
  } catch {
    return { cleared: false, reason: "dom_read_failed" };
  }

  // 2. Is there a solvable widget?
  const vendor = detectVendor(html);
  if (!vendor) return { cleared: false, reason: "no_captcha_widget" };
  if (!/data-sitekey=/i.test(html)) {
    // Managed challenge (no widget sitekey) — needs a residential RENDER, not a
    // solve. Honest: the solve tier can't help here.
    return { cleared: false, vendor, reason: "managed_challenge_no_sitekey" };
  }

  // 3. Escalate the solve to the backend paid tier (server holds the key).
  const solved = await solveCaptchaClear({ vendor, body: html, challengeUrl: url });
  if (!solved?.token) return { cleared: false, vendor, reason: "solve_degraded" };

  // 4. Inject the token into the standard response fields + fire common widget
  //    callbacks so the page proceeds. Best-effort across reCAPTCHA / Turnstile /
  //    hCaptcha shapes.
  const injectExpr = `(function(t){
    try {
      var fields = document.querySelectorAll(
        'textarea[name="g-recaptcha-response"],#g-recaptcha-response,' +
        'input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],' +
        'input[name="h-captcha-response"],textarea[name="h-captcha-response"]'
      );
      fields.forEach(function(e){ e.value = t; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); });
      // data-callback (Turnstile / reCAPTCHA explicit render)
      document.querySelectorAll('[data-callback]').forEach(function(el){
        var cb = el.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') { try { window[cb](t); } catch(_){} }
      });
      return fields.length;
    } catch(e) { return -1; }
  })(${JSON.stringify(solved.token)})`;
  try {
    await conn.call("Runtime.evaluate", { expression: injectExpr, returnByValue: true }, target.sessionId);
  } catch {
    return { cleared: false, vendor, source: solved.source, reason: "inject_failed" };
  }

  return { cleared: true, vendor, source: solved.source, cost_usd: solved.cost_usd };
}
