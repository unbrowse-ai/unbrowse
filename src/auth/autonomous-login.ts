/**
 * Autonomous login — the full loop.
 *
 * When auth_required is detected, this module drives Kuri + AgentMail
 * to complete login without any agent or human intervention:
 *
 *   1. Open the login/register page in Kuri
 *   2. Detect email input field
 *   3. Create AgentMail inbox for the domain
 *   4. Fill the email field, submit
 *   5. Detect: OTP input or "check your email" message
 *   6. Poll AgentMail for verification email
 *   7. Extract OTP or magic link
 *   8. Fill OTP or navigate to magic link
 *   9. Verify login succeeded (cookies present)
 *  10. Store cookies in vault for future use
 *
 * The agent never sees any of this. They just get their data back.
 */

import * as kuri from "../kuri/client.js";
import { log } from "../logger.js";
import { extractOtpFromEmail, extractVerificationLink } from "./agent-mail.js";
import { getEmailProvider } from "./email-provider.js";
import { saveAuthProfileBestEffort, getAuthenticatedCookiesForDomain } from "./index.js";
import { storeCredential } from "../vault/index.js";
import { isDomainMatch, getRegistrableDomain } from "../domain.js";

const LOGIN_DETECT_TIMEOUT_MS = 10_000;
const OTP_FILL_TIMEOUT_MS = 120_000;
const POST_SUBMIT_SETTLE_MS = 3_000;

interface AutonomousLoginResult {
  success: boolean;
  method: "agent-mail-otp" | "agent-mail-link" | "failed";
  domain: string;
  email?: string;
  cookies_stored: number;
  error?: string;
  /** How long the entire flow took in ms */
  duration_ms: number;
}

// ── Page analysis helpers ──────────────────────────────────────────

/** Detect if the current page has an email input field. */
async function detectEmailInput(tabId: string): Promise<string | null> {
  const ref = await kuri.evaluate(tabId, `(() => {
    // Priority order: type=email, name/id containing email, placeholder containing email
    const byType = document.querySelector('input[type="email"]');
    if (byType) return byType.getAttribute("data-ref") || "input[type=email]";

    const byName = document.querySelector('input[name*="email" i], input[id*="email" i]');
    if (byName) return byName.getAttribute("data-ref") || 'input[name*="email" i]';

    const byPlaceholder = document.querySelector('input[placeholder*="email" i]');
    if (byPlaceholder) return byPlaceholder.getAttribute("data-ref") || 'input[placeholder*="email" i]';

    // Generic text input on a login page (single input + submit button pattern)
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    const submit = document.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (inputs.length === 1 && submit) {
      return inputs[0].getAttribute("data-ref") || 'input[type="text"]';
    }

    return null;
  })()`);

  return typeof ref === "string" ? ref : null;
}

/** Detect if the current page has an OTP/code input field. */
async function detectOtpInput(tabId: string): Promise<string | null> {
  const ref = await kuri.evaluate(tabId, `(() => {
    // OTP-specific inputs
    const byAutocomplete = document.querySelector('input[autocomplete="one-time-code"]');
    if (byAutocomplete) return byAutocomplete.getAttribute("data-ref") || 'input[autocomplete="one-time-code"]';

    // Name/id/placeholder containing otp, code, verification, pin
    const byName = document.querySelector(
      'input[name*="otp" i], input[name*="code" i], input[name*="verification" i], input[name*="pin" i], ' +
      'input[id*="otp" i], input[id*="code" i], input[id*="verification" i], ' +
      'input[placeholder*="code" i], input[placeholder*="verification" i], input[placeholder*="otp" i]'
    );
    if (byName) return byName.getAttribute("data-ref") || 'input[name*="code" i]';

    // Numeric input with maxlength 4-8 (common OTP pattern)
    const numericInputs = document.querySelectorAll('input[type="number"], input[type="tel"], input[inputmode="numeric"]');
    for (const el of numericInputs) {
      const ml = parseInt(el.getAttribute("maxlength") || "0");
      if (ml >= 4 && ml <= 8) return el.getAttribute("data-ref") || 'input[inputmode="numeric"]';
    }

    // Single short text input that appeared after email submit
    const textInputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (const el of textInputs) {
      const ml = parseInt(el.getAttribute("maxlength") || "0");
      if (ml >= 4 && ml <= 8) return el.getAttribute("data-ref") || 'input[type="text"]';
    }

    return null;
  })()`);

  return typeof ref === "string" ? ref : null;
}

