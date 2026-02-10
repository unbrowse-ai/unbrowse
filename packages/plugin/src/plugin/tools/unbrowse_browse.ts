import type { ToolDeps } from "./deps.js";
import {
  existsSync,
  readFileSync,
  join,
  INTERACT_SCHEMA,
  parseHar,
  generateSkill,
} from "./shared.js";
import { runOpenClawBrowse } from "./browse/openclaw-flow.js";

export function makeUnbrowseBrowseTool(deps: ToolDeps) {
  const {
    logger,
    browserPort,
    defaultOutputDir,
    vaultDbPath,
    enableOtpAutoFill,
    enableChromeCookies,
    getOrCreateBrowserSession,
    startPersistentOtpWatcher,
    isOtpWatcherActive,
    getSharedBrowser,
    closeChrome,
    browserSessions,
    discovery,
    detectAndSaveRefreshConfig,
    autoPublishSkill,
  } = deps;

  return {
name: "unbrowse_browse",
label: "Unbrowse Browser",
description:
  "Complete tasks on websites using OpenClaw's native browser - login, fill forms, click buttons, " +
  "submit orders, post content, etc. Uses your existing Chrome profile with all logins preserved. " +
  "Returns indexed interactive elements (e.g. [1] <button> Submit, [2] <input placeholder=\"Email\">). " +
  "Use indices for actions: click_element(index=3), input_text(index=5, text=\"hello\"). " +
  "After task completion, API traffic is captured so you can replay it directly next time.",
parameters: INTERACT_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
  const p = params as {
    url: string;
    service?: string;
    actions: Array<{
      action: string;
      index?: number;
      text?: string;
      clear?: boolean;
      direction?: "down" | "up";
      amount?: number;
      selector?: string;
    }>;
    captureTraffic?: boolean;
    closeChromeIfNeeded?: boolean;
  };

  // Derive service name from URL if not provided (used across OpenClaw + Playwright flows).
  if (!p.service) {
    try {
      const host = new URL(p.url).hostname;
      p.service = host
        .replace(/^(www|api|app|auth|login)\./, "")
        .replace(/\.(com|io|org|net|dev|co|ai)$/, "")
        .replace(/\./g, "-");
    } catch {
      return { content: [{ type: "text", text: "Invalid URL." }] };
    }
  }

  // Normalize actions - LLMs sometimes send malformed action objects.
  // (e.g., { "fill": ... } instead of { "action": "fill", ... }).
  // Also filter out entries with no action at all.
  if (p.actions) {
    p.actions = p.actions
      .map((act) => {
        if (act.action) return act;
        // Try to infer action from other keys
        const keys = Object.keys(act);
        const actionKey = keys.find((k) =>
          ["click", "fill", "input", "select", "scroll", "wait", "extract", "navigate", "type"].includes(k),
        );
        if (actionKey) {
          const mapped: Record<string, string> = {
            click: "click_element",
            fill: "input_text",
            input: "input_text",
            select: "select_option",
            scroll: "scroll",
            wait: "wait",
            extract: "extract_content",
            navigate: "go_to_url",
            type: "send_keys",
          };
          return { ...act, action: mapped[actionKey] ?? actionKey };
        }
        return act;
      })
      .filter((act) => act.action);
  }

  // Preferred: OpenClaw native browser control. Fallback: Playwright.
  const openclawRes = await runOpenClawBrowse(deps, p);
  if (openclawRes) return openclawRes;

  // Playwright fallback when OpenClaw browser is not available.
  logger.info(`[unbrowse] OpenClaw browser not available, using Playwright fallback`);

  // Check if Chrome is running and we need to handle it
  if (!getSharedBrowser()) {
    const { spawnSync } = await import("node:child_process");
    const psResult = spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf-8" });
    const chromeIsRunning = psResult.stdout.trim().length > 0;

    // Check if any CDP port is available (Chrome with debugging OR openclaw browser)
    let cdpAvailable = false;
    for (const port of [18792, 18800, browserPort, 9222, 9229]) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok) {
          cdpAvailable = true;
          break;
        }
      } catch { /* not available */ }
    }

    if (chromeIsRunning && cdpAvailable) {
      // Chrome has CDP enabled - connect directly, no need to close
      logger.info(`[unbrowse] Chrome has CDP enabled - connecting directly`);
    } else if (chromeIsRunning && !cdpAvailable && p.closeChromeIfNeeded) {
      // Chrome running without CDP and user gave permission - close and relaunch
      logger.info(`[unbrowse] Closing Chrome to use your profile with all logins...`);
      await closeChrome();
    }
    // If Chrome is running without CDP and no permission, fall back to Playwright
  }

  const { extractPageState, getElementByIndex, formatPageStateForLLM, detectOTPField } = await import(
    "../../dom-service.js"
  );
  const service = p.service;

  // Load auth from skill's auth.json (with vault fallback)
  const skillDir = join(defaultOutputDir, service);
  const authPath = join(skillDir, "auth.json");
  let authHeaders: Record<string, string> = {};
  let authCookies: Record<string, string> = {};
  let storedLocalStorage: Record<string, string> = {};
  let storedSessionStorage: Record<string, string> = {};
  let baseUrl = "";
  let authSource = "none";

  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      authHeaders = auth.headers ?? {};
      authCookies = auth.cookies ?? {};
      baseUrl = auth.baseUrl ?? "";
      storedLocalStorage = auth.localStorage ?? {};
      storedSessionStorage = auth.sessionStorage ?? {};
      authSource = "auth.json";
    } catch { /* try vault fallback */ }
  }

  // Fallback: try loading from vault if auth.json is missing or empty
  if (Object.keys(authCookies).length === 0 && Object.keys(authHeaders).length === 0) {
    try {
      const { Vault } = await import("../../vault.js");
      const vault = new Vault(vaultDbPath);
      const entry = vault.get(service);
      vault.close();
      if (entry) {
        authHeaders = entry.headers ?? {};
        authCookies = entry.cookies ?? {};
        baseUrl = entry.baseUrl ?? "";
        // extra contains localStorage/sessionStorage tokens
        for (const [key, value] of Object.entries(entry.extra ?? {})) {
          storedLocalStorage[key] = String(value);
        }
        authSource = "vault";
        logger.info(`[unbrowse] Loaded auth from vault for ${service}`);
      }
    } catch { /* vault not available */ }
  }

  // Fallback: try loading cookies from Chrome's cookie database (opt-in only)
  if (Object.keys(authCookies).length === 0 && enableChromeCookies) {
    try {
      const { readChromeCookies, chromeCookiesAvailable } = await import("../../chrome-cookies.js");
      if (chromeCookiesAvailable()) {
        const domain = new URL(p.url).hostname.replace(/^www\./, "");
        const chromeCookies = readChromeCookies(domain);
        if (Object.keys(chromeCookies).length > 0) {
          authCookies = chromeCookies;
          authSource = "chrome";
          logger.info(`[unbrowse] Loaded ${Object.keys(chromeCookies).length} cookies from Chrome for ${domain}`);
        }
      }
    } catch (err) {
      logger.warn(`[unbrowse] Could not read Chrome cookies: ${(err as Error).message}`);
    }
  }

  // Get or reuse browser session - uses CDP cascade:
  // 1. Try openclaw managed browser (port 18791) - has existing cookies/auth
  // 2. Try Chrome remote debugging (9222, 9229)
  // 3. Launch Chrome with user's profile (requires Chrome to be closed)
  let session: any | null = null;
  let browser: any = null;
  let context: any = null;
  let page: any = null;
  let isReusedSession = false;

  try {
    // Check if we already have a session before creating one
    const hadExistingSession = browserSessions.has(service);
    session = await getOrCreateBrowserSession(service, p.url, authCookies, authHeaders);
    browser = session.browser;
    context = session.context;
    page = session.page;

    // Only log "reusing" if the session was actually reused (not recreated after stale cleanup)
    isReusedSession = hadExistingSession && browserSessions.get(service) === session;
  } catch (browserErr) {
    const errMsg = (browserErr as Error).message;
    if (errMsg === "NO_BROWSER") {
      return {
        content: [{
          type: "text",
          text: `**Could not launch browser.**\n\n` +
            `Playwright Chromium failed to start.\n\n` +
            `**Try:**\n` +
            `1. Run: \`npx playwright install chromium\`\n` +
            `2. Then run this command again`,
        }],
      };
    }
    throw browserErr;
  }

  // Track OTP field index for re-detection after clicks
  let otpAutoFillIndex: number | null = null;

  try {
    // If this is an existing session, we may need to navigate to a new page
    // Check if current URL matches target - if not, navigate
    const currentUrl = page.url();
    const targetOrigin = new URL(p.url).origin;
    if (!currentUrl.startsWith(targetOrigin)) {
      // Need a fresh page for this different origin
      page = await context.newPage();
      session.page = page;
    }

    // Capture API traffic - full HAR entries for skill generation
    const shouldCapture = p.captureTraffic !== false;
    const capturedRequests: Array<{
      method: string;
      url: string;
      status: number;
      resourceType: string;
    }> = [];
    const harEntries: Array<{
      request: {
        method: string;
        url: string;
        headers: Array<{ name: string; value: string }>;
        cookies: Array<{ name: string; value: string }>;
        queryString: Array<{ name: string; value: string }>;
        postData?: { mimeType: string; text: string };
      };
      response: {
        status: number;
        statusText: string;
        headers: Array<{ name: string; value: string }>;
        content: { mimeType: string; text?: string };
      };
    }> = [];

    if (shouldCapture) {
      page.on("response", async (resp: any) => {
        const req = resp.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch" && rt !== "document") return;

        const url = req.url();
        const method = req.method();

        capturedRequests.push({ method, url, status: resp.status(), resourceType: rt });

        // Build HAR entry for skill generation
        try {
          const reqHeaders = Object.entries(req.headers() ?? {}).map(([name, value]) => ({
            name,
            value: String(value),
          }));
          const respHeaders = Object.entries(resp.headers() ?? {}).map(([name, value]) => ({
            name,
            value: String(value),
          }));

          // Parse query string from URL
          const queryString: Array<{ name: string; value: string }> = [];
          try {
            const u = new URL(url);
            u.searchParams.forEach((value, name) => queryString.push({ name, value }));
          } catch { /* ignore */ }

          // Capture post data
          let postData: { mimeType: string; text: string } | undefined;
          if (method !== "GET" && method !== "HEAD") {
            try {
              const pd = req.postData();
              if (pd) {
                const ct = req.headers()["content-type"] ?? "application/octet-stream";
                postData = { mimeType: ct, text: pd };
              }
            } catch { /* ignore */ }
          }

          // Capture response body (best-effort, skip large/binary)
          let responseText: string | undefined;
          try {
            const ct = resp.headers()["content-type"] ?? "";
            if (ct.includes("json") || ct.includes("text") || ct.includes("xml")) {
              const body = await resp.text().catch(() => "");
              if (body.length < 50_000) responseText = body;
            }
          } catch { /* ignore */ }

          const cookies = Object.entries(authCookies).map(([name, value]) => ({ name, value }));

          harEntries.push({
            request: { method, url, headers: reqHeaders, cookies, queryString, postData },
            response: {
              status: resp.status(),
              statusText: resp.statusText(),
              headers: respHeaders,
              content: {
                mimeType: resp.headers()["content-type"] ?? "",
                text: responseText,
              },
            },
          });
        } catch { /* non-critical - don't break interaction for HAR capture */ }
      });
    }

    // Inject localStorage/sessionStorage via addInitScript BEFORE page JS runs
    // This is critical for SPAs that check auth on load - inject BEFORE navigation
    const hasStorage = Object.keys(storedLocalStorage).length > 0 || Object.keys(storedSessionStorage).length > 0;
    if (hasStorage) {
      try {
        // addInitScript runs before ANY page JavaScript - perfect for SPA auth
        await context.addInitScript(`
            (function() {
              const ls = ${JSON.stringify(storedLocalStorage)};
              const ss = ${JSON.stringify(storedSessionStorage)};
              for (const [k, v] of Object.entries(ls)) {
                try { window.localStorage.setItem(k, v); } catch {}
              }
              for (const [k, v] of Object.entries(ss)) {
                try { window.sessionStorage.setItem(k, v); } catch {}
              }
            })();
          `);
        logger.info(`[unbrowse] Registered init script with ${Object.keys(storedLocalStorage).length} localStorage + ${Object.keys(storedSessionStorage).length} sessionStorage tokens`);
      } catch (err) {
        // Fallback: try direct injection on current page
        logger.warn(`[unbrowse] addInitScript failed, using fallback: ${(err as Error).message}`);
        try {
          await page.evaluate(
            ({ ls, ss }: { ls: Record<string, string>; ss: Record<string, string> }) => {
              for (const [k, v] of Object.entries(ls)) {
                try { window.localStorage.setItem(k, v); } catch {}
              }
              for (const [k, v] of Object.entries(ss)) {
                try { window.sessionStorage.setItem(k, v); } catch {}
              }
            },
            { ls: storedLocalStorage, ss: storedSessionStorage },
          );
        } catch { /* page may block storage access */ }
      }
    }

    // Navigate to the target URL (init script will inject tokens before page JS runs)
    try {
      await page.goto(p.url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch {
      // Navigation timeout - page may still be loading dynamic content
      await page.waitForTimeout(3000);
    }

    // Extract initial page state (indexed elements)
    let pageState = await extractPageState(page);

    // Auto-OTP detection - use persistent watcher that survives interact completion
    const otpDetection = detectOTPField(pageState);
    otpAutoFillIndex = otpDetection.hasOTP ? (otpDetection.elementIndex ?? null) : null;

    if (otpDetection.hasOTP && otpAutoFillIndex != null) {
      // Start persistent watcher (runs in background, doesn't stop when interact ends)
      await startPersistentOtpWatcher(page, otpAutoFillIndex);
    }

    // Execute actions (browser-use style - index-based)
    const actionResults: string[] = [];

    for (const act of p.actions) {
      try {
        switch (act.action) {
          // Index-based element actions
          case "click_element": {
            if (act.index == null && !act.selector) {
              actionResults.push("click_element: missing index or selector");
              break;
            }
            if (act.index != null) {
              const el = await getElementByIndex(page, act.index);
              if (!el || (await el.evaluate((e: any) => !e))) {
                actionResults.push(`click_element: index ${act.index} not found - page may have changed`);
                break;
              }
              await el.click();
            } else if (act.selector) {
              await page.waitForSelector(act.selector, { timeout: 10_000 });
              await page.click(act.selector);
            }
            await page.waitForTimeout(500);
            // Re-extract page state after click (page may have changed)
            pageState = await extractPageState(page);

            // Re-check for OTP fields after click (might have navigated to 2FA page)
            if (!isOtpWatcherActive()) {
              const newOtpCheck = detectOTPField(pageState);
              if (newOtpCheck.hasOTP && newOtpCheck.elementIndex != null) {
                otpAutoFillIndex = newOtpCheck.elementIndex;
                await startPersistentOtpWatcher(page, otpAutoFillIndex);
                actionResults.push(`OTP field detected - auto-watching for SMS/notifications (5min TTL)`);
              }
            }

            const desc = act.index != null
              ? `[${act.index}] ${pageState.elements.find(e => e.index === act.index)?.text?.slice(0, 50) ?? ""}`
              : act.selector;
            actionResults.push(`click_element: ${desc} done`);
            break;
          }

          case "input_text": {
            if (act.index == null && !act.selector) {
              actionResults.push("input_text: missing index or selector");
              break;
            }
            const text = act.text ?? "";
            const clear = act.clear !== false;
            if (act.index != null) {
              const el = await getElementByIndex(page, act.index);
              if (!el || (await el.evaluate((e: any) => !e))) {
                actionResults.push(`input_text: index ${act.index} not found`);
                break;
              }
              if (clear) {
                await el.fill(text);
              } else {
                await el.type(text);
              }
            } else if (act.selector) {
              await page.waitForSelector(act.selector, { timeout: 10_000 });
              if (clear) {
                await page.fill(act.selector, text);
              } else {
                await page.type(act.selector, text);
              }
            }
            await page.waitForTimeout(200);
            actionResults.push(`input_text: [${act.index ?? act.selector}] = "${text.slice(0, 50)}" done`);
            break;
          }

          case "select_option": {
            if (act.index == null && !act.selector) {
              actionResults.push("select_option: missing index or selector");
              break;
            }
            const optText = act.text ?? "";
            if (act.index != null) {
              const el = await getElementByIndex(page, act.index);
              if (!el || (await el.evaluate((e: any) => !e))) {
                actionResults.push(`select_option: index ${act.index} not found`);
                break;
              }
              // Try selecting by label text first, then by value
              await el.selectOption({ label: optText }).catch(() =>
                el.selectOption(optText),
              );
            } else if (act.selector) {
              await page.waitForSelector(act.selector, { timeout: 10_000 });
              await page.selectOption(act.selector, { label: optText }).catch(() =>
                page.selectOption(act.selector!, optText),
              );
            }
            await page.waitForTimeout(200);
            pageState = await extractPageState(page);
            actionResults.push(`select_option: [${act.index ?? act.selector}] = "${optText}" done`);
            break;
          }

          case "get_dropdown_options": {
            if (act.index == null) {
              actionResults.push("get_dropdown_options: missing index");
              break;
            }
            const el = pageState.elements.find(e => e.index === act.index);
            if (el?.options) {
              actionResults.push(`dropdown_options [${act.index}]: ${el.options.join(", ")}`);
            } else {
              // Try extracting from page
              const elHandle = await getElementByIndex(page, act.index);
              if (elHandle) {
                const opts = await elHandle.evaluate((e: any) => {
                  if (e.tagName === "SELECT") {
                    return Array.from(e.options).map((o: any) => o.text.trim()).slice(0, 20);
                  }
                  return [];
                });
                actionResults.push(`dropdown_options [${act.index}]: ${(opts as string[]).join(", ") || "no options found"}`);
              } else {
                actionResults.push(`get_dropdown_options: index ${act.index} not found`);
              }
            }
            break;
          }

          // Page-level actions
          case "scroll": {
            const down = (act.direction ?? "down") === "down";
            const pages = act.amount ?? 1;
            const pixels = Math.round(pages * (pageState.viewportHeight || 800));
            await page.evaluate(
              ({ px, d }: { px: number; d: boolean }) => window.scrollBy(0, d ? px : -px),
              { px: pixels, d: down },
            );
            await page.waitForTimeout(300);
            pageState = await extractPageState(page);
            actionResults.push(`scroll: ${down ? "down" : "up"} ${pages} page(s) done`);
            break;
          }

          case "send_keys": {
            const keys = act.text ?? "Enter";
            await page.keyboard.press(keys);
            await page.waitForTimeout(300);
            pageState = await extractPageState(page);
            actionResults.push(`send_keys: "${keys}" done`);
            break;
          }

          case "wait": {
            if (act.selector) {
              await page.waitForSelector(act.selector, { timeout: act.amount ?? 10_000 });
              actionResults.push(`wait: ${act.selector} appeared`);
            } else {
              const ms = act.amount ?? 2000;
              await page.waitForTimeout(ms);
              actionResults.push(`wait: ${ms}ms done`);
            }
            pageState = await extractPageState(page);
            break;
          }

          case "extract_content": {
            const bodyText = await page.evaluate(() =>
              document.body?.innerText?.slice(0, 5000) ?? "",
            );
            actionResults.push(`extract_content:\n${bodyText.slice(0, 3000)}`);
            break;
          }

          case "go_to_url": {
            const url = act.text;
            if (!url) {
              actionResults.push("go_to_url: missing URL in text field");
              break;
            }
            try {
              await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
            } catch {
              await page.waitForTimeout(3000);
            }
            pageState = await extractPageState(page);
            actionResults.push(`go_to_url: ${url} done`);
            break;
          }

          case "go_back": {
            await page.goBack({ waitUntil: "networkidle", timeout: 15_000 }).catch(() => { });
            pageState = await extractPageState(page);
            actionResults.push("go_back: done");
            break;
          }

          case "done": {
            actionResults.push(`done: ${act.text ?? "Task complete"}`);
            break;
          }

          case "wait_for_otp": {
            // Wait for OTP from SMS/notification and auto-fill
            const { startOTPWatcher, stopOTPWatcher, getOTPWatcher } = await import("../../otp-watcher.js");
            const watcher = startOTPWatcher((otp) => {
              logger.info(`[unbrowse] OTP detected: ${otp.code} from ${otp.source}`);
            });

            const timeoutMs = (act.amount ?? 60) * 1000;
            actionResults.push(`wait_for_otp: Waiting up to ${timeoutMs / 1000}s for OTP from SMS/clipboard...`);

            const otp = await watcher.waitForOTP(timeoutMs);

            if (otp) {
              actionResults.push(`wait_for_otp: Got OTP "${otp.code}" from ${otp.source}`);

              // Auto-fill if index is provided
              if (act.index != null) {
                const el = await getElementByIndex(page, act.index);
                if (el) {
                  await el.click();
                  await el.fill(otp.code);
                  actionResults.push(`wait_for_otp: Filled OTP into element [${act.index}]`);
                }
              }

              watcher.clear(); // Clear so we don't reuse
            } else {
              actionResults.push(`wait_for_otp: No OTP received within ${timeoutMs / 1000}s`);
            }

            pageState = await extractPageState(page);
            break;
          }

          default:
            actionResults.push(`unknown action: ${act.action}`);
        }
      } catch (err) {
        actionResults.push(`${act.action}: FAILED - ${(err as Error).message}`);
        // Re-extract page state so agent can recover
        try { pageState = await extractPageState(page); } catch { /* ignore */ }
      }
    }

    // Capture updated cookies/storage for persistence
    const finalCookies = await context.cookies().catch(() => []);
    const updatedCookies: Record<string, string> = {};
    for (const c of finalCookies as Array<{ name: string; value: string }>) {
      updatedCookies[c.name] = c.value;
    }

    let updatedLocalStorage: Record<string, string> = {};
    let updatedSessionStorage: Record<string, string> = {};
    try {
      const freshState = await page.evaluate(() => {
        const authKeywords =
          /token|auth|session|jwt|access|refresh|csrf|xsrf|key|cred|user|login|bearer/i;
        const ls: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key && authKeywords.test(key)) {
            const val = window.localStorage.getItem(key);
            if (val) ls[key] = val;
          }
        }
        const ss: Record<string, string> = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          if (key && authKeywords.test(key)) {
            const val = window.sessionStorage.getItem(key);
            if (val) ss[key] = val;
          }
        }
        return { localStorage: ls, sessionStorage: ss };
      });
      updatedLocalStorage = freshState.localStorage;
      updatedSessionStorage = freshState.sessionStorage;
    } catch { /* page may be closed */ }

    // Persist updated auth state back to auth.json
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      const existing = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf-8")) : {};
      existing.cookies = { ...authCookies, ...updatedCookies };
      existing.localStorage = { ...storedLocalStorage, ...updatedLocalStorage };
      existing.sessionStorage = { ...storedSessionStorage, ...updatedSessionStorage };
      existing.lastInteractAt = new Date().toISOString();
      if (!existing.baseUrl) existing.baseUrl = baseUrl || new URL(p.url).origin;
      writeFileSync(authPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch { /* non-critical */ }

    // Update session timestamp (don't close - reuse across calls)
    // Browser will be cleaned up after SESSION_TTL_MS inactivity
    if (session) {
      session.lastUsed = new Date();
    }

    const apiCalls = capturedRequests.filter(
      (r) => r.resourceType === "xhr" || r.resourceType === "fetch",
    );

    // Auto-generate skill from captured API traffic
    let skillResult: { service: string; endpointCount: number; changed: boolean; diff?: string; skillDir: string } | null = null;
    const apiHarEntries = harEntries.filter((e) => {
      const ct = e.response.content.mimeType ?? "";
      return ct.includes("json") || ct.includes("xml") || ct.includes("text/plain") || e.request.method !== "GET";
    });

    if (apiHarEntries.length >= 2) {
      try {
        const har = { log: { entries: apiHarEntries } };
        const apiData = parseHar(har as any, p.url);
        // Merge cookies from auth
        for (const [name, value] of Object.entries(authCookies)) {
          if (!apiData.cookies[name]) apiData.cookies[name] = value;
        }
        // Merge auth headers
        for (const [name, value] of Object.entries(authHeaders)) {
          if (!apiData.authHeaders[name]) apiData.authHeaders[name] = value;
        }

        const result = await generateSkill(apiData, defaultOutputDir);
        discovery.markLearned(result.service);
        skillResult = result;

        // Detect and save refresh token config
        detectAndSaveRefreshConfig(apiHarEntries, join(result.skillDir, "auth.json"), logger);

        logger.info(
          `[unbrowse] Interact -> auto-skill "${result.service}" (${result.endpointCount} endpoints${result.diff ? `, ${result.diff}` : ""})`,
        );

        // Auto-publish if changed
        if (result.changed) {
          autoPublishSkill(result.service, result.skillDir).catch(() => { });
        }
      } catch (err) {
        logger.warn(`[unbrowse] Interact skill generation failed: ${(err as Error).message}`);
      }
    }

    // Build result: page state + action results + API traffic + skill
    const formattedPageState = formatPageStateForLLM(pageState);
    const sessionInfo = session
      ? `Browser: ${session.method}${isReusedSession ? " (reused session)" : " (new session)"}${authSource !== "none" ? `, auth: ${authSource}` : ""}`
      : "";
    const resultLines = [
      `Interaction complete: ${p.actions.length} action(s)`,
      sessionInfo,
      "",
      formattedPageState,
      "",
      "Action results:",
      ...actionResults.map((r) => `  ${r}`),
    ];

    if (apiCalls.length > 0) {
      resultLines.push(
        "",
        `API traffic captured: ${apiCalls.length} request(s)`,
        ...apiCalls.slice(0, 20).map(
          (r) => `  ${r.method} ${r.url.slice(0, 100)} -> ${r.status}`,
        ),
      );
      if (apiCalls.length > 20) {
        resultLines.push(`  ... and ${apiCalls.length - 20} more`);
      }
    }

    if (skillResult) {
      resultLines.push(
        "",
        `Skill auto-generated: ${skillResult.service} (${skillResult.endpointCount} endpoints)`,
      );
      if (skillResult.diff) resultLines.push(`  Changes: ${skillResult.diff}`);
      resultLines.push(`  Use unbrowse_replay with service="${skillResult.service}" to call these APIs directly.`);
    }

    // Note: Persistent OTP watcher intentionally NOT stopped here
    // It continues running in background to fill OTP when it arrives

    logger.info(
      `[unbrowse] Interact: ${p.actions.length} actions on ${pageState.url} (${apiCalls.length} API calls, ${pageState.elements.length} elements${skillResult ? `, skill: ${skillResult.service}` : ""})`,
    );
    return { content: [{ type: "text", text: resultLines.join("\n") }] };
  } catch (err) {
    const msg = (err as Error).message;
    // On error, invalidate the session so next call gets fresh browser
    if (service && browserSessions.has(service)) {
      const deadSession = browserSessions.get(service)!;
      deadSession.context?.close().catch(() => { });
      deadSession.browser?.close().catch(() => { });
      browserSessions.delete(service);
    }
    if (msg.includes("playwright")) {
      return {
        content: [{ type: "text", text: `Playwright not available: ${msg}. Install with: bun add playwright` }],
      };
    }
    return { content: [{ type: "text", text: `Interaction failed: ${msg}` }] };
  }
},
};
}
