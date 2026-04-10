/**
 * Bootstrap AgentMail — get an API key by browsing console.agentmail.to.
 *
 * Uses Kuri to:
 *   1. Open console.agentmail.to (Clerk auth)
 *   2. Sign up via GitHub OAuth (Chrome cookies already logged in)
 *   3. Navigate to API Keys section
 *   4. Create a new API key
 *   5. Extract it from the DOM
 *   6. Store in vault + write to shell config
 *
 * This is the "unbrowse its way into getting the key" primitive.
 * Called during `unbrowse setup` when AGENTMAIL_API_KEY is not set.
 */

import * as kuri from "../kuri/client.js";
import { log } from "../logger.js";
import { storeCredential } from "../vault/index.js";
import { importBrowserCookiesIntoTab } from "./index.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const CONSOLE_URL = "https://console.agentmail.to";
const DASHBOARD_URL = "https://console.agentmail.to/dashboard";
const SETTLE_MS = 3_000;
const AUTH_TIMEOUT_MS = 120_000;

export interface BootstrapResult {
  success: boolean;
  api_key?: string;
  method?: "github-oauth" | "existing-session" | "manual";
  error?: string;
}

/**
 * Attempt to bootstrap an AgentMail API key by browsing the console.
 *
 * Strategy:
 *   1. Check if user already has a session (cookies from Chrome)
 *   2. If not, try GitHub OAuth (most devs are logged into GitHub)
 *   3. Navigate to API keys, create one, extract it
 */