/** Find the submit button on the page. */
async function detectSubmitButton(tabId: string): Promise<string | null> {
  const ref = await kuri.evaluate(tabId, `(() => {
    const submit = document.querySelector(
      'button[type="submit"], input[type="submit"], ' +
      'button:not([type]):not([aria-label*="close" i]):not([aria-label*="cancel" i])'
    );
    if (submit) return submit.getAttribute("data-ref") || 'button[type="submit"]';

    // Look for buttons with login/register/continue/verify text
    const buttons = document.querySelectorAll('button, a[role="button"]');
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || "";
      if (/log\s*in|sign\s*in|register|sign\s*up|continue|submit|verify|next/i.test(text)) {
        return btn.getAttribute("data-ref") || null;
      }
    }
    return null;
  })()`);

  return typeof ref === "string" ? ref : null;
}

/** Check if login succeeded by looking for auth cookies on the domain. */
async function checkLoginSuccess(tabId: string, domain: string): Promise<boolean> {
  const cookies = await kuri.getCookies(tabId);
  const domainCookies = cookies.filter((c) => isDomainMatch(c.domain, domain));
  const authCookies = getAuthenticatedCookiesForDomain(domain, domainCookies);
  return authCookies.length > 0;
}

// ── Main autonomous login flow ─────────────────────────────────────

/**
 * Attempt fully autonomous email-based login for a domain.
 *
 * Drives Kuri to navigate to the login page, fill the AgentMail email,
 * wait for OTP/magic link, and complete the login. Returns success/failure.
 *
 * Caller does NOT need to do anything — this is fire-and-forget.
 */
