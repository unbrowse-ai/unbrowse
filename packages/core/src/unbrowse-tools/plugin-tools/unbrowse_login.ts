import type { ToolDeps } from "./deps.js";
import type { LoginCredential, LoginCredentials } from "./shared.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  join,
  homedir,
  LOGIN_SCHEMA,
  loginAndCapture,
  lookupCredentials,
  buildFormFields,
  parseHar,
  generateSkill,
} from "./shared.js";
import { inferCsrfProvenance } from "../../auth-provenance.js";
import { buildPublishPromptLines, isPayerPrivateKeyValid } from "./publish-prompts.js";

export function makeUnbrowseLoginTool(deps: ToolDeps) {
  const {
    logger,
    browserPort,
    defaultOutputDir,
    vaultDbPath,
    credentialProvider,
    detectAndSaveRefreshConfig,
    discovery,
    getOrCreateBrowserSession,
  } = deps;

  return {
name: "unbrowse_login",
label: "Login & Capture Auth",
description:
  "Log in to a website and capture session auth for calling internal APIs. Extracts session cookies, " +
  "auth tokens, CSRF tokens, and any custom headers used for authentication. Essential for sites that " +
  "require login before their internal APIs are accessible. If a credential source is configured " +
  "(keychain, 1password), credentials are auto-looked up. Captured auth is saved to auth.json.",
parameters: LOGIN_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
  const p = params as {
    loginUrl: string;
    service?: string;
    formFields?: Record<string, string>;
    submitSelector?: string;
    headers?: Record<string, string>;
    cookies?: Array<{ name: string; value: string; domain: string }>;
    captureUrls?: string[];
    autoFillFromProvider?: boolean;
    saveCredentials?: boolean;
  };

  const backend = deps.browserBackend ?? "openclaw";

  // Derive service name from URL if not provided
  let service = p.service;
  if (!service) {
    try {
      const host = new URL(p.loginUrl).hostname;
      service = host
        .replace(/^(www|api|app|auth|login)\./, "")
        .replace(/\.(com|io|org|net|dev|co|ai)$/, "")
        .replace(/\./g, "-");
    } catch {
      return { content: [{ type: "text", text: "Invalid login URL." }] };
    }
  }

  // ── Credential auto-lookup ──────────────────────────────────
  // If no formFields provided and credential provider is configured,
  // try to look up login credentials automatically.
  let resolvedFormFields = p.formFields;
  let credentialUsed: LoginCredential | null = null;
  const shouldAutoFill = p.autoFillFromProvider !== false && !p.formFields && credentialProvider;

  if (shouldAutoFill && credentialProvider) {
    try {
      const available = await credentialProvider.isAvailable();
      if (available) {
        const cred = await lookupCredentials(credentialProvider, p.loginUrl);
        if (cred) {
          resolvedFormFields = buildFormFields(cred);
          credentialUsed = cred;
          logger.info(`[unbrowse] Auto-filled credentials from ${cred.source}: ${cred.label}`);
        } else {
          logger.info(`[unbrowse] No credentials found in ${credentialProvider.name} for ${p.loginUrl}`);
        }
      } else {
        logger.info(`[unbrowse] Credential provider ${credentialProvider.name} not available`);
      }
    } catch (err) {
      logger.warn(`[unbrowse] Credential lookup failed: ${(err as Error).message}`);
    }
  }

  const credentials: LoginCredentials = {
    formFields: resolvedFormFields,
    submitSelector: p.submitSelector,
    headers: p.headers,
    cookies: p.cookies,
  };

  try {
    if (backend === "agent-browser") {
      const agentBrowserPkg = "@getfoundry/unbrowse-agent-browser";
      const mod: any = await import(agentBrowserPkg);
      const loginWithAgentBrowser: (opts: {
        loginUrl: string;
        formFields?: Record<string, string>;
        submitSelector?: string;
        captureUrls?: string[];
      }) => Promise<any> = mod.loginWithAgentBrowser;

      const cap = await loginWithAgentBrowser({
        loginUrl: p.loginUrl,
        formFields: credentials.formFields,
        submitSelector: credentials.submitSelector,
        captureUrls: p.captureUrls,
      });

      const { mkdirSync, writeFileSync } = await import("node:fs");
      const skillDir = join(defaultOutputDir, service);
      mkdirSync(join(skillDir, "scripts"), { recursive: true });

      const authPath = join(skillDir, "auth.json");
      writeFileSync(authPath, JSON.stringify({
        service,
        baseUrl: cap.baseUrl,
        authMethod: Object.keys(cap.cookies).length > 0 ? "cookie" : "Unknown",
        timestamp: new Date().toISOString(),
        headers: {},
        cookies: cap.cookies,
        localStorage: cap.localStorage,
        sessionStorage: cap.sessionStorage,
        metaTokens: {},
        csrfProvenance: inferCsrfProvenance({
          authHeaders: {},
          cookies: cap.cookies,
          localStorage: cap.localStorage,
          sessionStorage: cap.sessionStorage,
          metaTokens: {},
        }),
      }, null, 2), "utf-8");

      // Optionally generate a skill if we captured enough traffic.
      if (cap.requestCount > 5) {
        try {
          const apiData = parseHar(cap.har, p.loginUrl);
          for (const [name, value] of (Object.entries(cap.cookies ?? {}) as Array<[string, string]>)) {
            if (!apiData.cookies[name]) apiData.cookies[name] = String(value);
          }
          const skillResult = await generateSkill(apiData, defaultOutputDir);
          discovery.markLearned(service);
          detectAndSaveRefreshConfig(cap.har.log?.entries ?? [], join(skillResult.skillDir, "auth.json"), logger);
        } catch {
          // Optional.
        }
      }

      // Store in vault (best-effort).
      if (p.saveCredentials !== false) {
        try {
          const { Vault } = await import("../../vault.js");
          const vault = new Vault(vaultDbPath);
          vault.store(service, {
            baseUrl: cap.baseUrl,
            authMethod: Object.keys(cap.cookies).length > 0 ? "cookie" : "unknown",
            headers: {},
            cookies: cap.cookies,
            extra: { ...cap.localStorage, ...cap.sessionStorage },
            notes: `Captured via agent-browser at ${new Date().toISOString()}`,
          });
          vault.close();
        } catch { /* ignore */ }
      }

      const summary = [
        `Session captured via agent-browser`,
        `Service: ${service}`,
        `Cookies: ${Object.keys(cap.cookies).length}`,
        `Requests: ${cap.requestCount}`,
        `Installed: ${skillDir}`,
      ];

      return { content: [{ type: "text", text: summary.join("\n") }] };
    }

    let backendLabel = "OpenClaw browser";
    let result: any;

    if (backend === "playwright") {
      backendLabel = "Playwright";
      if (!getOrCreateBrowserSession) {
        return {
          content: [{
            type: "text",
            text: `Playwright backend unavailable in this runtime (missing browser session manager).`,
          }],
        };
      }

      const cookieSeed: Record<string, string> = {};
      for (const c of (credentials.cookies ?? [])) {
        if (c?.name && typeof c.value === "string") cookieSeed[c.name] = c.value;
      }
      const headerSeed: Record<string, string> = {};
      for (const [k, v] of Object.entries(credentials.headers ?? {})) {
        if (typeof v === "string") headerSeed[String(k).toLowerCase()] = v;
      }

      const session = await getOrCreateBrowserSession(service, p.loginUrl, cookieSeed, headerSeed);
      const page = session.page;
      const context = session.context;

      // Capture XHR/fetch as HAR-like entries for skill generation.
      const harEntries: any[] = [];
      const captureTypes = new Set(["xhr", "fetch"]);
      const onResponse = async (resp: any) => {
        try {
          const req = resp.request?.();
          const rt = req?.resourceType?.();
          if (!rt || !captureTypes.has(rt)) return;

          const url = req.url();
          const method = req.method();

          const reqHeaders = Object.entries(req.headers() ?? {}).map(([name, value]) => ({
            name,
            value: String(value),
          }));
          const respHeaders = Object.entries(resp.headers() ?? {}).map(([name, value]) => ({
            name,
            value: String(value),
          }));

          const queryString: Array<{ name: string; value: string }> = [];
          try {
            const u = new URL(url);
            u.searchParams.forEach((value, name) => queryString.push({ name, value }));
          } catch { /* ignore */ }

          let postData: { mimeType: string; text: string } | undefined;
          if (method !== "GET" && method !== "HEAD") {
            try {
              const pd = req.postData?.();
              if (pd) {
                const ct = (req.headers?.() ?? {})["content-type"] ?? "application/octet-stream";
                postData = { mimeType: String(ct), text: String(pd) };
              }
            } catch { /* ignore */ }
          }

          let responseText: string | undefined;
          try {
            const ct = resp.headers?.()["content-type"] ?? "";
            if (String(ct).includes("json") || String(ct).includes("text") || String(ct).includes("xml")) {
              const body = await resp.text().catch(() => "");
              if (body && body.length < 50_000) responseText = body;
            }
          } catch { /* ignore */ }

          const cookies = Object.entries(cookieSeed).map(([name, value]) => ({ name, value }));

          harEntries.push({
            request: { method, url, headers: reqHeaders, cookies, queryString, postData },
            response: {
              status: resp.status?.() ?? 0,
              statusText: resp.statusText?.() ?? "",
              headers: respHeaders,
              content: {
                mimeType: resp.headers?.()["content-type"] ?? "",
                text: responseText,
              },
            },
          });
        } catch { /* never block */ }
      };

      page.on("response", onResponse);

      const waitMs = 5000;
      await page.goto(p.loginUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);

      if (credentials.formFields && Object.keys(credentials.formFields).length > 0) {
        for (const [selector, value] of Object.entries(credentials.formFields)) {
          await page.fill(selector, value);
          await page.waitForTimeout(200);
        }

        if (credentials.submitSelector) {
          await page.click(credentials.submitSelector);
        } else {
          // Best-effort defaults
          await page.click('button[type="submit"]').catch(() => {});
          await page.click('input[type="submit"]').catch(() => {});
          await page.keyboard.press("Enter").catch(() => {});
        }
      }

      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);

      for (const url of (p.captureUrls ?? [])) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(waitMs);
      }

      await page.waitForTimeout(800);
      page.off("response", onResponse);

      const baseUrl = new URL(p.loginUrl).origin;
      const host = new URL(p.loginUrl).hostname;
      const allCookies = await context.cookies().catch(() => [] as any[]);

      const cookies: Record<string, string> = {};
      const domainMatches = (cookieDomain: string, hostname: string) => {
        const d = String(cookieDomain || "").replace(/^\./, "");
        if (!d) return false;
        return hostname === d || hostname.endsWith(`.${d}`);
      };
      for (const c of allCookies as any[]) {
        if (!c?.name || typeof c.value !== "string") continue;
        if (domainMatches(String(c.domain ?? ""), host)) cookies[String(c.name)] = c.value;
      }

      const storage = await page.evaluate(() => {
        const authKeywords = /token|auth|session|jwt|access|refresh|csrf|xsrf|key|cred|user|login|bearer/i;
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
        const metaTokens: Record<string, string> = {};
        for (const el of Array.from(document.querySelectorAll("meta[name], meta[property]"))) {
          const name = (el.getAttribute("name") || el.getAttribute("property") || "").trim();
          const content = (el.getAttribute("content") || "").trim();
          if (!name || !content) continue;
          const ln = name.toLowerCase();
          if (ln.includes("csrf") || ln.includes("xsrf")) metaTokens[name] = content;
        }
        return { localStorage: ls, sessionStorage: ss, metaTokens };
      });

      // Minimal auth header inference (JWT + CSRF).
      const authHeaders: Record<string, string> = {};
      for (const val of [...Object.values(storage.localStorage ?? {}), ...Object.values(storage.sessionStorage ?? {})]) {
        if (typeof val === "string" && val.startsWith("eyJ")) {
          authHeaders["authorization"] = `Bearer ${val}`;
          break;
        }
        if (typeof val === "string" && /^Bearer\s/i.test(val)) {
          authHeaders["authorization"] = val;
          break;
        }
      }
      for (const [k, v] of Object.entries(storage.metaTokens ?? {})) {
        const lk = k.toLowerCase();
        if ((lk.includes("csrf") || lk.includes("xsrf")) && typeof v === "string") {
          authHeaders["x-csrf-token"] = v;
          break;
        }
      }

      result = {
        cookies,
        authHeaders,
        baseUrl,
        requestCount: harEntries.length,
        har: { log: { entries: harEntries } },
        localStorage: storage.localStorage ?? {},
        sessionStorage: storage.sessionStorage ?? {},
        metaTokens: storage.metaTokens ?? {},
      };
    } else {
      result = await loginAndCapture(p.loginUrl, credentials, {
        captureUrls: p.captureUrls,
        waitMs: 5000,
        browserPort,
      });
    }

    // Save auth.json
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const skillDir = join(defaultOutputDir, service);
    mkdirSync(join(skillDir, "scripts"), { recursive: true });

    const authData: Record<string, unknown> = {
      service,
      baseUrl: result.baseUrl,
      authMethod: Object.keys(result.authHeaders).length > 0 ? "header" : "cookie",
      timestamp: new Date().toISOString(),
      headers: result.authHeaders,
      cookies: result.cookies,
      // Client-side auth state (SPAs store JWTs in storage, CSRF in meta tags)
      localStorage: result.localStorage,
      sessionStorage: result.sessionStorage,
      metaTokens: result.metaTokens,
      csrfProvenance: inferCsrfProvenance({
        authHeaders: result.authHeaders,
        cookies: result.cookies,
        localStorage: result.localStorage,
        sessionStorage: result.sessionStorage,
        metaTokens: result.metaTokens,
      }),
    };

    // Store login config so replay can re-login when creds expire
    if (p.formFields || p.headers || p.cookies) {
      authData.loginConfig = {
        loginUrl: p.loginUrl,
        ...(p.formFields ? { formFields: p.formFields } : {}),
        ...(p.submitSelector ? { submitSelector: p.submitSelector } : {}),
        ...(p.headers ? { headers: p.headers } : {}),
        ...(p.cookies ? { cookies: p.cookies } : {}),
        ...(p.captureUrls ? { captureUrls: p.captureUrls } : {}),
      };
    }
    writeFileSync(join(skillDir, "auth.json"), JSON.stringify(authData, null, 2), "utf-8");

    // If we captured enough API traffic, generate a skill too
    let skillGenerated = false;
    let skillChanged = false;
    if (result.requestCount > 5) {
      try {
        const apiData = parseHar(result.har, p.loginUrl);
        // Merge captured cookies into apiData
        for (const [name, value] of Object.entries(result.cookies)) {
          if (!apiData.cookies[name]) apiData.cookies[name] = String(value);
        }
        const skillResult = await generateSkill(apiData, defaultOutputDir);
        discovery.markLearned(service);
        skillGenerated = true;
        skillChanged = Boolean(skillResult.changed);

        // Detect and save refresh token config
        detectAndSaveRefreshConfig(result.har.log?.entries ?? [], join(skillDir, "auth.json"), logger);
      } catch {
        // Skill generation is optional — session capture is the main goal
      }
    }

    // Save credentials to vault if requested and provider supports it
    if (credentialUsed && p.saveCredentials !== false && credentialProvider?.name === "vault" && credentialProvider.store) {
      try {
        const hostname = new URL(p.loginUrl).hostname;
        await credentialProvider.store(hostname, credentialUsed.username, credentialUsed.password);
        logger.info(`[unbrowse] Saved login credentials to vault for ${hostname}`);
      } catch {
        // Non-critical — skip
      }
    }

    const cookieCount = Object.keys(result.cookies).length;
    const authHeaderCount = Object.keys(result.authHeaders).length;
    const lsCount = Object.keys(result.localStorage).length;
    const ssCount = Object.keys(result.sessionStorage).length;
    const metaCount = Object.keys(result.metaTokens).length;
    const hasAnyAuth = cookieCount > 0 || authHeaderCount > 0 || lsCount > 0 || ssCount > 0;

    // Also store the captured session auth in the vault (independent of credential provider)
    // This stores cookies/headers/tokens for API replay even without login credentials
    if (p.saveCredentials !== false && hasAnyAuth) {
      try {
        const { Vault } = await import("../../vault.js");
        const vault = new Vault(vaultDbPath);
        vault.store(service, {
          baseUrl: result.baseUrl,
          authMethod: authHeaderCount > 0 ? "header" : "cookie",
          headers: result.authHeaders,
          cookies: result.cookies,
          extra: {
            ...result.localStorage,
            ...result.sessionStorage,
            ...result.metaTokens,
          },
          notes: `Captured via unbrowse_login at ${new Date().toISOString()}`,
        });
        vault.close();
        logger.info(`[unbrowse] Stored session auth in vault for ${service}`);
      } catch (vaultErr) {
        // Vault may not be initialized — non-critical
        logger.warn(`[unbrowse] Could not store in vault: ${(vaultErr as Error).message}`);
      }
    }
    const hasPayerKey = Boolean(deps.walletState?.solanaPrivateKey);
    const payerKeyValid = hasPayerKey
      ? await isPayerPrivateKeyValid(deps.walletState?.solanaPrivateKey)
      : false;

    const summary = [
	      `Session captured via ${backendLabel}`,
      `Service: ${service}`,
      credentialUsed ? `Credentials: auto-filled from ${credentialUsed.source} (${credentialUsed.label})` : "",
      `Cookies: ${cookieCount}`,
      `Auth headers: ${authHeaderCount}`,
      lsCount > 0 ? `localStorage tokens: ${lsCount} (${Object.keys(result.localStorage).join(", ")})` : "",
      ssCount > 0 ? `sessionStorage tokens: ${ssCount}` : "",
      metaCount > 0 ? `Meta tokens: ${metaCount} (${Object.keys(result.metaTokens).join(", ")})` : "",
      `Network requests: ${result.requestCount}`,
      `Base URL: ${result.baseUrl}`,
      `Auth saved: ${join(skillDir, "auth.json")}`,
      skillGenerated ? `Skill generated with ${result.requestCount} captured requests` : "",
      skillGenerated && skillChanged
        ? buildPublishPromptLines({
          service,
          skillsDir: defaultOutputDir,
          hasCreatorWallet: Boolean(deps.walletState?.creatorWallet),
          hasPayerKey,
          payerKeyValid,
        }).join("\n")
        : "",
      !hasAnyAuth ? `WARNING: No auth state captured (0 cookies, 0 headers, 0 tokens). Login may have failed — check form selectors or try different selectors.` : "",
      "",
      hasAnyAuth
        ? `The session is ready. Use unbrowse_replay to execute API calls with these credentials.`
        : `No credentials captured. Try re-running with correct form field selectors, or use unbrowse_capture after manually logging in via the browser.`,
      !skillGenerated && (p.captureUrls?.length ?? 0) === 0
        ? `Tip: add captureUrls to visit authenticated pages and auto-generate a skill.`
        : "",
      !credentialUsed && !p.formFields && credentialProvider == null
        ? `Tip: set credentialSource in config to "keychain" or "1password" for auto-login next time.`
        : "",
    ].filter(Boolean).join("\n");

    logger.info(`[unbrowse] Login capture → ${service} (${Object.keys(result.cookies).length} cookies, ${result.requestCount} requests)`);
    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "PLAYWRIGHT_MISSING" || msg.includes("playwright-core")) {
      return {
        content: [
          {
            type: "text",
            text:
              `Browser runtime unavailable: ${msg}\n\n` +
              `Fix:\n` +
              `- Ensure the plugin installed its dependencies (inside ~/.openclaw/extensions/unbrowse-openclaw: npm install)\n` +
              `- Or set plugin config playwright.executablePath to a local Chrome/Chromium binary`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: `Login capture failed: ${msg}` }] };
  }
},
};
}