export async function bootstrapAgentMailKey(): Promise<BootstrapResult> {
  log("bootstrap-agentmail", "starting — opening console.agentmail.to");

  // Don't force HEADLESS=false — Kuri works headless too.
  // Cookie injection + OAuth still works without a display.

  try {
    await kuri.start();
    const tabId = await kuri.getDefaultTab();
    await kuri.networkEnable(tabId);

    // Inject cookies from Chrome (might have Clerk session or GitHub session)
    await importBrowserCookiesIntoTab(tabId, "agentmail.to");
    await importBrowserCookiesIntoTab(tabId, "clerk.agentmail.to");
    await importBrowserCookiesIntoTab(tabId, "github.com");

    // Navigate to console
    await kuri.navigate(tabId, CONSOLE_URL);
    await new Promise(r => setTimeout(r, SETTLE_MS));

    // Check if we landed on dashboard (already logged in)
    let currentUrl = await kuri.getCurrentUrl(tabId);
    let onDashboard = typeof currentUrl === "string" && currentUrl.includes("/dashboard");

    if (!onDashboard) {
      // AgentMail console uses Clerk and offers Google OAuth (not GitHub).
      // Verified Apr 2026: buttons visible are "Google" and "Continue" (email).
      // Strategy: try whatever social OAuth button exists (Google preferred),
      // fall back to manual if no social session is available.
      log("bootstrap-agentmail", "not logged in — looking for social OAuth");
      const clickResult = await kuri.evaluate(tabId, `(() => {
        // Clerk's social button class pattern
        const socialBtns = document.querySelectorAll('.cl-socialButtonsBlockButton, [data-provider]');
        for (const btn of socialBtns) {
          const text = (btn.textContent || '').toLowerCase();
          const provider = btn.getAttribute('data-provider') || '';
          // Match any social provider — Google, GitHub, etc.
          if (text || provider) {
            btn.click();
            return 'clicked:' + (provider || text.slice(0, 20));
          }
        }
        // Fallback: look for any button with a known OAuth provider name
        const btns = document.querySelectorAll('button, a');
        for (const btn of btns) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('google') || text.includes('github') || text.includes('continue with')) {
            btn.click();
            return 'clicked:' + text.slice(0, 30);
          }
        }
        return 'not_found';
      })()`);
      const clickStr = typeof clickResult === "string" ? clickResult : String(clickResult);
      log("bootstrap-agentmail", `social button result: ${clickStr}`);

      if (clickStr.startsWith("clicked")) {
        log("bootstrap-agentmail", "clicked social OAuth — waiting for redirect");
        const start = Date.now();
        while (Date.now() - start < AUTH_TIMEOUT_MS) {
          await new Promise(r => setTimeout(r, 2_000));
          currentUrl = await kuri.getCurrentUrl(tabId);
          if (typeof currentUrl === "string" && currentUrl.includes("/dashboard")) {
            onDashboard = true;
            log("bootstrap-agentmail", "OAuth completed — on dashboard");
            break;
          }
        }
      }

      if (!onDashboard) {
        log("bootstrap-agentmail", "could not auto-login — manual setup needed");
        // Capture what the page looks like so agents can diagnose
        const pageInfo = await kuri.evaluate(tabId, `JSON.stringify({
          url: window.location.href,
          title: document.title,
          visible_buttons: Array.from(document.querySelectorAll('button,a'))
            .map(e => (e.textContent || '').trim().slice(0, 30))
            .filter(t => t)
            .slice(0, 10),
        })`).catch(() => "{}");
        return {
          success: false,
          method: "manual",
          error: `Could not auto-login to AgentMail console. Page state: ${pageInfo}. Sign up at https://console.agentmail.to and create an API key manually, then: export AGENTMAIL_API_KEY=<key>`,
        };
      }
    }

    // We're on the dashboard — navigate to API keys
    log("bootstrap-agentmail", "on dashboard — navigating to API keys");
    await kuri.navigate(tabId, `${DASHBOARD_URL}/api-keys`);
    await new Promise(r => setTimeout(r, SETTLE_MS));

    // Click "Create New API Key"
    const createResult = await kuri.evaluate(tabId, `(() => {
      const btns = document.querySelectorAll('button, a');
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('create') && (text.includes('key') || text.includes('api'))) {
          btn.click();
          return 'clicked';
        }
      }
      return 'not_found';
    })()`);

    if (createResult === "clicked") {
      await new Promise(r => setTimeout(r, 2_000));

      // Fill in the key name
      await kuri.evaluate(tabId, `(() => {
        const input = document.querySelector('input[placeholder*="name" i], input[name*="name" i], input[type="text"]');
        if (input) {
          input.value = 'unbrowse-agent';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`);

      // Click create/confirm button
      await kuri.evaluate(tabId, `(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('create') || text.includes('confirm') || text.includes('generate')) {
            btn.click();
            return 'clicked';
          }
        }
      })()`);

      await new Promise(r => setTimeout(r, 2_000));
    }

    // Extract the API key from the page
    const apiKey = await kuri.evaluate(tabId, `(() => {
      // Look for the key in common patterns
      // 1. Input/textarea with the key value
      const inputs = document.querySelectorAll('input[readonly], input[type="text"], textarea, code, pre');
      for (const el of inputs) {
        const val = el.value || el.textContent || '';
        // AgentMail keys typically start with 'am_' or are long alphanumeric strings
        if (/^(am_|sk_|key_)/.test(val) || (val.length > 30 && /^[a-zA-Z0-9_-]+$/.test(val))) {
          return val.trim();
        }
      }
      // 2. Look in the page text for key patterns
      const text = document.body.innerText;
      const match = text.match(/(am_[a-zA-Z0-9_-]{20,}|sk_[a-zA-Z0-9_-]{20,})/);
      if (match) return match[1];
      return null;
    })()`);

    if (apiKey && typeof apiKey === "string" && apiKey.length > 10) {
      log("bootstrap-agentmail", `extracted API key: ${apiKey.substring(0, 8)}...`);

      // Store in vault
      await storeCredential("agentmail:api_key", apiKey);

      // Write to shell config for persistence
      persistApiKeyToShell(apiKey);

      // Set in current process
      process.env.AGENTMAIL_API_KEY = apiKey;

      return {
        success: true,
        api_key: apiKey,
        method: onDashboard ? "existing-session" : "github-oauth",
      };
    }

    return {
      success: false,
      error: "Reached dashboard but could not extract API key. Create one manually at https://console.agentmail.to/dashboard/api-keys",
    };
  } finally {
    // no-op — we don't override HEADLESS anymore
  }
}

/** Append AGENTMAIL_API_KEY to the user's shell rc file. */
function persistApiKeyToShell(apiKey: string): void {
  const shell = process.env.SHELL ?? "/bin/zsh";
  const rcFile = shell.includes("zsh")
    ? path.join(os.homedir(), ".zshrc")
    : path.join(os.homedir(), ".bashrc");

  try {
    const content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, "utf-8") : "";
    if (content.includes("AGENTMAIL_API_KEY")) {
      log("bootstrap-agentmail", `${rcFile} already has AGENTMAIL_API_KEY — not overwriting`);
      return;
    }
    fs.appendFileSync(rcFile, `\n# AgentMail API key (added by unbrowse setup)\nexport AGENTMAIL_API_KEY="${apiKey}"\n`);
    log("bootstrap-agentmail", `wrote AGENTMAIL_API_KEY to ${rcFile}`);
  } catch (err) {
    log("bootstrap-agentmail", `failed to write to ${rcFile}: ${err}`);
  }
}
