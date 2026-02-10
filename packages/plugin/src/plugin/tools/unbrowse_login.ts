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

export function makeUnbrowseLoginTool(deps: ToolDeps) {
  const {
    logger,
    browserPort,
    defaultOutputDir,
    vaultDbPath,
    credentialProvider,
    autoPublishSkill,
    detectAndSaveRefreshConfig,
    discovery,
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
    const result = await loginAndCapture(p.loginUrl, credentials, {
      captureUrls: p.captureUrls,
      waitMs: 5000,
      browserPort,
    });

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
    if (result.requestCount > 5) {
      try {
        const apiData = parseHar(result.har, p.loginUrl);
        // Merge captured cookies into apiData
        for (const [name, value] of Object.entries(result.cookies)) {
          if (!apiData.cookies[name]) apiData.cookies[name] = value;
        }
        await generateSkill(apiData, defaultOutputDir);
        discovery.markLearned(service);
        skillGenerated = true;

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

    const backend = "OpenClaw browser";
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
    const summary = [
      `Session captured via ${backend}`,
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
    if (msg.includes("playwright")) {
      return { content: [{ type: "text", text: `Playwright not available: ${msg}. Install with: bun add playwright` }] };
    }
    return { content: [{ type: "text", text: `Login capture failed: ${msg}` }] };
  }
},
};
}