export async function autonomousLogin(
  loginUrl: string,
  domain?: string,
): Promise<AutonomousLoginResult> {
  const start = Date.now();
  const targetDomain = domain ?? (() => { try { return new URL(loginUrl).hostname.replace(/^www\./, ""); } catch { return loginUrl; } })();
  const elapsed = () => Date.now() - start;

  const emailProvider = getEmailProvider("register");
  if (!emailProvider) {
    return { success: false, method: "failed", domain: targetDomain, cookies_stored: 0, error: "No email provider configured (set AGENTMAIL_API_KEY or configure Gmail via gcloud)", duration_ms: elapsed() };
  }

  log("autonomous-login", `starting for ${targetDomain} — url: ${loginUrl}`);

  // Kuri works both headless and visible — don't force either

  let tabId: string;
  try {
    await kuri.start();
    tabId = await kuri.getDefaultTab();
    await kuri.networkEnable(tabId);
  } catch (err) {
    // no-op — we don't override HEADLESS
    return { success: false, method: "failed", domain: targetDomain, cookies_stored: 0, error: `Kuri start failed: ${err}`, duration_ms: elapsed() };
  }

  try {
    // Step 1: Navigate to login page
    await kuri.navigate(tabId, loginUrl);
    await new Promise((r) => setTimeout(r, 2_000)); // let page settle

    // Step 2: Detect email input
    let emailRef = await detectEmailInput(tabId);
    if (!emailRef) {
      // Maybe it's a "register" page with a different URL pattern
      const regUrl = loginUrl.replace(/login|signin|sign-in/i, "register").replace(/register/i, "signup");
      if (regUrl !== loginUrl) {
        await kuri.navigate(tabId, regUrl);
        await new Promise((r) => setTimeout(r, 2_000));
        emailRef = await detectEmailInput(tabId);
      }
    }

    if (!emailRef) {
      log("autonomous-login", `no email input found on ${loginUrl}`);
      return { success: false, method: "failed", domain: targetDomain, cookies_stored: 0, error: "no email input field detected", duration_ms: elapsed() };
    }

    // Step 3: Get email address from provider
    let agentEmail: string;
    try {
      agentEmail = await emailProvider.getAddress(targetDomain);
    } catch (err) {
      return { success: false, method: "failed", domain: targetDomain, cookies_stored: 0, error: `Email provider (${emailProvider.name}) failed: ${err}`, duration_ms: elapsed() };
    }

    log("autonomous-login", `filling email: ${agentEmail} (via ${emailProvider.name}) into ${emailRef}`);

    // Step 4: Fill email and submit
    await kuri.fill(tabId, emailRef, agentEmail);
    const submitRef = await detectSubmitButton(tabId);
    if (submitRef) {
      await kuri.click(tabId, submitRef);
    } else {
      // Try Enter key
      await kuri.evaluate(tabId, `document.querySelector('${emailRef}')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    }

    await new Promise((r) => setTimeout(r, POST_SUBMIT_SETTLE_MS));

    // Step 5: Check if we got a magic link or need OTP
    const otpRef = await detectOtpInput(tabId);

    if (otpRef) {
      // OTP flow — wait for email, extract code, fill it
      log("autonomous-login", `OTP input detected (${otpRef}), waiting for verification email via ${emailProvider.name}...`);
      const verificationEmail = await emailProvider.waitForMessage(targetDomain, OTP_FILL_TIMEOUT_MS);
      const otp = verificationEmail ? extractOtpFromEmail(verificationEmail.text) : null;

      if (!otp) {
        return { success: false, method: "failed", domain: targetDomain, email: agentEmail, cookies_stored: 0, error: "OTP email not received within timeout", duration_ms: elapsed() };
      }

      log("autonomous-login", `filling OTP: ${otp}`);
      await kuri.fill(tabId, otpRef, otp);

      const otpSubmitRef = await detectSubmitButton(tabId);
      if (otpSubmitRef) {
        await kuri.click(tabId, otpSubmitRef);
      }

      await new Promise((r) => setTimeout(r, POST_SUBMIT_SETTLE_MS));
    } else {
      // No OTP input — try magic link flow
      log("autonomous-login", `no OTP input, trying magic link flow via ${emailProvider.name}...`);
      const verificationEmail = await emailProvider.waitForMessage(targetDomain, OTP_FILL_TIMEOUT_MS);
      const link = verificationEmail ? extractVerificationLink(verificationEmail.text, verificationEmail.html) : null;

      if (link) {
        log("autonomous-login", `navigating to magic link`);
        await kuri.navigate(tabId, link);
        await new Promise((r) => setTimeout(r, POST_SUBMIT_SETTLE_MS));
      } else {
        // Maybe the email submit was enough (some sites auto-login on email)
        log("autonomous-login", `no magic link received, checking if already authenticated...`);
      }
    }

    // Step 6: Verify login succeeded
    const success = await checkLoginSuccess(tabId, targetDomain);

    if (success) {
      // Store cookies for future use
      const cookies = await kuri.getCookies(tabId);
      const domainCookies = cookies.filter((c) => isDomainMatch(c.domain, targetDomain));
      const storableCookies = domainCookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires: c.expires,
      }));

      const vaultKey = `auth:${getRegistrableDomain(targetDomain)}`;
      await storeCredential(vaultKey, JSON.stringify({ cookies: storableCookies }));
      await saveAuthProfileBestEffort(tabId, targetDomain, "autonomous_login");

      log("autonomous-login", `login succeeded for ${targetDomain} — stored ${storableCookies.length} cookies (${elapsed()}ms)`);

      return {
        success: true,
        method: otpRef ? "agent-mail-otp" : "agent-mail-link",
        domain: targetDomain,
        email: agentEmail,
        cookies_stored: storableCookies.length,
        duration_ms: elapsed(),
      };
    }

    return { success: false, method: "failed", domain: targetDomain, email: agentEmail, cookies_stored: 0, error: "login flow completed but no auth cookies detected", duration_ms: elapsed() };
  } finally {
    // no-op — we don't override HEADLESS
  }
}
